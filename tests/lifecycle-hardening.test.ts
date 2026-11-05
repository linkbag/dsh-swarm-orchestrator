import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'
import type { EvidenceShell } from '../src/authority.js'
import type { SwarmService } from '../src/service.js'
import type { TaskSpec } from '../src/domain/types.js'
import { DEFAULT_POLICY, type TaskPolicy } from '../src/policy.js'
import { fold, isReady } from '../src/domain/projection.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventStore } from '../src/domain/event-store.js'
import { RequestLedger } from '../src/request-ledger.js'
import { checkArtifacts } from '../src/artifacts.js'

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
  recoverOrphans: () => void
}
const fixtures: Array<{ ctx: Context; root: string; service: SwarmService; release: Array<() => void> }> = []
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

async function rig(config: Record<string, unknown> = {}, beforeApply?: (ctx: Context) => void) {
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
  beforeApply?.(ctx)
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
    dispatch: (tasks: TaskSpec[], owner = 'owner', policy?: TaskPolicy) => { const result = service.dispatch({ title: 'lifecycle regression', spec: 's', tasks, ...(policy !== undefined ? { policy } : {}) }, parentFor(owner) as never); service.endorse(result.runId); return result.runId },
  }
}
const task = (extra: Partial<TaskSpec> = {}): TaskSpec => ({ id: 'a', subject: 'A', description: 'd', role: 'builder', ...extra })
function observation(service: SwarmService, runId: string) {
  const task = service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
  return { attemptId: task.attemptId, status: task.status, attemptRevoked: task.attemptRevoked }
}
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
    r.service.completeTaskExternally(runId, 'a', 'owner', 'accepted by the human', observation(r.service, runId))
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
    r.service.interruptTask(runId, 'a', 'owner', observation(r.service, runId))
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
    r.service.completeTaskExternally(runId, 'a', 'owner', 'operator accepted reviewed work', observation(r.service, runId))
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
  it.each([2, 3])('retains same-task ownership with spare capacity %i until disposal settles', async (capacity) => {
    const r = await rig({ maxConcurrent: capacity, maxTotalConcurrentAgents: capacity })
    const disposal = deferred<void>()
    r.plans.push({ disposal })
    const runId = r.dispatch([task()])
    await flush()
    r.service.interruptTask(runId, 'a', 'owner', observation(r.service, runId))
    await flush()
    expect(findTask(r, runId).status).toBe('retrying')
    expect(r.probe.holders.size).toBe(1)
    expect(r.calls).toHaveLength(1)
    disposal.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish()
    await flush()
    expect(findTask(r, runId).status).toBe('completed')
  })

  it('does not publish a dependent or terminal result while its externally accepted writer drains', async () => {
    const r = await rig({ maxConcurrent: 3, maxTotalConcurrentAgents: 3 })
    const disposal = deferred<void>()
    r.plans.push({ disposal })
    const runId = r.dispatch([task(), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    r.service.completeTaskExternally(runId, 'a', 'owner', 'operator-supplied work', observation(r.service, runId))
    await flush()
    expect(r.calls).toHaveLength(1)
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('running')
    disposal.resolve()
    await flush()
    expect(r.calls).toHaveLength(2)
    r.calls[1].finish()
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('completed')
  })

  it('does not emit a completed run before the last externally accepted writer is quiescent', async () => {
    const r = await rig()
    const disposal = deferred<void>()
    r.plans.push({ disposal })
    const runId = r.dispatch([task()])
    await flush()
    r.service.completeTaskExternally(runId, 'a', 'owner', 'operator-supplied work', observation(r.service, runId))
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('running')
    expect(r.service.events.all().some((event) => event.runId === runId && event.kind === 'run/completed')).toBe(false)
    disposal.resolve()
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('completed')
  })

  it('restores one persisted review of the same attempt without rerunning build/evidence', async () => {
    const r = await rig()
    const runId = r.dispatch([task({ reviewBy: 'reviewer' })])
    const data = { attemptId: 'att-restored' }
    r.service.events.append('task/started', { runId, taskId: 'a', data: { ...data, attemptProtocol: 2 } })
    r.service.events.append('task/completed', { runId, taskId: 'a', data: { ...data, summary: 'already built', artifactDigest: checkArtifacts(undefined, r.root).digest, artifactState: 'valid', reviewPending: true } })
    r.service.events.append('task/review-started', { runId, taskId: 'a', data: { ...data, reviewer: 'reviewer' } })
    r.probe.recoverOrphans()
    r.probe.recoverOrphans()
    await flush()
    expect(r.calls).toHaveLength(1)
    expect(r.shells).toHaveLength(0)
    expect(findTask(r, runId).attemptId).toBe('att-restored')
    expect(findTask(r, runId).attempts).toBe(1)
    expect(r.service.events.all().filter((event) => event.kind === 'task/review-started')).toHaveLength(1)
    r.calls[0].finish(success('VERDICT: APPROVE'))
    await flush()
    expect(findTask(r, runId).reviewed).toBe(true)
  })

  it('cancel before publication still disposes the late handle exactly once and blocks replacement until disposal settles', async () => {
    const r = await rig({ maxConcurrent: 1, maxTotalConcurrentAgents: 1 })
    const publication = deferred<void>()
    const disposal = deferred<void>()
    r.plans.push({ publication, disposal })
    const runId = r.dispatch([task(), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    expect(r.calls[0].published).toBe(false)
    r.service.completeTaskExternally(runId, 'a', 'owner', 'accepted before publish', observation(r.service, runId))
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
    r.service.retryTask(runId, 'a', 'owner', observation(r.service, runId))
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
    r.service.interruptTask(runId, 'a', 'owner', observation(r.service, runId))
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

describe('versioned acceptance and observed decisions', () => {
  it('holds required missing artifacts without releasing dependents or failing the entire run', async () => {
    const r = await rig()
    const id = r.dispatch([task({ evidence: { files: ['missing.json'] } }), task({ id: 'after', blockedBy: ['a'] })], 'owner', { ...DEFAULT_POLICY, evidence: 'required' })
    await flush(); r.calls[0].finish(); await flush()
    expect(findTask(r, id)).toMatchObject({ executionState: 'succeeded', artifactState: 'invalid', acceptanceState: 'held', humanReview: true })
    expect(r.calls).toHaveLength(1)
    expect(r.service.snapshot().runs.find((run) => run.id === id)?.status).toBe('running')
    expect(() => r.service.completeTaskExternally(id, 'a', 'owner', 'bypass')).toThrow(/cannot be bypassed/)
  })

  it('keeps advisory warnings separate from accepted execution', async () => {
    const r = await rig()
    const id = r.dispatch([task({ evidence: { files: ['missing.json'] } })])
    await flush(); r.calls[0].finish(); await flush()
    expect(findTask(r, id)).toMatchObject({ executionState: 'succeeded', artifactState: 'invalid', acceptanceState: 'accepted', provenance: 'model' })
    expect(findTask(r, id).fileWarnings?.join(' ')).toContain('missing.json')
  })

  it('strict unavailable review holds for a human rather than accepting or terminal-failing', async () => {
    const r = await rig()
    const id = r.dispatch([task({ reviewBy: 'missing-reviewer' }), task({ id: 'after', blockedBy: ['a'] })], 'owner', { ...DEFAULT_POLICY, review: 'strict' })
    await flush(); r.calls[0].finish(); await flush()
    expect(findTask(r, id)).toMatchObject({ status: 'reviewing', acceptanceState: 'held', humanReview: true })
    expect(r.calls).toHaveLength(1)
    expect(r.service.snapshot().runs.find((run) => run.id === id)?.status).toBe('running')
  })

  it('off policy skips agent/human review gates explicitly', async () => {
    const r = await rig()
    const id = r.dispatch([task({ reviewBy: 'missing-reviewer', reviewGate: 'human' })], 'owner', { ...DEFAULT_POLICY, review: 'off' })
    await flush(); r.calls[0].finish(); await flush()
    expect(findTask(r, id)).toMatchObject({ status: 'completed', acceptanceState: 'accepted' })
    expect(r.service.snapshot().runs.find((run) => run.id === id)?.status).toBe('completed')
    expect(r.calls).toHaveLength(1)
  })

  it('requires the observed attempt/episode/digest and refuses mutated artifacts', async () => {
    const r = await rig()
    writeFileSync(join(r.root, 'proof.json'), '{"version":1,"value":1}')
    const id = r.dispatch([task({ reviewGate: 'human', evidence: { artifacts: [{ path: 'proof.json', format: 'json', schemaVersion: 1, requiredKeys: ['value'] }] } })])
    await flush(); r.calls[0].finish(); await flush()
    const current = findTask(r, id)
    const observed = { attemptId: current.attemptId!, reviewEpisode: current.reviewEpisode!, artifactDigest: current.artifactDigest! }
    expect(() => r.service.review(id, 'a', 'approve')).toThrow(/missing review observation/)
    expect(() => r.service.review(id, 'a', 'approve', { ...observed, reviewEpisode: 'old' })).toThrow(/stale/)
    writeFileSync(join(r.root, 'proof.json'), '{"version":1,"value":2}')
    expect(() => r.service.review(id, 'a', 'approve', observed)).toThrow(/artifacts changed/)
    expect(findTask(r, id).acceptanceState).toBe('pending')
    writeFileSync(join(r.root, 'proof.json'), '{"version":1,"value":1}')
    r.service.review(id, 'a', 'approve', observed)
    await flush()
    expect(findTask(r, id).acceptanceState).toBe('accepted')
  })

  it('persists pending acceptance with completion even when the second review-start append fails', async () => {
    const r = await rig()
    const id = r.dispatch([task({ reviewBy: 'reviewer' }), task({ id: 'after', blockedBy: ['a'] })])
    await flush()
    const original = r.service.events.append.bind(r.service.events)
    const append = vi.spyOn(r.service.events, 'append').mockImplementation((kind, fields) => {
      if (kind === 'task/review-started') throw new Error('injected second-append crash boundary')
      return original(kind, fields)
    })
    r.calls[0].finish(); await flush()
    const replay = fold(r.service.events.all())
    expect(replay.tasks.get(id + '/a')).toMatchObject({ status: 'completed', acceptanceState: 'pending' })
    expect(isReady(replay, replay.tasks.get(id + '/after')!)).toBe(false)
    expect(r.calls).toHaveLength(1)
    append.mockRestore()
    r.probe.recoverOrphans(); r.probe.recoverOrphans(); await flush()
    expect(r.calls).toHaveLength(2)
    expect(r.service.events.all().filter((event) => event.kind === 'task/review-started')).toHaveLength(1)
    r.calls[1].finish(success('VERDICT: APPROVE')); await flush()
    expect(findTask(r, id).acceptanceState).toBe('accepted')
    expect(r.calls).toHaveLength(3)
  })

  it('retains its owning finalizer through a failed first completion append', async () => {
    const r = await rig()
    const runId = r.dispatch([task({ reviewBy: 'reviewer' }), task({ id: 'dependent', blockedBy: ['a'] })])
    await flush()
    const append = r.service.events.append.bind(r.service.events)
    let fail = true
    vi.spyOn(r.service.events, 'append').mockImplementation((kind, fields) => {
      if (kind === 'task/completed' && fail) { fail = false; throw new Error('synthetic pre-commit failure') }
      return append(kind, fields)
    })
    r.calls[0].finish()
    await flush()
    expect(findTask(r, runId).status).toBe('blocked')
    expect(findTask(r, runId).blockedReason).toContain('synthetic pre-commit failure')
    expect(r.calls).toHaveLength(1)
  })

  it('does not accept required bytes changed by a reviewer, and offers explicit held-task recovery', async () => {
    const r = await rig()
    writeFileSync(join(r.root, 'artifact.json'), '{"version":1}')
    const runId = r.dispatch([task({ reviewBy: 'reviewer', evidence: { artifacts: [{ path: 'artifact.json', format: 'json', schemaVersion: 1 }] } })], 'owner', { version: 1, evidence: 'required', review: 'strict', isolation: 'advisory' })
    await flush()
    r.calls[0].finish()
    await flush()
    expect(r.calls).toHaveLength(2)
    writeFileSync(join(r.root, 'artifact.json'), '{"version":2}')
    r.calls[1].finish(success('VERDICT: APPROVE'))
    await flush()
    expect(findTask(r, runId)).toMatchObject({ status: 'blocked', acceptanceState: 'held', artifactState: 'invalid' })
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.status).toBe('running')
    r.service.retryTask(runId, 'a', 'owner', observation(r.service, runId))
    await flush()
    expect(r.calls).toHaveLength(3)
  })

  it('uses the run policy as a floor and requires a human when strict review has no assigned reviewer', async () => {
    const r = await rig()
    const policy = { version: 1 as const, evidence: 'required' as const, review: 'strict' as const, isolation: 'advisory' as const }
    const runId = r.dispatch([task({ policy: { evidence: 'advisory', review: 'off' } })], 'owner', policy)
    await flush()
    r.calls[0].finish()
    await flush()
    expect(findTask(r, runId)).toMatchObject({ status: 'reviewing', humanReview: true, acceptanceState: 'pending' })
    expect(() => r.service.completeTaskExternally(runId, 'a', 'owner', 'bypass')).toThrow(/strict acceptance/)
    const before = findTask(r, runId)
    r.service.events.append('task/completed', { runId, taskId: 'a', data: { source: 'operator', revokeAttempt: true } })
    expect(findTask(r, runId)).toEqual(before)
    const seq = r.service.events.seq
    expect(() => r.dispatch([task({ policy: { isolation: 'advisory' } })], 'other', { ...policy, isolation: 'strict' })).toThrow(/strict isolation/)
    expect(r.service.events.seq).toBe(seq)
  })

  it('refuses uncertified strict isolation before recording a run', async () => {
    const r = await rig()
    const before = r.service.events.seq
    expect(() => r.dispatch([task()], 'owner', { ...DEFAULT_POLICY, isolation: 'strict' })).toThrow(/strict isolation/)
    expect(r.service.events.seq).toBe(before)
  })
})

describe('meaningful cursor waits', () => {
  it('ignores heartbeats, replays meaningful gaps, and bounds returned text', async () => {
    const r = await rig()
    const id = r.dispatch([task()]); await flush()
    const cursor = r.service.events.seq
    let resolved = false
    const waiting = r.service.waitForChange(id, 10000, undefined, { afterSeq: cursor, maxChars: 512 }).then((text) => { resolved = true; return text })
    r.service.events.append('task/heartbeat', { runId: id, taskId: 'a', data: { note: 'progress only' } })
    await flush(); expect(resolved).toBe(false)
    r.service.events.append('task/failed', { runId: id, taskId: 'missing', data: { source: 'operator', reason: 'visible change' } })
    const text = await waiting
    expect(text).toContain('cursor=')
    expect(text.length).toBeLessThanOrEqual(512)
    const replay = await r.service.waitForChange(id, 10000, undefined, { afterSeq: cursor })
    expect(replay).toContain('task/failed')
  })

  it('returns immediately for a final run or an already-aborted wait and rejects future cursors', async () => {
    const r = await rig()
    const id = r.dispatch([task()]); await flush(); r.calls[0].finish(); await flush()
    expect(await r.service.waitForChange(id, 10000, undefined, { mode: 'terminal' })).toContain('terminal')
    const abort = new AbortController(); abort.abort()
    expect(await r.service.waitForChange(id, 10000, abort.signal)).toContain('aborted')
    expect(() => r.service.waitForChange(id, 10000, undefined, { afterSeq: r.service.events.seq + 1 })).toThrow(/ahead of/)
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
    const observed = findTask(r, runId)
    r.service.review(runId, 'a', 'approve', { attemptId: observed.attemptId!, reviewEpisode: observed.reviewEpisode!, artifactDigest: observed.artifactDigest! })
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
    r.service.completeTaskExternally(runId, 'a', 'owner', 'operator verified the result', observation(r.service, runId))
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

describe('bounded progress and operator intent', () => {
  it('honors durable provider retry-after despite a zero runtime base and replay', async () => {
    const r = await rig({ maxRetries: 1, retryBackoffBaseMs: 0, maxAttemptSeconds: 0 })
    const runId = r.dispatch([task()])
    await flush()
    const started = Date.now()
    r.service.recordChildFailure(r.calls[0].id, { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 10000 })
    r.calls[0].finish(failure('typed rate limit'))
    await flush()
    const failed = findTask(r, runId)
    expect(failed.status).toBe('retrying')
    expect(failed.retryNotBefore).toBeGreaterThanOrEqual(started + 10000)
    expect(failed.retryNotBefore).toBeLessThan(started + 11000)
    expect(fold(r.service.events.all()).tasks.get(runId + '/a')?.retryNotBefore).toBe(failed.retryNotBefore)
    await vi.advanceTimersByTimeAsync(9999)
    expect(r.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1002)
    expect(r.calls).toHaveLength(2)
  })

  it('never lets repeated heartbeat notes renew the persisted model-work ceiling', async () => {
    const r = await rig({ maxRetries: 2, maxAttemptSeconds: 10, spawnTimeoutSeconds: 5 })
    const runId = r.dispatch([task()])
    await flush()
    const deadline = findTask(r, runId).attemptDeadlineAt
    for (let index = 0; index < 2; index += 1) {
      await vi.advanceTimersByTimeAsync(4000)
      expect(r.service.report(r.calls[0].id, 'a', 'same heartbeat')).toBe('ok')
      expect(findTask(r, runId).attemptDeadlineAt).toBe(deadline)
    }
    await vi.advanceTimersByTimeAsync(2001)
    await flush()
    expect(r.calls[0].options.signal.aborted).toBe(true)
    expect(findTask(r, runId)).toMatchObject({ status: 'blocked', acceptanceState: 'held', blockedReason: expect.stringContaining('ATTEMPT_TIME_LIMIT') })
    expect(r.calls).toHaveLength(1)
  })

  it('rejects a stale interrupt tuple after replacement and journals the accepted actor and observed identity', async () => {
    const r = await rig()
    const runId = r.dispatch([task()])
    await flush()
    const old = observation(r.service, runId)
    r.service.interruptTask(runId, 'a', 'owner', old, 'peer:synthetic')
    await flush()
    expect(findTask(r, runId).attemptId).not.toBe(old.attemptId)
    const seq = r.service.events.seq
    expect(() => r.service.interruptTask(runId, 'a', 'owner', old, 'peer:synthetic')).toThrow(/stale/)
    expect(r.service.events.seq).toBe(seq)
    const decision = r.service.events.all().map((event) => event.data?.decision).find((value) => value !== undefined)
    expect(decision).toMatchObject({ action: 'interrupt-task', actor: 'peer:synthetic', observed: { attemptId: old.attemptId, status: old.status } })
  })
})

describe('composed request/retry hooks and drain authority', () => {
  const request = (id: string) => ({ provider: 'fake', model: 'model', sessionId: id, messages: [], signal: new AbortController().signal })
  async function consume(r: Awaited<ReturnType<typeof rig>>, id: string, terminal: () => AsyncIterable<StreamChunk>) {
    const seen: StreamChunk[] = []
    for await (const chunk of r.ctx.waterfall({} as never, 'llm/stream', request(id) as never, terminal)) seen.push(chunk)
    return seen
  }

  it('journals an actual composed provider-attempt stream, keeps unknown exposure, and replays without sends', async () => {
    const r = await rig()
    const runId = r.dispatch([task()])
    await flush()
    const adapter = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await consume(r, r.calls[0].id, adapter)
    await consume(r, r.calls[0].id, async function* (): AsyncGenerator<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } })
    const summary = r.service.requests.summary(runId)
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ counts: { total: 2, settled: 2 }, unresolved: { requestsWithoutUsage: 1 }, cost: { usd: null }, usage: { known: { inputTokens: 20, outputTokens: 4 } } })
    const before = r.service.events.seq
    const replay = new RequestLedger(r.service.events.all(), () => { throw new Error('replay must not append') })
    expect(replay.summary(runId)).toEqual(summary)
    expect(r.service.events.seq).toBe(before)
    expect(r.service.snapshot().support).toMatchObject({ hardBudgets: false, strictIsolation: false, requestCoverage: 'observed-llm-stream' })
  })

  it('declines an observed budget overflow before provider invocation and refuses hard budgets before run creation', async () => {
    const r = await rig()
    const result = r.service.dispatch({ title: 'budget', spec: 's', tasks: [task()], budget: { mode: 'advisory', maxRequests: 1 } }, r.parentFor() as never)
    r.service.endorse(result.runId)
    await flush()
    const adapter = vi.fn(async function* (): AsyncGenerator<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } })
    await consume(r, r.calls[0].id, adapter)
    await expect(consume(r, r.calls[0].id, adapter)).rejects.toThrow(/reservation limit/i)
    expect(adapter).toHaveBeenCalledTimes(1)
    // Unknown callers are not silently misattributed to the most recent run.
    await consume(r, 'unowned-session', adapter)
    expect(adapter).toHaveBeenCalledTimes(2)
    const seq = r.service.events.seq
    expect(() => r.service.dispatch({ title: 'unsupported', spec: 's', tasks: [task()], budget: { mode: 'hard', maxTokens: 10 } }, r.parentFor('other') as never)).toThrow(/hard.*unsupported/i)
    expect(r.service.events.seq).toBe(seq)
  })

  it('preempts a previously registered always-retry hook, including the native publication gap, not unrelated agents', async () => {
    const hostRetry = vi.fn(async () => ({ kind: 'retry' as const, delayMs: 0 }))
    const r = await rig({ maxRetries: 2 }, (ctx) => { ctx.on('agent/request-error', hostRetry) })
    const gate = deferred<void>()
    r.plans.push({ publication: gate })
    const runId = r.dispatch([task()])
    await flush()
    const payload = (id: string, parentSession?: string) => ({ agent: { id, session: { header: { origin: 'subagent', parentSession } } }, turn: 1, step: 1, provider: 'fake', failure: { code: 'INVALID_CREDENTIAL', message: 'synthetic', status: 401 }, signal: new AbortController().signal })
    expect(await r.ctx.waterfall('agent/request-error', payload(r.calls[0].id, 'anchor') as never, async () => undefined)).toBeUndefined()
    expect(hostRetry).not.toHaveBeenCalled()
    expect(await r.ctx.waterfall('agent/request-error', payload('unrelated', 'other-parent') as never, async () => undefined)).toMatchObject({ kind: 'retry' })
    expect(hostRetry).toHaveBeenCalledTimes(1)
    gate.resolve()
    await flush()
    r.calls[0].finish(failure('misleading diagnostic'))
    await flush()
    expect(findTask(r, runId)).toMatchObject({ status: 'blocked', acceptanceState: 'held', blockedReason: expect.stringContaining('INVALID_CREDENTIAL') })
    expect(r.calls).toHaveLength(1)
  })

  it('keeps the store writer exclusive across asynchronous service teardown', async () => {
    const r = await rig()
    const disposal = deferred<void>()
    r.plans.push({ disposal })
    r.dispatch([task()])
    await flush()
    r.ctx.registry.delete(plugin)
    await flush()
    expect(r.service.events.closed).toBe(false)
    expect(() => new EventStore(join(r.root, 'events.jsonl'))).toThrow(/owned|ownership/i)
    disposal.resolve()
    await flush()
    expect(r.service.events.closed).toBe(true)
    const successor = new EventStore(join(r.root, 'events.jsonl'))
    successor.close()
  })
})
