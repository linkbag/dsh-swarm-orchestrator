import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'
import { captureAuthority, validAuthority, type AuthorityMode, type EvidenceShell } from '../src/authority.js'
import { taskReportRelPath } from '../src/dispatch/spawn.js'
import type { SwarmService } from '../src/service.js'
import type { TaskSpec } from '../src/domain/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type EvidenceRequest = Parameters<EvidenceShell['resolve']>[0]
type EvidenceHandle = Awaited<ReturnType<EvidenceShell['execute']>>
type EvidenceResult = Awaited<ReturnType<EvidenceHandle['result']>>
interface ChildOptions {
  prompt: Array<{ text: string }>
  parent?: unknown
  signal: AbortSignal
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
  toolFilter?: { deny?: string[]; allow?: string[] }
  maxDepth?: number
}
interface ChildResult { stopReason: string; output: Array<{ type: string; text: string }>; diagnostic?: string }
interface ChildCall { options: ChildOptions; id: string; dispose: ReturnType<typeof vi.fn>; finish: (result?: ChildResult) => void }
const completed = (text = 'work completed'): ChildResult => ({ stopReason: 'completed', output: [{ type: 'text', text }] })
const died: ChildResult = { stopReason: 'error', output: [{ type: 'text', text: 'work already produced' }], diagnostic: 'simulated death after work' }

class ShellFake implements EvidenceShell {
  unsupported = false
  denied = false
  exitCode = 0
  get sandboxMode(): AuthorityMode | undefined { return this.unsupported ? undefined : 'workspace-write' }
  readonly requests: EvidenceRequest[] = []
  resolve(request: EvidenceRequest): EvidenceRequest { return request }
  async execute(request: EvidenceRequest): Promise<EvidenceHandle> {
    this.requests.push(request)
    return {
      kill: vi.fn(() => true), done: Promise.resolve(),
      result: async (): Promise<EvidenceResult> => ({
        exitCode: this.exitCode, timedOut: false, aborted: false,
        stdout: { text: 'canned evidence output' }, stderr: { text: '' },
        sandbox: { mode: request.sandboxPolicy.mode, denied: this.denied },
      }),
    }
  }
}

const fixtures: Array<{ ctx: Context; service: SwarmService; root: string; cleanup: Array<() => void> }> = []
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }

async function rig(options: { holdChildren?: boolean; config?: Record<string, unknown>; beforeBoot?: (root: string) => void } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-authority-owned-')))
  const ctx = new Context()
  let mode: AuthorityMode = 'workspace-write'
  const policy = { resolve: () => ({ mode, workspaceRoot: root }), overrideOf: () => mode }
  const parent = {
    id: 'owner', ctx: { get: (name: string) => name === 'sandboxPolicy' ? policy : name === 'approval' ? {} : undefined },
    session: { header: { id: 'owner', cwd: root, delegationDepth: 0 } }, options: { provider: 'fake', model: 'builder-model' },
  }
  const shell = new ShellFake()
  const children: ChildCall[] = []
  const cleanup: Array<() => void> = []
  const responses: ChildResult[] = []
  let onStart: ((call: ChildCall) => void) | undefined
  const subagents = {
    capabilities: { start: { toolFilter: true, maxDepth: true, agentOptions: true, persona: true } },
    start: async (_prompt: unknown, start: ChildOptions) => {
      const result = deferred<ChildResult>()
      const call: ChildCall = { options: start, id: `owned-child-${children.length}`, dispose: vi.fn(async () => {}), finish: (value = completed()) => result.resolve(value) }
      children.push(call)
      cleanup.push(() => call.finish())
      onStart?.(call)
      if (options.holdChildren !== true) call.finish(responses.shift() ?? completed('VERDICT: APPROVE'))
      return { id: call.id, localAgent: { id: call.id }, result: result.promise, dispose: call.dispose }
    },
  }
  const anchorCalls: unknown[] = []
  const seeds: Array<{ kind: string; data: unknown }> = []
  const timeline: string[] = []
  const anchorDispose = vi.fn(async () => {})
  let anchorGate: ReturnType<typeof deferred<void>> | undefined
  const agents = {
    create: async (request: { setup?: (context: { get: (name: string) => unknown }, anchor: unknown) => Promise<void> }) => {
      anchorCalls.push(request)
      await anchorGate?.promise
      const agent = { id: 'anchor', session: { header: { id: 'anchor', cwd: root, delegationDepth: 0 }, append: (kind: string, data: unknown) => { seeds.push({ kind, data }); timeline.push(kind) } } }
      const presets = { mount: async () => { timeline.push('preset:mount') } }
      await request.setup?.({ get: (name) => name === 'agentPresets' ? presets : undefined }, agent)
      timeline.push('anchor:publish')
      return { agent, dispose: anchorDispose }
    },
    get: () => undefined,
  }
  const originalStart = subagents.start
  subagents.start = async (prompt, start) => { timeline.push('child:start'); return originalStart(prompt, start) }
  ctx.reflect.provide('sandboxPolicy', policy as never)
  ctx.reflect.provide('shell', shell as never)
  ctx.reflect.provide('subagents', subagents as never)
  ctx.reflect.provide('agents', agents as never)
  ctx.reflect.provide('tools', { restrictableNames: new Set(['read', 'write', 'pwsh']) } as never)
  options.beforeBoot?.(root)
  await ctx.plugin(plugin, {
    storageDir: root, reportDir: join(root, 'reports'), maxConcurrent: 2, maxTotalConcurrentAgents: 4,
    maxRetries: 0, reviewLoops: 1, requireManualEndorsement: true, requireArchitectReview: false,
    maxSubagentDepth: 1, spawnStaggerMs: 0, retryBackoffBaseMs: 0, bootGraceSeconds: 3,
    circuitBreakerThreshold: 0, notifyDispatchSession: false, ...options.config,
  })
  const service = (ctx.get('swarm') as unknown as Record<symbol, SwarmService>)[Symbol.for('cordis.original')]
  fixtures.push({ ctx, service, root, cleanup })
  await flush()
  return {
    ctx, root, service, parent, shell, children, responses, anchorCalls, seeds, timeline, anchorDispose,
    setMode: (next: AuthorityMode) => { mode = next },
    onStart: (callback: (call: ChildCall) => void) => { onStart = callback },
    holdAnchor: () => { anchorGate = deferred<void>(); cleanup.push(() => anchorGate!.resolve()); return anchorGate },
    dispatch: (tasks: TaskSpec[]) => { const result = service.dispatch({ title: 'authority regression', spec: 's', tasks }, parent as never); service.endorse(result.runId); return result.runId },
  }
}

function report(call: ChildCall, root: string, changes: Record<string, unknown> = {}): string {
  const text = call.options.prompt.map((block) => block.text).join('\n')
  const encoded = text.match(/```json\n([^\n]+)\n```/)?.[1]
  if (encoded === undefined) throw new Error('task prompt omitted durable report identity')
  const identity = JSON.parse(encoded) as { runId: string; taskId: string; attemptId: string }
  const path = join(root, taskReportRelPath(identity.taskId, identity.runId, identity.attemptId))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...identity, status: 'completed', summary: 'report survived the child', ...changes }))
  return path
}
const builder = (extra: Partial<TaskSpec> = {}): TaskSpec => ({ id: 'a', subject: 'A', description: 'd', role: 'builder', ...extra })

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T00:00:00Z')) })
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const release of fixture.cleanup) release()
    fixture.ctx.registry.delete(plugin)
    await flush()
    const holders = fixture.service as unknown as { holders: Set<{ done?: Promise<void> }> }
    await Promise.allSettled([...holders.holders].map((flight) => flight.done))
    expect(realpathSync(fixture.root)).toBe(fixture.root)
    expect(fixture.root.startsWith(realpathSync(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))).toBe(true)
    rmSync(fixture.root, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('captured authority', () => {
  it('pins a parent override and never inherits an approval escalation grant', () => {
    let mode: AuthorityMode = 'workspace-write'
    const parent = { ctx: { get: (name: string) => name === 'sandboxPolicy' ? { overrideOf: () => mode } : name === 'approval' ? {} : undefined }, session: { header: { cwd: process.cwd() } } }
    const ctx = new Context()
    ctx.reflect.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) } as never)
    const authority = captureAuthority(ctx, parent as never)
    mode = 'danger-full-access'
    expect(authority).toEqual({ version: 1, sandbox: { mode: 'workspace-write', workspaceRoot: process.cwd() }, delegated: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } })
    expect(validAuthority(authority)).toBe(true)
  })

  it('parentless dispatch stays read-only even under a full-access deployment default', () => {
    const ctx = new Context()
    ctx.reflect.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) } as never)
    expect(captureAuthority(ctx, undefined).sandbox.mode).toBe('read-only')
    expect(captureAuthority(new Context(), undefined).delegated).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
  })

  it.each([
    null, {}, { version: 0 },
    { version: 1, sandbox: { mode: 'read-only', workspaceRoot: 'relative' }, delegated: { sandboxMode: 'read-only', approvalPolicy: 'never' } },
    { version: 1, sandbox: { mode: 'read-only', workspaceRoot: process.cwd() }, delegated: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } },
    { version: 1, sandbox: { mode: 'read-only', workspaceRoot: process.cwd() }, delegated: { sandboxMode: 'read-only', approvalPolicy: 'always' } },
  ])('refuses malformed durable authority %j', (value) => { expect(validAuthority(value)).toBe(false) })

  it('single-flights concurrent anchor creation and seeds permissions before publishing children', async () => {
    const r = await rig()
    const gate = r.holdAnchor()
    const runId = r.dispatch([builder(), builder({ id: 'b' })])
    await flush()
    expect(r.anchorCalls).toHaveLength(1)
    expect(r.children).toHaveLength(0)
    r.setMode('danger-full-access')
    gate.resolve()
    await flush()
    expect(r.children).toHaveLength(2)
    expect(r.seeds).toContainEqual({ kind: 'sandbox/mode', data: { mode: 'workspace-write', source: 'delegation' } })
    expect(r.seeds).toContainEqual({ kind: 'approval/policy', data: { policy: 'never', source: 'delegation' } })
    for (const boundary of ['preset:mount', 'anchor:publish', 'child:start']) {
      expect(r.timeline).toContain(boundary)
      expect(r.timeline.indexOf('sandbox/mode')).toBeLessThan(r.timeline.indexOf(boundary))
      expect(r.timeline.indexOf('approval/policy')).toBeLessThan(r.timeline.indexOf(boundary))
    }
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.dispatch?.authority?.sandbox.mode).toBe('workspace-write')
    expect(r.anchorDispose).toHaveBeenCalledTimes(1)
  })

  it('uses the same bounded role launch policy for reviewers and the verdict re-ask', async () => {
    const r = await rig()
    const table = structuredClone(r.service.duty.get())
    table.roles.builder.toolFilter = { deny: ['write'] }
    table.roles.reviewer.toolFilter = { allow: ['read'] }
    table.roles.reviewer.provider = 'review-provider'
    table.roles.reviewer.model = 'review-model'
    r.service.setDutyTable(table, 'test')
    r.responses.push(completed('builder output'), completed('No verdict yet.'), completed('VERDICT: APPROVE'))
    const runId = r.dispatch([builder({ reviewBy: 'reviewer' })])
    await flush()
    expect(r.children).toHaveLength(3)
    expect(r.children[0].options.toolFilter).toEqual({ deny: ['write'] })
    for (const call of r.children.slice(1)) {
      expect(call.options.toolFilter).toEqual({ allow: ['read'] })
      expect(call.options.maxDepth).toBe(1)
      expect(call.options.parent).toBe(r.children[0].options.parent)
      expect(call.options.agentOptions).toMatchObject({ provider: 'review-provider', model: 'review-model' })
      expect(call.options.signal).toBeInstanceOf(AbortSignal)
      expect(call.dispose).toHaveBeenCalledTimes(1)
    }
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.stats?.reviewsPassed).toBe(1)
  })

  it('parks a persisted invalid reviewer restriction without launching an unrestricted reviewer', async () => {
    const r = await rig()
    const table = structuredClone(r.service.duty.get())
    table.roles.reviewer.toolFilter = { deny: ['nonexistent-tool'] }
    r.service.duty.save(table)
    const runId = r.dispatch([builder({ reviewBy: 'reviewer' })])
    await flush()
    const task = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
    expect(r.children).toHaveLength(1)
    expect(task.status).toBe('blocked')
    expect(task.humanReview).toBe(true)
    expect(task.blockedReason).toMatch(/deny-list/)
  })

  it('executes evidence only through Shell under the captured ceiling; denied exit 0 cannot complete', async () => {
    const r = await rig()
    r.shell.denied = true
    const runId = r.dispatch([builder({ evidence: { commands: ['canned write outside workspace'] } })])
    r.setMode('danger-full-access')
    await flush()
    expect(r.shell.requests).toHaveLength(2)
    for (const request of r.shell.requests) {
      expect(request.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: r.root })
      expect(request.workdir).toBe(r.root)
      expect(request.onExpiry).toBe('kill')
      expect(request.signal).toBeInstanceOf(AbortSignal)
    }
    const task = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
    expect(task.status).toBe('blocked')
    expect(task.blockedReason).toMatch(/sandbox/)
    expect(r.children).toHaveLength(1)
  })

  it('refuses evidence before execution when Shell cannot enforce restricted authority', async () => {
    const r = await rig()
    r.shell.unsupported = true
    const runId = r.dispatch([builder({ evidence: { commands: ['never execute this'] } })])
    await flush()
    expect(r.shell.requests).toHaveLength(0)
    const task = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
    expect(task.status).toBe('blocked')
    expect(task.blockedReason).toMatch(/cannot enforce/)
  })
})

describe('identity-bound report recovery', () => {
  it('adopted output still executes evidence and waits for human approval', async () => {
    const r = await rig()
    r.responses.push(died)
    r.onStart((call) => { report(call, r.root) })
    const runId = r.dispatch([builder({ evidence: { commands: ['canned verification'] }, reviewGate: 'human' })])
    await flush()
    const task = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
    expect(r.children).toHaveLength(1)
    expect(r.shell.requests).toHaveLength(1)
    expect(task.recovered).toBe(true)
    expect(task.status).toBe('reviewing')
    expect(task.humanReview).toBe(true)
    r.service.review(runId, 'a', 'approve')
    await flush()
    expect(r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')?.status).toBe('completed')
    expect(r.service.snapshot().runs.find((run) => run.id === runId)?.stats?.reviewsPassed).toBe(1)
  })

  it('an adopted report cannot bypass failing commands or release its downstream task', async () => {
    const r = await rig()
    r.shell.exitCode = 1
    r.responses.push(died)
    r.onStart((call) => { report(call, r.root) })
    const runId = r.dispatch([builder({ evidence: { commands: ['canned failing check'] } }), builder({ id: 'after', blockedBy: ['a'] })])
    await flush()
    const task = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
    expect(task.status).toBe('blocked')
    expect(task.humanReview).toBe(true)
    expect(r.shell.requests).toHaveLength(2)
    expect(r.children).toHaveLength(1)
    const downstream = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'after')!
    expect(downstream.status).toBe('blocked')
    expect(downstream.blockedReason).toBe('upstream task a did not complete')
    expect(downstream.attempts).toBe(0)
  })

  it.each([{ runId: 'another-run' }, { taskId: 'another-task' }, { attemptId: 'another-attempt' }, { runId: undefined }, { taskId: undefined }, { attemptId: undefined }])('does not adopt a fresh report with wrong or absent identity %j', async (changes) => {
    const r = await rig()
    r.responses.push(died)
    r.onStart((call) => { report(call, r.root, changes) })
    const runId = r.dispatch([builder()])
    await flush()
    const task = r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')!
    expect(task.status).toBe('failed')
    expect(task.recovered).not.toBe(true)
    expect(task.summary).toBeUndefined()
    expect(r.children).toHaveLength(1)
  })

  it('does not adopt even a fresh legacy task-id-only report', async () => {
    const r = await rig()
    r.responses.push(died)
    r.onStart(() => {
      const path = join(r.root, taskReportRelPath('a'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ taskId: 'a', status: 'completed', summary: 'unbound legacy output' }))
    })
    const runId = r.dispatch([builder()])
    await flush()
    expect(r.service.snapshot().tasks.find((task) => task.runId === runId && task.id === 'a')?.status).toBe('failed')
  })

  it('report paths separate sanitized-name collisions, runs, and attempts', () => {
    const paths = [taskReportRelPath('a/b', 'run', 'attempt'), taskReportRelPath('a?b', 'run', 'attempt'), taskReportRelPath('a/b', 'other-run', 'attempt'), taskReportRelPath('a/b', 'run', 'other-attempt')]
    expect(new Set(paths).size).toBe(4)
    for (const path of paths) expect(path).toMatch(/^\.dsh-swarm\/run-[a-f0-9]{32}\/attempt-[a-f0-9]{32}\/task-[a-f0-9]{32}\.json$/)
  })

  it('restart adoption runs the same evidence and human gate without respawning paid work', async () => {
    const r = await rig({ beforeBoot: (root) => {
      const authority = { version: 1, sandbox: { mode: 'workspace-write', workspaceRoot: root }, delegated: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } }
      const tasks = [builder({ reviewGate: 'human', evidence: { commands: ['canned recovery check'] } })]
      const events = [
        { seq: 1, at: 1, kind: 'run/created', runId: 'restart', data: { title: 'restart', spec: 's', dispatch: { cwd: root, provider: 'fake', model: 'model', authority }, tasks } },
        { seq: 2, at: 2, kind: 'run/endorsed', runId: 'restart' },
        { seq: 3, at: 3, kind: 'task/started', runId: 'restart', taskId: 'a', data: { attemptProtocol: 2, attemptId: 'durable-attempt' } },
      ]
      const path = join(root, taskReportRelPath('a', 'restart', 'durable-attempt'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ runId: 'restart', taskId: 'a', attemptId: 'durable-attempt', status: 'completed', summary: 'durable restart handoff' }))
      writeFileSync(join(root, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    } })
    await vi.advanceTimersByTimeAsync(3000) // honour the minimum configured boot recovery grace
    await flush()
    const task = r.service.snapshot().tasks.find((task) => task.runId === 'restart' && task.id === 'a')!
    expect(r.children).toHaveLength(0)
    expect(r.shell.requests).toHaveLength(1)
    expect(r.shell.requests[0].sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: r.root })
    expect(task.recovered).toBe(true)
    expect(task.status).toBe('reviewing')
    expect(task.humanReview).toBe(true)
    expect(task.summary).toBe('durable restart handoff')
  })

  it('legacy restart recovery pauses instead of silently borrowing deployment full access', async () => {
    const r = await rig({ holdChildren: true, beforeBoot: (root) => {
      const events = [
        { seq: 1, at: 1, kind: 'run/created', runId: 'legacy', data: { title: 'legacy', spec: 's', dispatch: { cwd: root, provider: 'fake', model: 'model' }, tasks: [builder()] } },
        { seq: 2, at: 2, kind: 'run/endorsed', runId: 'legacy' },
        { seq: 3, at: 3, kind: 'task/started', runId: 'legacy', taskId: 'a', data: { attemptId: 'pre-restart' } },
      ]
      writeFileSync(join(root, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    } })
    r.setMode('danger-full-access')
    await vi.advanceTimersByTimeAsync(3000) // recovery must happen after the supported boot grace
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === 'legacy')?.status).toBe('paused')
    expect(r.children).toHaveLength(0)
    r.service.resumeRun('legacy')
    await flush()
    expect(r.service.snapshot().runs.find((run) => run.id === 'legacy')?.dispatch?.authority?.sandbox.mode).toBe('read-only')
    expect(r.seeds).toContainEqual({ kind: 'sandbox/mode', data: { mode: 'read-only', source: 'delegation' } })
  })
})
