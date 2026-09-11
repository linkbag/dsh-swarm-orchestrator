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
  /** Throw a quota-class error for this many upcoming calls (A3). */
  quotaCount = 0
  /** Throw a provider-class error on the first call only (A6 rotation). */
  failOnce = false
  private readonly held: Array<() => void> = []
  private n = 0
  private failedOnce = false

  start(_provider: string, request: never): unknown {
    const call = request as unknown as StartCall
    const index = this.calls.length
    this.calls.push(call)
    if (this.unavailableCount > 0) {
      this.unavailableCount -= 1
      throw new Error('no adapter registered for provider zai')
    }
    if (this.quotaCount > 0) {
      this.quotaCount -= 1
      throw new Error('provider quota exhausted: insufficient balance')
    }
    if (this.failOnce && !this.failedOnce) {
      this.failedOnce = true
      throw new Error('boom: stream idle timeout')
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

  /** Live-session lookup: resolves the dispatching session for completion pushes. */
  get(id: string): { followup: (message: unknown) => void } | undefined {
    if (id === 'parent-live' || id === 'parent-1') {
      return { followup: (message: unknown): void => { this.followupCalls.push(String(message)) } }
    }
    return undefined
  }

  readonly followupCalls: string[] = []
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
    // v0.5.0 guards default ON in production; tests opt out unless exercising them.
    requireArchitectReview: false,
    workspaceRunPolicy: 'off',
    // H-1/H-2 hardening defaults ON in production; tests disable for speed.
    retryBackoffBaseMs: 0,
    circuitBreakerThreshold: 0,
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

  it('auto-pauses on quota exhaustion and resumes keeping completed work', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    fake.quotaCount = 1

    const result = service.dispatch({
      title: 'quota demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'paused', 5000, 'run pauses on quota')
    const paused = service.snapshot().runs.find((r) => r.id === result.runId)!
    expect(paused.pauseReason).toMatch(/quota/)

    service.resumeRun(result.runId)
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completes after resume')
  })

  it('retry prompts carry prior-attempt notes and the resume rule', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const result = service.dispatch({
      title: 'resume hints',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    // Simulate a first attempt that heartbeated and then died (event injection).
    service.events.append('task/started', { runId: result.runId, taskId: 'a', data: { label: 'swarm:a' } })
    service.events.append('task/heartbeat', { runId: result.runId, taskId: 'a', data: { note: 'did half the research, 12 trials verified' } })
    service.events.append('task/failed', { runId: result.runId, taskId: 'a', data: { retry: true, reason: 'boom: stream idle timeout' } })
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'retry spawned')
    const prompt = fake.calls[0]?.prompt.map((p) => p.text).join('\n') ?? ''
    expect(prompt).toContain('Notes from your previous attempt(s)')
    expect(prompt).toContain('did half the research, 12 trials verified')
    expect(prompt).toContain('at least every ~10 minutes')
  })

  it('evidence contract gates completion (missing file fails, passing command closes)', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    // FAIL: the required file does not exist.
    const bad = service.dispatch({
      title: 'evidence fail',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { files: ['definitely-missing-evidence.txt'] } }],
    }, makeDispatcher() as never)
    service.endorse(bad.runId)
    await waitFor(() => service.snapshot().runs.find((r) => r.id === bad.runId)?.status === 'failed', 5000, 'run failed on evidence')
    const a = service.snapshot().tasks.find((t) => t.runId === bad.runId && t.id === 'a')!
    expect(a.lastNote).toMatch(/evidence contract failed/)

    // PASS: a command-based contract that exits 0 (parentless run, process cwd).
    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)
    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')
    const good = service.dispatch({
      title: 'evidence pass',
      spec: 's',
      tasks: [{ id: 'b', subject: 'B', description: 'd', role: 'builder', evidence: { commands: ['node -e "process.exit(0)"'] } }],
    }, undefined)
    service.endorse(good.runId)
    await waitFor(() => service.snapshot().runs.find((r) => r.id === good.runId)?.status === 'completed', 5000, 'evidence pass completes')
  })

  it('human-gated reviews park the task until the dashboard verdict', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const result = service.dispatch({
      title: 'human review demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', reviewBy: 'reviewer', reviewGate: 'human' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    // The child finishes instantly; the task parks for a human verdict.
    await waitFor(() => service.snapshot().tasks.find((t) => t.runId === result.runId && t.id === 'a')?.humanReview === true, 5000, 'human review parked')
    expect(service.snapshot().tasks.find((t) => t.runId === result.runId && t.id === 'a')?.status).toBe('reviewing')

    // Reject sends it back; the rework completes and parks for review again.
    service.review(result.runId, 'a', 'reject')
    await waitFor(() => fake.calls.length >= 2, 5000, 'rework after human reject')
    await waitFor(() => service.snapshot().tasks.find((t) => t.runId === result.runId && t.id === 'a')?.humanReview === true, 5000, 'parked again after rework')

    // Approve closes it.
    service.review(result.runId, 'a', 'approve')
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completes after human approve')
  })

  it('A6: repeated failures rotate the model chain even for non-model errors', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    fake.failOnce = true

    const table = structuredClone(service.duty.get())
    table.roles.builder = {
      ...table.roles.builder,
      provider: 'zai', model: 'glm-5.3',
      fallbacks: [{ provider: 'other', model: 'm2' }],
    }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'rotation demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 2, 5000, 'second attempt spawned')
    // Attempt 1 failed on glm-5.3 (non-model error); attempt 2 rotates to m2.
    expect(fake.calls[0]?.agentOptions?.model).toBe('glm-5.3')
    expect(fake.calls[1]?.agentOptions?.model).toBe('m2')
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completes on rotated model')
  })

  it('rescue path: retry after terminal failure resumes the run, unblocks dependents, and completes', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ maxRetries: 0 })
    contexts.push(ctx)
    dirs.push(dir)
    fake.failOnce = true
    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)

    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'rescue demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder' },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', blockedBy: ['a'] },
      ],
    }, undefined)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'failed', 5000, 'run failed while broken')
    expect(service.snapshot().tasks.find((t) => t.runId === result.runId && t.id === 'b')?.status).toBe('blocked')

    // The fix lands (failOnce consumed) and a human retries the dead task —
    // the run resumes, the dependent unblocks, and everything completes.
    service.retryTask(result.runId, 'a')
    const dumpRescue = (): string => service.events.all()
      .filter((e) => e.runId === result.runId)
      .map((e) => `${e.kind}:${e.taskId ?? ''}`)
      .join(' | ')
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run completes after rescue', dumpRescue)
    const snap = service.snapshot()
    expect(snap.tasks.find((t) => t.runId === result.runId && t.id === 'a')?.status).toBe('completed')
    expect(snap.tasks.find((t) => t.runId === result.runId && t.id === 'b')?.status).toBe('completed')
  })

  it('warns when concurrent tasks declare overlapping write scopes', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    const overlapping = service.dispatch({
      title: 'overlap demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder', writes: ['core.js'] },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', writes: ['core.js', 'ui.js'] },
      ],
    }, makeDispatcher() as never)
    expect(overlapping.warnings?.length).toBe(1)
    expect(overlapping.warnings?.[0]).toContain('both declare write scope over "core.js"')
    service.abort(overlapping.runId) // free the session for the next dispatch

    // A dependency makes the same scopes legal — no warning.
    const chained = service.dispatch({
      title: 'chained demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder', writes: ['core.js'] },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', writes: ['core.js'], blockedBy: ['a'] },
      ],
    }, makeDispatcher() as never)
    expect(chained.warnings).toBeUndefined()

    service.abort(overlapping.runId)
    service.abort(chained.runId)
  })

  it('the watchdog nudges silent running tasks before the stale reclaim', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ nudgeAfterMinutes: 1 })
    contexts.push(ctx)
    dirs.push(dir)
    fake.holdAll = true

    const result = service.dispatch({
      title: 'nudge demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => service.events.all().some((e) => e.kind === 'task/agent-started'), 5000, 'child running')

    // Simulate 21 silent minutes: the nudge fires once. An immediate second
    // sweep inside the same silent window must not re-nudge (dedupe).
    service.watchdog(Date.now() + 21 * 60 * 1000)
    const nudges = () => service.events.all().filter((e) => e.kind === 'task/nudged')
    expect(nudges().length).toBe(1)
    expect((nudges()[0]?.data as { silentMinutes?: number } | undefined)?.silentMinutes).toBeGreaterThanOrEqual(20)
    service.watchdog(Date.now() + 21 * 60 * 1000)
    expect(nudges().length).toBe(1)

    // Release the child; the run completes despite the nudge.
    fake.release()
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completes after release')
  })

  it('injects an architect-review root when enabled and no architect task exists', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ requireArchitectReview: true })
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    const result = service.dispatch({
      title: 'injection demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder', writes: ['x.js'] },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', blockedBy: ['a'] },
      ],
    }, makeDispatcher() as never)

    expect(result.taskCount).toBe(3) // architect-review + the two dispatched tasks
    const tasks = service.snapshot().tasks.filter((t) => t.runId === result.runId)
    const arch = tasks.find((t) => t.id === 'architect-review')!
    expect(arch.role).toBe('architect')
    expect((arch.evidence?.files ?? [])[0]).toMatch(/^PLAN-run-.+\.md$/)
    expect(arch.description).toContain('injection demo')
    expect(arch.description).toContain('REVIEW and REFINE')
    // every dispatched task is gated behind the review, original edges preserved
    expect(tasks.find((t) => t.id === 'a')?.blockedBy).toEqual(['architect-review'])
    expect(tasks.find((t) => t.id === 'b')?.blockedBy).toEqual(['architect-review', 'a'])
    service.abort(result.runId)
  })

  it('architect injection: explicit architect task wins, opt-out respected, missing role degrades to a notice', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ requireArchitectReview: true })
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    // Explicit architect task in the DAG → no injection.
    const explicit = service.dispatch({
      title: 'explicit architect',
      spec: 's',
      tasks: [{ id: 'plan', subject: 'P', description: 'd', role: 'architect' }],
    }, undefined)
    expect(service.snapshot().tasks.filter((t) => t.runId === explicit.runId && t.id === 'architect-review').length).toBe(0)

    // Per-dispatch opt-out → no injection.
    const optedOut = service.dispatch({
      title: 'opt out',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
      architectReview: false,
    }, undefined)
    expect(service.snapshot().tasks.filter((t) => t.runId === optedOut.runId).length).toBe(1)

    // Duty table without an architect role → degraded with a notice, never a throw.
    const originalTable = structuredClone(service.duty.get())
    const table = structuredClone(service.duty.get())
    delete table.roles.architect
    service.setDutyTable(table, 'test')
    const degraded = service.dispatch({
      title: 'no architect role',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, undefined)
    expect(degraded.warnings?.some((w) => w.includes('architect review skipped'))).toBe(true)
    expect(service.snapshot().tasks.filter((t) => t.runId === degraded.runId).length).toBe(1)

    // A dispatched task already owning the id 'architect-review' must not
    // silently cancel the review — the injected root takes a fresh id.
    service.setDutyTable(originalTable, 'restore')
    const collides = service.dispatch({
      title: 'id collision',
      spec: 's',
      tasks: [{ id: 'architect-review', subject: 'mine', description: 'd', role: 'builder' }],
    }, undefined)
    const collisionTasks = service.snapshot().tasks.filter((t) => t.runId === collides.runId)
    const review = collisionTasks.find((t) => t.role === 'architect')!
    expect(review.id).toBe('architect-review-2')
    expect(collisionTasks.find((t) => t.id === 'architect-review')?.blockedBy).toEqual(['architect-review-2'])
  })

  it('warns when a workspace already has an active run, and names overlapping writes', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ workspaceRunPolicy: 'warn' })
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    const first = service.dispatch({
      title: 'first run',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', writes: ['core.js'] }],
    }, makeDispatcher() as never)
    expect(first.warnings).toBeUndefined() // first dispatch in the workspace: clean

    // Different session, same workspace — hits the workspace warning (not the session hard limit).
    const chat2 = {
      id: 'parent-2',
      options: { provider: 'zai', model: 'glm-5.3' },
      session: { header: { id: 'parent-2', cwd: 'D:\\work' } },
      ctx: { get: (): undefined => undefined },
    } as never
    const second = service.dispatch({
      title: 'second run',
      spec: 's',
      tasks: [{ id: 'x', subject: 'X', description: 'd', role: 'builder', writes: ['core.js'] }],
    }, chat2)
    expect(second.warnings?.some((w) => w.includes('already active in this workspace') && w.includes('"core.js"'))).toBe(true)

    // A run in a DIFFERENT workspace is not a sibling.
    const elsewhere = {
      id: 'p2',
      options: { provider: 'zai', model: 'glm-5.3' },
      session: { header: { id: 'p2', cwd: 'D:\\elsewhere' } },
      ctx: { get: (): undefined => undefined },
    } as never
    const third = service.dispatch({ title: 'other workspace', spec: 's', tasks: [{ id: 'y', subject: 'Y', description: 'd', role: 'builder' }] }, elsewhere)
    expect(third.warnings).toBeUndefined()
  })

  it("block policy rejects dispatches that would run beside an active sibling", async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ workspaceRunPolicy: 'block' })
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    service.dispatch({ title: 'first', spec: 's', tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }] }, makeDispatcher() as never)
    // Different session, same workspace — hits the workspace block policy.
    const chat2 = {
      id: 'parent-2',
      options: { provider: 'zai', model: 'glm-5.3' },
      session: { header: { id: 'parent-2', cwd: 'D:\\work' } },
      ctx: { get: (): undefined => undefined },
    } as never
    expect(() => service.dispatch({ title: 'second', spec: 's', tasks: [{ id: 'b', subject: 'B', description: 'd', role: 'builder' }] }, chat2))
      .toThrow(/workspace already has an active run/)
  })

  it('captures the dispatcher session id from the agent object when the header lacks it', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    const parent = {
      id: 'agent-has-id',
      options: { provider: 'zai', model: 'glm-5.3' },
      session: { header: { cwd: 'D:\\work' } }, // header present but no id field
      ctx: { get: (): undefined => undefined },
    } as never
    const result = service.dispatch({ title: 'sid demo', spec: 's', tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }] }, parent)
    const run = service.snapshot().runs.find((r) => r.id === result.runId)!
    expect(run.dispatch?.sessionId).toBe('agent-has-id')
    expect(run.dispatch?.cwd).toBe('D:\\work')
  })

  it('pushes a completion notification into the live dispatching session (P-A)', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    // A dispatching session that is LIVE: agents.get resolves it and it can
    // accept followup messages (that's how the completion push is delivered).
    const followupCalls: string[] = []
    const liveParent = {
      id: 'parent-live',
      options: { provider: 'zai', model: 'glm-5.3' },
      session: { header: { id: 'parent-live', cwd: 'D:\\work' } },
      ctx: { get: (): undefined => undefined },
      followup: (message: unknown): void => { followupCalls.push(JSON.stringify(message)) },
    } as never

    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)
    // FakeAgents.get returns the anchor for anchor ids; the completion push
    // looks up the DISPATCH session id — route it through a spy.
    const originalGet = agents.get.bind(agents)
    ;(agents as unknown as { get: (id: string) => unknown }).get = (id: string): unknown => {
      if (id === 'parent-live') {
        return { followup: (message: unknown): void => { followupCalls.push(JSON.stringify(message)) } }
      }
      return originalGet(id)
    }

    const result = service.dispatch({
      title: 'push demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, liveParent)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completes')
    // The dispatching session received exactly one followup notification
    // naming the run, tagged as a swarm auto-notification.
    expect(followupCalls.length).toBe(1)
    expect(followupCalls[0]).toContain(result.runId)
    expect(followupCalls[0]).toContain('swarm auto-notification')
  })

  it('notification failures are contained and never affect the run', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    // FakeAgents whose anchors ACCEPT followup but the followup throws —
    // proving the push failure is contained without affecting the run.
    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)
    const originalGet = agents.get.bind(agents)
    ;(agents as unknown as { get: (id: string) => unknown }).get = (id: string): unknown => {
      const result = (originalGet as (id: string) => unknown)(id)
      if (result !== undefined && result !== null) {
        return {
          ...result,
          followup: (): void => { throw new Error('inbox exploded') },
        }
      }
      return result
    }

    const result = service.dispatch({
      title: 'contained push demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    // The push throws inside the service, but the run still completes normally.
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 5000, 'run completes despite broken push')
  })

  it('swarm_interrupt aborts a running task and requeues it in the same run (I-1)', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    fake.holdAll = true // child stays running until released

    const result = service.dispatch({
      title: 'interrupt demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder' },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', blockedBy: ['a'] },
      ],
    }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => service.events.all().some((e) => e.kind === 'task/agent-started'), 5000, 'child running')

    // Task 'a' is held (stalled). Interrupt it: it should fail-with-retry and requeue.
    service.interruptTask(result.runId, 'a', undefined)
    const a = service.snapshot().tasks.find((t) => t.runId === result.runId && t.id === 'a')!
    expect(a.status).toBe('retrying')

    // Disable hold so the retry completes normally; release the held original.
    fake.holdAll = false
    fake.release()
    // Wait for the retry + downstream to complete.
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run completes after interrupt + retry')
    const snap = service.snapshot()
    expect(snap.tasks.find((t) => t.id === 'a')?.status).toBe('completed')
    expect(snap.tasks.find((t) => t.id === 'b')?.status).toBe('completed')
  })

  it('swarm_interrupt is gated to the dispatching session', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    fake.holdAll = true

    const result = service.dispatch({
      title: 'interrupt gate demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => service.events.all().some((e) => e.kind === 'task/agent-started'), 5000, 'child running')

    expect(() => service.interruptTask(result.runId, 'a', 'wrong-session')).toThrow(/gated to the dispatching session/)
    service.interruptTask(result.runId, 'a', 'parent-1') // correct session: works
    fake.release()
  })

  it('watchdog escalates after 3 nudges and reclaims the task (I-2)', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ nudgeAfterMinutes: 1, maxRetries: 1 })
    contexts.push(ctx)
    dirs.push(dir)
    fake.holdAll = true

    const result = service.dispatch({
      title: 'escalation demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => service.events.all().some((e) => e.kind === 'task/agent-started'), 5000, 'child running')

    // Simulate escalating silence: 1st nudge, 2nd nudge, 3rd → reclaim.
    service.watchdog(Date.now() + 21 * 60 * 1000)  // nudge 1
    expect(service.events.all().filter((e) => e.kind === 'task/nudged').length).toBe(1)
    expect(service.events.all().filter((e) => e.kind === 'task/failed').length).toBe(0)

    service.watchdog(Date.now() + 42 * 60 * 1000)  // nudge 2 (now - lastNudge > nudgeMs)
    expect(service.events.all().filter((e) => e.kind === 'task/nudged').length).toBe(2)
    expect(service.events.all().filter((e) => e.kind === 'task/failed').length).toBe(0)

    service.watchdog(Date.now() + 63 * 60 * 1000)  // nudge 3 → escalation (reclaim)
    expect(service.events.all().filter((e) => e.kind === 'task/nudged').length).toBe(2) // no new nudge — reclaimed instead
    const failed = service.events.all().filter((e) => e.kind === 'task/failed')
    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect((failed[failed.length - 1]?.data as { reason?: string })?.reason).toMatch(/watchdog escalation/)

    // The task requeues and the fake spawn now succeeds (holdAll still on, but the
    // watchdog-aborted child's controller is done — the requeued spawn will hold too,
    // so release and complete).
    fake.release()
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run completes after escalation')
  })

  it('hard limit: one active run per chat session — sequential dispatches are rejected until the first completes', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ workspaceRunPolicy: 'off' })
    contexts.push(ctx)
    dirs.push(dir)
    fake.holdAll = true

    const dispatcher = makeDispatcher() as never
    const first = service.dispatch({
      title: 'first sequential run',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, dispatcher)
    service.endorse(first.runId)

    // Same chat tries to dispatch a second run while the first is active → REJECTED.
    expect(() => service.dispatch({
      title: 'second sequential run',
      spec: 's',
      tasks: [{ id: 'b', subject: 'B', description: 'd', role: 'builder' }],
    }, dispatcher)).toThrow(/already has an active swarm run.*swarm_wait/)

    // A DIFFERENT chat session can still dispatch (different sessionId).
    const otherChat = {
      id: 'other-session',
      options: { provider: 'zai', model: 'glm-5.3' },
      session: { header: { id: 'other-session', cwd: 'D:\\elsewhere' } },
      ctx: { get: (): undefined => undefined },
    } as never
    const other = service.dispatch({ title: 'other chat run', spec: 's', tasks: [{ id: 'c', subject: 'C', description: 'd', role: 'builder' }] }, otherChat)
    expect(other.runId).toBeDefined()

    // Complete the first run: the same chat can now dispatch again.
    fake.holdAll = false
    fake.release()
    await waitFor(() => service.snapshot().runs.find((r) => r.id === first.runId)?.status === 'completed', 5000, 'first run completes')
    const second = service.dispatch({
      title: 'second sequential run',
      spec: 's',
      tasks: [{ id: 'b', subject: 'B', description: 'd', role: 'builder' }],
    }, dispatcher)
    expect(second.runId).toBeDefined()
    service.abort(second.runId)
    service.abort(other.runId)
  })

  it('hard limit: a parentless dispatch (no sessionId) skips the session check', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    void fake

    // No parent → no sessionId → the session guard can't check → dispatch succeeds.
    const first = service.dispatch({ title: 'parentless 1', spec: 's', tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }] }, undefined)
    expect(first.runId).toBeDefined()
    const second = service.dispatch({ title: 'parentless 2', spec: 's', tasks: [{ id: 'b', subject: 'B', description: 'd', role: 'builder' }] }, undefined)
    expect(second.runId).toBeDefined()
    service.abort(first.runId)
    service.abort(second.runId)
  })

  it('H-1 retry backoff: a failed task waits before retrying, not immediately', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({ retryBackoffBaseMs: 3000 })
    contexts.push(ctx)
    dirs.push(dir)
    fake.failOnce = true // first attempt fails, second succeeds

    const result = service.dispatch({
      title: 'backoff demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    // First attempt fails (failOnce).
    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'a')?.status === 'retrying', 5000, 'first failure')

    // The retry should NOT fire immediately — the backoff window is 3s.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(fake.calls.length).toBe(1) // only the first (failed) spawn

    // After the backoff, the retry fires and completes.
    await waitFor(() => fake.calls.length >= 2, 10000, 'retry after backoff')
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run completes after backoff')
  }, 20000)

  it('H-2 circuit breaker with non-quota errors: 3 failures pause retries, cooldown resumes', async () => {
    const { ctx, service, fake, dir } = await bootSwarm({
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 1500,
      retryBackoffBaseMs: 200, // small backoff: gives the breaker time to trip
      maxRetries: 3,
    })
    contexts.push(ctx)
    dirs.push(dir)

    fake.unavailableCount = 100 // all spawns throw (provider class)

    const result = service.dispatch({
      title: 'breaker non-quota demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder' },
        { id: 'b', subject: 'B', description: 'd', role: 'builder' },
        { id: 'c', subject: 'C', description: 'd', role: 'builder' },
      ],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    // Wait for the breaker to trip (3 failures recorded).
    await waitFor(() => {
      const failures = service.events.all().filter((e) => e.kind === 'task/failed' && e.runId === result.runId)
      return failures.length >= 3
    }, 5000, 'breaker threshold reached')

    // While the breaker is open, no new spawns for 300ms.
    const callCountAfterBreaker = fake.calls.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fake.calls.length).toBe(callCountAfterBreaker)

    // After the 1.5s cooldown, the breaker closes and retries resume.
    fake.unavailableCount = 0 // subsequent spawns succeed
    await waitFor(() => fake.calls.length > callCountAfterBreaker, 8000, 'retries resume after cooldown')
    service.abort(result.runId)
  }, 15000)
})
