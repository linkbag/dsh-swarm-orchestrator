import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'
import type { EvidenceShell } from '../src/authority.js'
import type { SwarmService } from '../src/service.js'
import type { TaskSpec } from '../src/domain/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
interface Result { stopReason: string; output: Array<{ type: string; text: string }>; diagnostic?: string }
const success = (text = 'finished'): Result => ({ stopReason: 'completed', output: [{ type: 'text', text }] })
const failure = (reason = 'deterministic failure'): Result => ({ stopReason: 'error', diagnostic: reason, output: [{ type: 'text', text: 'nonempty failure output' }] })
type Gate = ReturnType<typeof deferred<void>>
type Request = Parameters<EvidenceShell['resolve']>[0]
type ShellHandle = Awaited<ReturnType<EvidenceShell['execute']>>
type ShellResult = Awaited<ReturnType<ShellHandle['result']>>
interface ChildOptions { prompt: Array<{ text: string }>; signal: AbortSignal; agentOptions?: { reasoningEffort?: string } }
interface ChildPlan { publication?: Gate; disposal?: Gate }
interface ChildCall { id: string; options: ChildOptions; dispose: ReturnType<typeof vi.fn>; finish: (result?: Result) => void; published: boolean }
interface ShellPlan { result: ReturnType<typeof deferred<ShellResult>>; done: Gate }
interface Probe {
  holders: Set<{ done?: Promise<void> }>
  pauseRun: (runId: string, cause: string) => void
  flushHumanWaiting: (runId: string) => void
  humanWaitPinged: Map<string, number>
}
const fixtures: Array<{ ctx: Context; root: string; service: SwarmService; release: Array<() => void> }> = []
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

async function rig(config: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-lifecycle-owned-')))
  const ctx = new Context()
  const policy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }), overrideOf: () => 'workspace-write' }
  const parentFor = (id = 'owner') => ({ id, ctx: { get: (name: string) => name === 'sandboxPolicy' ? policy : name === 'approval' ? {} : undefined }, session: { header: { id, cwd: root, delegationDepth: 0 } }, options: { provider: 'fake', model: 'model' } })
  const release: Array<() => void> = []
  const calls: ChildCall[] = []
  const plans: ChildPlan[] = []
  const shells: Array<{ request: Request; kill: ReturnType<typeof vi.fn> }> = []
  const shellPlans: ShellPlan[] = []
  const owners = new Map<string, { followup: ReturnType<typeof vi.fn> }>()
  const subagents = {
    capabilities: { start: { toolFilter: true, maxDepth: true, agentOptions: true } },
    start: async (_prompt: unknown, options: ChildOptions) => {
      const plan = plans.shift() ?? {}
      const result = deferred<Result>()
      const call: ChildCall = { id: `life-child-${calls.length}`, options, published: false, finish: (value = success()) => result.resolve(value), dispose: vi.fn(async () => { await plan.disposal?.promise }) }
      calls.push(call)
      release.push(() => { plan.publication?.resolve(); plan.disposal?.resolve(); call.finish() })
      await plan.publication?.promise
      call.published = true
      return { id: call.id, localAgent: { id: call.id }, result: result.promise, dispose: call.dispose }
    },
  }
  const shell: EvidenceShell = {
    sandboxMode: 'workspace-write', resolve: (request) => request,
    execute: async (spec: never) => {
      const request = spec as Request
      const plan = shellPlans.shift()
      const kill = vi.fn(() => true)
      shells.push({ request, kill })
      const result: ShellResult = { exitCode: 0, timedOut: false, aborted: false, stdout: { text: 'verified' }, stderr: { text: '' }, sandbox: { mode: request.sandboxPolicy.mode, denied: false } }
      if (plan !== undefined) release.push(() => { plan.result.resolve(result); plan.done.resolve() })
      return { kill, result: () => plan?.result.promise ?? Promise.resolve(result), done: plan?.done.promise ?? Promise.resolve() }
    },
  }
  ctx.reflect.provide('sandboxPolicy', policy as never)
  ctx.reflect.provide('subagents', subagents as never)
  ctx.reflect.provide('shell', shell as never)
  ctx.reflect.provide('tools', { restrictableNames: new Set(['read', 'write', 'pwsh']) } as never)
  ctx.reflect.provide('agents', {
    create: async (request: { setup?: (context: { get: (name: string) => unknown }, anchor: unknown) => Promise<void> }) => {
      const agent = { id: 'anchor', session: { header: { id: 'anchor', cwd: root, delegationDepth: 0 }, append: () => {} } }
      await request.setup?.({ get: () => undefined }, agent)
      return { agent, dispose: async () => {} }
    },
    get: (id: string) => owners.get(id),
  } as never)
  await ctx.plugin(plugin, {
    storageDir: root, reportDir: join(root, 'reports'), maxConcurrent: 2, maxTotalConcurrentAgents: 2,
    maxRetries: 0, reviewLoops: 1, requireManualEndorsement: true, requireArchitectReview: false,
    spawnStaggerMs: 0, retryBackoffBaseMs: 0, bootGraceSeconds: 3, circuitBreakerThreshold: 0,
    notifyDispatchSession: false, ...config,
  })
  const service = (ctx.get('swarm') as unknown as Record<symbol, SwarmService>)[Symbol.for('cordis.original')]
  const probe = service as unknown as Probe
  fixtures.push({ ctx, root, service, release })
  await flush()
  return {
    ctx, root, service, probe, calls, plans, shells, shellPlans, owners, parentFor,
    dispatch: (tasks: TaskSpec[], owner = 'owner') => { const result = service.dispatch({ title: 'lifecycle regression', spec: 's', tasks }, parentFor(owner) as never); service.endorse(result.runId); return result.runId },
  }
}
const task = (extra: Partial<TaskSpec> = {}): TaskSpec => ({ id: 'a', subject: 'A', description: 'd', role: 'builder', ...extra })
const findTask = (r: Awaited<ReturnType<typeof rig>>, runId: string, id = 'a') => r.service.snapshot().tasks.find((item) => item.runId === runId && item.id === id)!
const failedEvidence = (): ShellResult => ({ exitCode: 1, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: 'late failed evidence' }, sandbox: { mode: 'workspace-write', denied: false } })

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T00:00:00Z')) })
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const unblock of fixture.release) unblock()
    fixture.ctx.registry.delete(plugin)
    await flush()
    await Promise.allSettled([...(fixture.service as unknown as Probe).holders].map((flight) => flight.done))
    expect(realpathSync(fixture.root)).toBe(fixture.root)
    expect(fixture.root.startsWith(realpathSync(tmpdir()) + sep)).toBe(true)
    rmSync(fixture.root, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('attempt authority after asynchronous work', () => {
  it('external acceptance aborts evidence but retains capacity until process close; late failure cannot undo acceptance', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const evidence = { result: deferred<ShellResult>(), done: deferred<void>() }
    r.shellPlans.push(evidence)
    const runId = r.dispatch([task({ evidence: { commands: ['fake verification'] } }), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    r.calls[0].finish()
    await flush()
    expect(r.shells).toHaveLength(1)
    expect(r.probe.holders.size).toBe(1)
    r.service.completeTaskExternally(runId, 'a', 'owner', 'accepted by the human')
    await flush()
    expect(r.shells[0].request.signal.aborted).toBe(true)
    expect(r.shells[0].kill).toHaveBeenCalledTimes(1)
    expect(findTask(r, runId).summary).toBe('accepted by the human')
    await vi.advanceTimersByTimeAsync(10000)
    expect(r.calls).toHaveLength(1)
    evidence.result.resolve(failedEvidence())
    await flush()
    expect(r.probe.holders.size).toBe(1)
    expect(r.calls).toHaveLength(1)
    evidence.done.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    expect(r.shells).toHaveLength(1)
    r.calls[1].finish()
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
    expect(findTask(r, runId).summary).toBe('accepted by the human')
    expect(findTask(r, runId).humanReview).not.toBe(true)
    expect(r.service.events.all().filter((event) => event.kind === 'task/blocked' && event.taskId === 'a')).toHaveLength(0)
    expect(r.probe.holders.size).toBe(0)
  })

  it('interrupt during evidence waits for owned cleanup and ignores a late failing gate', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const evidence = { result: deferred<ShellResult>(), done: deferred<void>() }
    r.shellPlans.push(evidence)
    const runId = r.dispatch([task({ evidence: { commands: ['fake verification'] } })])
    await flush()
    const oldAttempt = findTask(r, runId).attemptId
    r.calls[0].finish()
    await flush()
    r.service.interruptTask(runId, 'a', 'owner')
    await flush()
    expect(findTask(r, runId).status).toBe('retrying')
    expect(r.calls).toHaveLength(1)
    evidence.result.resolve(failedEvidence())
    await flush()
    expect(r.calls).toHaveLength(1)
    evidence.done.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    expect(findTask(r, runId).attemptId).not.toBe(oldAttempt)
    expect(findTask(r, runId).status).toBe('running')
    expect(r.shells).toHaveLength(1)
    expect(r.service.events.all().filter((event) => event.kind === 'task/blocked' && event.taskId === 'a')).toHaveLength(0)
    r.calls[1].finish()
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
  })

  it('operator acceptance fences a late reviewer verdict and keeps review statistics unchanged', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const disposal = deferred<void>()
    r.plans.push({}, { disposal })
    const runId = r.dispatch([task({ reviewBy: 'reviewer' })])
    await flush()
    r.calls[0].finish()
    await flush()
    expect(r.calls).toHaveLength(2)
    expect(findTask(r, runId).status).toBe('reviewing')
    r.service.completeTaskExternally(runId, 'a', 'owner', 'operator accepted reviewed work')
    await flush()
    const accepted = structuredClone(findTask(r, runId))
    const stats = structuredClone(r.service.snapshot().runs.find((run) => run.id === runId)!.stats)
    expect(r.calls[1].dispose).toHaveBeenCalledTimes(1)
    expect(r.probe.holders.size).toBe(1)
    r.calls[1].finish(success('VERDICT: REJECT'))
    disposal.resolve()
    await flush()
    expect(findTask(r, runId)).toEqual(accepted)
    expect(r.service.snapshot().runs.find((run) => run.id === runId)!.stats).toEqual(stats)
    expect(r.service.events.all().filter((event) => event.kind === 'task/reviewed')).toHaveLength(0)
    expect(r.probe.holders.size).toBe(0)
  })

  it('pause and resume reject an obsolete verdict and launch only after reviewer disposal', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const disposal = deferred<void>()
    r.plans.push({}, { disposal })
    const runId = r.dispatch([task({ reviewBy: 'reviewer' })])
    await flush()
    r.calls[0].finish()
    await flush()
    const attempt = findTask(r, runId).attemptId
    r.probe.pauseRun(runId, 'replace paused review')
    r.service.resumeRun(runId)
    await flush()
    expect(findTask(r, runId).status).toBe('retrying')
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish(success('VERDICT: REJECT'))
    disposal.resolve()
    await flush()
    expect(r.calls).toHaveLength(3)
    expect(findTask(r, runId).attemptId).not.toBe(attempt)
    expect(findTask(r, runId).reviewed).not.toBe(true)
    expect(r.service.events.all().filter((event) => event.kind === 'task/reviewed')).toHaveLength(0)
    r.calls[2].finish()
    await flush()
    r.calls[3].finish(success('VERDICT: APPROVE'))
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === runId)!.stats?.reviewsPassed).toBe(1)
    expect(r.service.snapshot().runs.find((run) => run.id === runId)!.stats?.reviewsRejected).toBe(0)
  })
})

describe('quiescent resource ownership', () => {
  it('cancel before publication still disposes the late handle exactly once and blocks replacement until disposal settles', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const publication = deferred<void>()
    const disposal = deferred<void>()
    r.plans.push({ publication, disposal })
    const runId = r.dispatch([task(), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    expect(r.calls[0].published).toBe(false)
    r.service.completeTaskExternally(runId, 'a', 'owner', 'accepted before publish')
    await flush()
    expect(r.calls).toHaveLength(1)
    expect(r.probe.holders.size).toBe(1)
    publication.resolve()
    await flush()
    expect(r.calls[0].dispose).toHaveBeenCalledTimes(1)
    expect(r.calls).toHaveLength(1)
    expect(r.probe.holders.size).toBe(1)
    disposal.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[0].finish(failure('obsolete result'))
    r.calls[1].finish()
    await flush()
    expect(r.calls[0].dispose).toHaveBeenCalledTimes(1)
    expect(findTask(r, runId).summary).toBe('accepted before publish')
    expect(r.probe.holders.size).toBe(0)
  })

  it('natural completion holds the execution slot until provider disposal finishes', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const disposal = deferred<void>()
    r.plans.push({ disposal })
    const runId = r.dispatch([task(), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    r.calls[0].finish()
    await flush()
    expect(r.calls[0].dispose).toHaveBeenCalledTimes(1)
    expect(findTask(r, runId).status).toBe('running')
    expect(r.calls).toHaveLength(1)
    expect(r.probe.holders.size).toBe(1)
    disposal.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish()
    await flush()
    expect(r.probe.holders.size).toBe(0)
  })

  it('reserves staggered launches against global capacity and aborts an unpublished reservation', async () => {
    const r = await rig({ spawnStaggerMs: 100, maxConcurrent: 2, maxTotalConcurrentAgents: 2 })
    const runId = r.dispatch([task(), task({ id: 'b' }), task({ id: 'c' })])
    await flush()
    expect(r.calls).toHaveLength(1)
    expect(r.probe.holders.size).toBe(2)
    r.service.abort(runId)
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].dispose).toHaveBeenCalledTimes(1)
    expect(r.probe.holders.size).toBe(0)
  })

  it('a retired effort-rung child loses reporting authority while its replacement can report', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const table = structuredClone(r.service.duty.get())
    table.roles.builder.reasoningEffort = 'max'
    table.roles.builder.effortFallbacks = ['low']
    r.service.setDutyTable(table, 'test')
    const runId = r.dispatch([task()])
    await flush()
    r.calls[0].finish(failure('UNSUPPORTED_REASONING_EFFORT'))
    await flush()
    expect(r.calls).toHaveLength(2)
    expect(r.calls[0].dispose).toHaveBeenCalledTimes(1)
    expect(() => r.service.report(r.calls[0].id, 'a', 'obsolete heartbeat')).toThrow(/not a tracked swarm task agent/)
    expect(r.service.report(r.calls[1].id, 'a', 'live replacement heartbeat')).toBe('ok')
    expect(findTask(r, runId).lastNote).toBe('live replacement heartbeat')
    r.calls[1].finish()
    await flush()
    expect(r.probe.holders.size).toBe(0)
  })

  it('plugin teardown aborts all owned children and awaits their disposal boundary', async () => {
    const r = await rig()
    const disposal = deferred<void>()
    r.plans.push({ disposal }, {})
    r.dispatch([task(), task({ id: 'b' })])
    await flush()
    r.ctx.registry.delete(plugin)
    await flush()
    expect(r.calls.every((call) => call.options.signal.aborted)).toBe(true)
    expect(r.calls.every((call) => call.dispose.mock.calls.length === 1)).toBe(true)
    expect(r.probe.holders.size).toBe(1)
    disposal.resolve()
    await flush()
    expect(r.probe.holders.size).toBe(0)
    expect(r.calls).toHaveLength(2)
  })
})

describe('retry wakeups and pause cleanup', () => {
  it('manual retry with nonzero backoff launches on its deadline without a new event', async () => {
    const r = await rig({ retryBackoffBaseMs: 100, maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const runId = r.dispatch([task()])
    await flush()
    r.calls[0].finish(failure())
    await flush()
    expect(findTask(r, runId).status).toBe('failed')
    r.service.retryTask(runId, 'a', 'owner')
    await flush()
    expect(findTask(r, runId).status).toBe('retrying')
    const seq = r.service.events.all().length
    await vi.advanceTimersByTimeAsync(99)
    expect(r.calls).toHaveLength(1)
    expect(r.service.events.all()).toHaveLength(seq)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.calls).toHaveLength(2)
    expect(findTask(r, runId).status).toBe('running')
    r.calls[1].finish()
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
  })

  it('an elapsed retry deadline cannot release capacity before the cancelled child quiesces', async () => {
    const r = await rig({ retryBackoffBaseMs: 100, maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const disposal = deferred<void>()
    r.plans.push({ disposal })
    const runId = r.dispatch([task()])
    await flush()
    r.service.interruptTask(runId, 'a', 'owner')
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.calls).toHaveLength(1)
    expect(r.probe.holders.size).toBe(1)
    disposal.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish()
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
  })

  it('pause records cancelled siblings as retryable and immediate resume waits for their cleanup', async () => {
    const r = await rig()
    const first = deferred<void>()
    const second = deferred<void>()
    r.plans.push({ disposal: first }, { disposal: second })
    const runId = r.dispatch([task(), task({ id: 'b' })])
    await flush()
    r.probe.pauseRun(runId, 'test pause')
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('paused')
    expect(r.service.snapshot().tasks.filter((item) => item.runId === runId).map((item) => item.status)).toEqual(['retrying', 'retrying'])
    r.service.resumeRun(runId)
    await flush()
    expect(r.calls).toHaveLength(2)
    expect(r.probe.holders.size).toBe(2)
    first.resolve()
    second.resolve()
    await flush()
    expect(r.calls).toHaveLength(4)
    expect(r.calls[0].dispose).toHaveBeenCalledTimes(1)
    expect(r.calls[1].dispose).toHaveBeenCalledTimes(1)
    r.calls[2].finish()
    r.calls[3].finish()
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('completed')
    expect(r.probe.holders.size).toBe(0)
  })
})

describe('owner-scoped attention delivery', () => {
  it('isolates owners and acknowledges only episodes actually delivered', async () => {
    const r = await rig({ notifyDispatchSession: true })
    const followupA = vi.fn(() => {})
    let failB = true
    const followupB = vi.fn(() => { if (failB) throw new Error('offline inbox') })
    r.owners.set('owner-a', { followup: followupA })
    r.owners.set('owner-b', { followup: followupB })
    const a = r.dispatch([task({ reviewGate: 'human' })], 'owner-a')
    const b = r.dispatch([task({ reviewGate: 'human' })], 'owner-b')
    await flush()
    r.calls[0].finish()
    r.calls[1].finish()
    await flush()
    await vi.advanceTimersByTimeAsync(2600)
    expect(followupA).toHaveBeenCalledTimes(1)
    expect(followupB).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(followupA.mock.calls[0])).toContain(a)
    expect(JSON.stringify(followupA.mock.calls[0])).not.toContain(b)
    expect(JSON.stringify(followupB.mock.calls[0])).toContain(b)
    expect(JSON.stringify(followupB.mock.calls[0])).not.toContain(a)
    expect(r.probe.humanWaitPinged.size).toBe(1)
    failB = false
    r.probe.flushHumanWaiting(a)
    expect(followupA).toHaveBeenCalledTimes(1)
    expect(followupB).toHaveBeenCalledTimes(2)
    expect(r.probe.humanWaitPinged.size).toBe(2)
    r.probe.flushHumanWaiting(b)
    expect(followupB).toHaveBeenCalledTimes(2)
  })

  it('a missing recipient stays unacknowledged and receives the same episode after reconnect', async () => {
    const r = await rig({ notifyDispatchSession: true })
    const runId = r.dispatch([task({ reviewGate: 'human' })])
    await flush()
    r.calls[0].finish()
    await flush()
    await vi.advanceTimersByTimeAsync(2600)
    expect(r.probe.humanWaitPinged.size).toBe(0)
    const followup = vi.fn(() => {})
    r.owners.set('owner', { followup })
    r.probe.flushHumanWaiting(runId)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(r.probe.humanWaitPinged.size).toBe(1)
  })
})

describe('operator decisions while paused', () => {
  it('records human approval without resuming or launching a dependent sibling', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const runId = r.dispatch([task({ reviewGate: 'human' }), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    r.calls[0].finish()
    await flush()
    r.probe.pauseRun(runId, 'operator pause')
    expect(findTask(r, runId).humanReview).toBe(true)
    r.service.review(runId, 'a', 'approve')
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
    expect(findTask(r, runId).reviewed).toBe(true)
    expect(r.service.snapshot().runs.find((item) => item.id === runId)?.status).toBe('paused')
    expect(r.calls).toHaveLength(1)
    r.service.resumeRun(runId)
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish()
  })

  it('records external completion during pause without acknowledging an ignored event', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const runId = r.dispatch([task(), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    r.probe.pauseRun(runId, 'operator pause')
    r.service.completeTaskExternally(runId, 'a', 'owner', 'operator verified the result')
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
    expect(findTask(r, runId).summary).toBe('operator verified the result')
    expect(r.service.snapshot().runs.find((item) => item.id === runId)?.status).toBe('paused')
    expect(r.calls).toHaveLength(1)
    r.service.resumeRun(runId)
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish()
  })

  it('rejects a terminal owner review instead of returning false success', async () => {
    const r = await rig()
    const runId = r.dispatch([task({ reviewGate: 'human' })])
    await flush()
    r.calls[0].finish()
    await flush()
    r.service.abort(runId)
    expect(() => r.service.review(runId, 'a', 'approve')).toThrow(/inactive/)
    expect(findTask(r, runId).status).toBe('reviewing')
  })
})
