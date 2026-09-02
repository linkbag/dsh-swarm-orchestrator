import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'
import { SwarmService } from '../src/service.js'

interface StartCall {
  label?: string
  prompt: Array<{ type: string; text: string }>
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  persona?: string
  parent?: unknown
}

/** Fake spawn-provider subagents service with scriptable outcomes. */
class FakeSubagents {
  readonly calls: StartCall[] = []
  /** How many upcoming start() calls throw a model-unavailable error. */
  unavailableCount = 0
  /** Scripted child output by call index (falls back to approve). */
  script: Record<number, string> = {}
  /** When true, children stay in-flight until release() (mimics a running agent). */
  holdAll = false
  private readonly held: Array<() => void> = []
  private n = 0

  start(_provider: string, request: never): unknown {
    const call = request as unknown as StartCall
    const index = this.calls.length
    this.calls.push(call)
    if (this.unavailableCount > 0) {
      this.unavailableCount -= 1
      throw new Error('no adapter registered for provider zai')
    }
    this.n += 1
    const id = `sess-${this.n}`
    const text = this.script[index] ?? `finished ${call.label ?? 'task'}\nVERDICT: APPROVE`
    const output = [{ type: 'text', text }]
    if (this.holdAll) {
      let resolveResult!: (value: { stopReason: string; output: Array<{ type: string; text: string }> }) => void
      const result = new Promise<{ stopReason: string; output: Array<{ type: string; text: string }> }>((resolve) => { resolveResult = resolve })
      this.held.push(() => { resolveResult({ stopReason: 'completed', output }) })
      return { id, result, dispose: async () => {} }
    }
    return {
      id,
      result: Promise.resolve({ stopReason: 'completed', output }),
      dispose: async () => {},
    }
  }

  /** Resolve all held children. */
  release(): void {
    this.held.splice(0).forEach((fn) => { fn() })
  }
}

/** Fake agents factory: mints service-owned idle anchor agents. */
class FakeAgents {
  readonly created: Array<{ sessionId: string; cwd?: string; agentPreset?: string; agentOptions?: { provider?: string; model?: string } }> = []
  readonly anchors: unknown[] = []
  setupCalls = 0
  disposeCount = 0
  private n = 0

  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (anchorCtx: unknown) => void | Promise<void>
  }): Promise<{ agent: unknown; dispose(): Promise<void> }> {
    this.created.push({
      sessionId: options.sessionId,
      cwd: options.meta?.cwd,
      agentPreset: options.meta?.agentPreset,
      agentOptions: options.agentOptions,
    })
    this.n += 1
    const agent = {
      id: `anchor-${this.n}`,
      options: { ...options.agentOptions },
      session: { header: { id: `anchor-${this.n}`, delegationDepth: 0 } },
    }
    this.anchors.push(agent)
    // The real factory awaits setup inside the creation window; mirror that
    // with a context whose agentPresets is absent (no roster in unit tests).
    const setupPromise = (async () => {
      if (options.setup !== undefined) {
        this.setupCalls += 1
        await options.setup({ get: () => undefined })
      }
    })()
    return setupPromise.then(() => ({
      agent,
      dispose: async () => { this.disposeCount += 1 },
    }))
  }
}

/** Fake dispatching agent: carries a route, session cwd, and a composed preset. */
function makeDispatcher(): unknown {
  return {
    id: 'parent-1',
    options: { provider: 'zai', model: 'glm-5.3' },
    session: { header: { id: 'parent-1', cwd: 'D:\\work' } },
    ctx: {
      get: (name: string): unknown =>
        name === 'agentPresets' ? { composedPreset: () => 'standard' } : undefined,
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string, dump?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (dump !== undefined) console.error('[waitFor timeout dump] ' + dump())
  throw new Error(`timed out waiting for: ${what}`)
}

async function bootSwarm(overrides: Record<string, unknown> = {}): Promise<{ ctx: Context; service: SwarmService; fake: FakeSubagents; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-service-'))
  const ctx = new Context()
  const fake = new FakeSubagents()
  ctx.reflect.provide('subagents', fake as never)
  await ctx.plugin(swarmPlugin, {
    storageDir: dir,
    maxConcurrent: 5,
    staleTimeoutSeconds: 14400,
    maxRetries: 2,
    reviewLoops: 3,
    ...overrides,
  })
  // ctx.get returns a traceable proxy; unwrap to the raw service via symbols.original
  const traced = ctx.get('swarm') as Record<symbol, unknown> | undefined
  if (traced === undefined) throw new Error('swarm service not registered after plugin load')
  const service = traced[Symbol.for('cordis.original')] as SwarmService | undefined
  if (service === undefined) throw new Error('swarm service could not be unwrapped from trace proxy')
  return { ctx, service, fake, dir }
}

describe('swarm service (integration, fake subagents)', () => {
  const dirs: string[] = []
  const contexts: Context[] = []

  afterEach(() => {
    for (const ctx of contexts.splice(0)) ctx.registry.delete(swarmPlugin)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('dispatch → endorse → spawn with role model → review approve → completed run with report', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    table.roles.reviewer = { ...table.roles.reviewer, provider: 'deepseek-official', model: 'deepseek-v4' }
    service.setDutyTable(table, 'test')

    const parent = makeDispatcher() as never
    const result = service.dispatch({
      title: 'demo run',
      spec: 'make a tiny feature',
      tasks: [
        { id: 'a', subject: 'Write the thing', description: 'Write it well.', role: 'builder', reviewBy: 'reviewer' },
        { id: 'b', subject: 'Second thing', description: 'Depends on a.', role: 'builder', blockedBy: ['a'] },
      ],
    }, parent)
    expect(result.status).toBe('planning')

    service.endorse(result.runId)
    expect(service.snapshot().runs.find((r) => r.id === result.runId)?.status).toBe('running')

    // task a launches with the pinned model; b waits for a
    await waitFor(() => fake.calls.length >= 1, 3000, 'first spawn')
    expect(fake.calls[0]?.agentOptions?.provider).toBe('zai')
    expect(fake.calls[0]?.agentOptions?.model).toBe('glm-5.3')
    expect(fake.calls[0]?.prompt[0]?.text).toContain('Write the thing')
    expect(fake.calls[0]?.prompt[0]?.text).toContain('reviewer')

    // task a completes → reviewer spawns → approves → b unblocks and runs
    await waitFor(() => fake.calls.length >= 2, 3000, 'reviewer spawn')
    expect(fake.calls[1]?.agentOptions?.model).toBe('deepseek-v4')
    expect(fake.calls[1]?.prompt[0]?.text).toContain('VERDICT')
    await waitFor(() => fake.calls.length >= 3, 3000, 'task b spawn')
    expect(fake.calls[2]?.prompt[0]?.text).toContain('Depends on completed tasks: a')

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completion')
    const run = service.snapshot().runs.find((r) => r.id === result.runId)!
    expect(run.report?.taskCount).toBe(2)
    expect(run.report?.tasks.map((t) => t.id).sort()).toEqual(['a', 'b'])
    const taskA = service.snapshot().tasks.find((t) => t.id === 'a')!
    expect(taskA.reviewed).toBe(true)
    expect(taskA.status).toBe('completed')
  })

  it('falls back to the next model candidate when the primary is unavailable', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const table = structuredClone(service.duty.get())
    table.roles.builder = {
      ...table.roles.builder,
      provider: 'zai', model: 'glm-5.3',
      fallbacks: [{ provider: 'deepseek-official', model: 'deepseek-v4' }],
    }
    service.setDutyTable(table, 'test')

    fake.unavailableCount = 1 // first start() throws model-unavailable
    const result = service.dispatch({
      title: 'fallback demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 2, 3000, 'fallback spawn')
    expect(fake.calls[0]?.agentOptions?.model).toBe('glm-5.3')
    expect(fake.calls[1]?.agentOptions?.model).toBe('deepseek-v4')

    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'a')?.status === 'completed', 3000, 'task completion after fallback')
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.agent?.model).toBe('deepseek-v4')
  })

  it('review rejection requeues the task with feedback, then approves on rework', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')

    // call 0: builder a · call 1: reviewer REJECTs · call 2: builder rework · call 3: reviewer approves
    fake.script = {
      1: 'not good enough, add tests\nVERDICT: REJECT',
      3: 'fixed with tests\nVERDICT: APPROVE',
    }

    const result = service.dispatch({
      title: 'review loop demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', reviewBy: 'reviewer' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    // reviewer spawns, rejects, the task requeues and the rework spawn carries the feedback
    await waitFor(() => fake.calls.length >= 3, 5000, 'rework spawn after rejection')
    expect(service.events.all().some((e) => e.kind === 'task/reviewed' && (e.data as { verdict?: string } | undefined)?.verdict === 'reject')).toBe(true)
    expect(fake.calls[2]?.prompt[0]?.text).toContain('add tests')
    const requeued = service.snapshot().tasks.find((t) => t.id === 'a')!
    expect(requeued.reviews).toBe(1)
    expect(service.events.all().some((e) => e.kind === 'task/reviewed' && String((e.data as { feedback?: string } | undefined)?.feedback ?? '').includes('add tests'))).toBe(true)

    await waitFor(() => fake.calls.length >= 4, 5000, 'second review spawn')
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completion after rework')
    const run = service.snapshot().runs.find((r) => r.id === result.runId)!
    expect(run.stats?.reviewsRejected).toBe(1)
    expect(run.stats?.reviewsPassed).toBe(1)
    expect(run.report?.tasks[0]?.reviewed).toBe(true)
  })

  it('swarm_report authenticates tracked child sessions only', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    fake.holdAll = true // keep the child in-flight so its session stays tracked
    const result = service.dispatch({
      title: 'report demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.events.all().some((e) => e.kind === 'task/agent-started'), 3000, 'agent-started event')
    const started = service.events.all().find((e) => e.kind === 'task/agent-started')!
    const sessionId = String((started.data ?? {}).sessionId)
    expect(service.report(sessionId, 'a', 'halfway there')).toBe('ok')
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.lastNote).toBe('halfway there')
    expect(() => service.report('sess-bogus', 'a', 'hi')).toThrow(/not a tracked swarm task agent/)
    fake.release()
  })

  it('abort stops dispatching and marks the run aborted', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    const result = service.dispatch({
      title: 'abort demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder' },
        { id: 'b', subject: 'B', description: 'd', role: 'builder' },
      ],
    }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => fake.calls.length >= 1, 3000, 'spawn before abort')
    service.abort(result.runId)
    expect(service.snapshot().runs.find((r) => r.id === result.runId)?.status).toBe('aborted')
  })

  it('spawns through a service-owned anchor, so the run survives its dispatching session', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)

    const result = service.dispatch({
      title: 'anchor demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder' },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', blockedBy: ['a'] },
      ],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 2, 5000, 'both tasks spawned')
    // One anchor per run, composed from the dispatcher's captured world:
    // its cwd, its preset, and its model route (duty roles are unpinned, so
    // children inherit the run default through both the anchor and the
    // explicit agentOptions), and every spawn routed through it.
    expect(agents.created.length).toBe(1)
    expect(agents.created[0]?.cwd).toBe('D:\\work')
    expect(agents.created[0]?.agentPreset).toBe('standard')
    expect(agents.created[0]?.agentOptions).toEqual({ provider: 'zai', model: 'glm-5.3' })
    expect(agents.setupCalls).toBe(1)
    expect(fake.calls[0]?.parent).toBe(agents.anchors[0])
    expect(fake.calls[1]?.parent).toBe(agents.anchors[0])
    expect(fake.calls[0]?.agentOptions).toEqual({ provider: 'zai', model: 'glm-5.3' })

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completion')
    // Terminal run releases its anchor.
    await waitFor(() => agents.disposeCount === 1, 3000, 'anchor disposal')
  })

  it('a parentless run (host restart recovery) still spawns through a fresh anchor', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)
    // No dispatcher to inherit from: pin an explicit model so the run is routable.
    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'recovery demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, undefined)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn without a dispatching parent')
    expect(agents.created.length).toBe(1)
    expect(agents.created[0]?.agentPreset).toBeUndefined()
    expect(fake.calls[0]?.parent).toBe(agents.anchors[0])
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completion')
  })

  it('requireManualEndorsement hard-gates even endorse=true dispatches', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ requireManualEndorsement: true })
    contexts.push(ctx)
    dirs.push(dir)

    const result = service.dispatch({
      title: 'hard gate demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
      endorse: true,
    }, makeDispatcher() as never)

    // endorse=true was swallowed by the hard gate: planning, zero spawns.
    expect(result.status).toBe('planning')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(fake.calls.length).toBe(0)

    // Only the human dashboard action releases the gate.
    service.endorse(result.runId)
    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn after manual endorsement')
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completion')
  })

  it('an unroutable run fails its tasks with an actionable reason, cascades to dependents, and ends failed', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    // No dispatcher, no pinned models: nothing can route.
    const result = service.dispatch({
      title: 'no route demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder' },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', blockedBy: ['a'] },
      ],
    }, undefined)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'failed', 5000, 'run fails terminally')
    const snap = service.snapshot()
    const a = snap.tasks.find((t) => t.id === 'a')!
    const b = snap.tasks.find((t) => t.id === 'b')!
    expect(a.status).toBe('failed')
    expect(a.lastNote).toMatch(/no model route for role "builder"/)
    expect(b.status).toBe('blocked')
    expect(b.blockedReason).toMatch(/upstream task a did not complete/)
    const run = snap.runs.find((r) => r.id === result.runId)!
    expect(run.report?.byStatus).toEqual({ failed: 1, blocked: 1 })
  })
})
