import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'
import { SwarmService, sanitizeToolNames } from '../src/service.js'
import { FAST_FAILURE_MS, isUnsupportedEffortError } from '../src/dispatch/spawn.js'

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
  /**
   * When true, a held child ALSO settles as soon as its caller's AbortSignal fires.
   * Opt-in because it changes when a requeued spawn happens: the real provider does
   * settle on abort, and the J8 spawn-ceiling test depends on that. Left off by
   * default so the watchdog/interrupt tests keep their original timing.
   */
  abortAware = false
  /** Capture the cancellation signal each held spawn was given (J8 spawn ceiling). */
  readonly signals: Array<AbortSignal | undefined> = []
  /** Throw a quota-class error for this many upcoming calls (A3). */
  quotaCount = 0
  /** Throw a provider-class error on the first call only (A6 rotation). */
  failOnce = false
  /**
   * J22: invoked immediately before `failOnce` throws. A test that needs a file to
   * exist when the child dies writes it here rather than before `dispatch`, so the
   * file is created DURING the attempt — which is what production looks like, since
   * the child writes its report as its final action. Writing it earlier would make
   * it indistinguishable from a stale report left by a previous run.
   */
  beforeFail?: (call: StartCall) => void
  /** Throw the real depth-guard error, as the provider does when maxDepth is exceeded (J14). */
  throwDepthError = false
  /**
   * J18: model an effort-restricted provider. When set, a child carrying a
   * reasoning-effort pin FAILS the turn with the provider's error — what the real
   * `zai/glm-5.3` does — while an unpinned child succeeds.
   */
  effortRestricted = false
  /**
   * A1: scripted FAILURE outcome by start-call index — the child settles with this
   * stopReason/output/diagnostic instead of completing. Lets a test model the two
   * failure shapes the effort ladder judges: a fast, output-less death (a
   * request-level rejection) and a death that produced work first.
   */
  failScript: Record<number, { stopReason?: string; output?: Array<{ type: string; text: string }>; diagnostic?: string }> = {}
  service?: SwarmService
  /** How many children failed because an effort was pinned. */
  effortErrorCount = 0
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
      this.beforeFail?.(call)
      throw new Error('boom: stream idle timeout')
    }
    if (this.throwDepthError) {
      // Mirror @deepseek-ai/dsh-subagent's SubagentDepthError wording (J14).
      throw new Error('subagent depth 2 exceeds maxDepth 1')
    }
    this.n += 1
    const id = `sess-${this.n}`
    const text = this.script[index] ?? `finished ${call.label ?? 'task'}\nVERDICT: APPROVE`
    const output = [{ type: 'text', text }]
    const scripted = this.failScript[index]
    const settleWith = scripted === undefined
      ? { stopReason: 'completed', output }
      : {
          stopReason: scripted.stopReason ?? 'error',
          output: scripted.output ?? [],
          ...(scripted.diagnostic !== undefined ? { diagnostic: scripted.diagnostic } : {}),
        }
    if (this.effortRestricted && this.effortErrorCount < 1) {
      // The provider rejects a request while an effort pin is in force. The service
      // registers a child's pin AFTER start() returns, so the fake cannot read it
      // directly; instead it fails a FIXED number of times. If the service drops the
      // pin (J18) the second spawn succeeds and the counts below stay at 1 and 2 —
      // if it did NOT, the retry would fail too and `calls === 2` would catch the
      // resulting retry loop.
      this.effortErrorCount += 1
      return {
        id,
        result: Promise.resolve({
          stopReason: 'error',
          output: [],
          diagnostic: 'provider "zai" model "glm-5.3" does not support reasoning effort "max"',
        }),
        dispose: async () => {},
      }
    }
    if (this.holdAll) {
      // A1: a held child settles with its scripted failure when one exists, so a
      // test can advance the clock and then let it die without producing output.
      let resolveResult!: (value: typeof settleWith) => void
      const result = new Promise<typeof settleWith>((resolve) => { resolveResult = resolve })
      this.held.push(() => { resolveResult(settleWith) })
      const signal = (request as unknown as { signal?: AbortSignal }).signal
      this.signals.push(signal)
      if (this.abortAware) {
        // The real provider settles a cancelled child; if the caller's signal is
        // already aborted it must not resolve as a successful completion.
        let settled = false
        const settleAborted = (): void => {
          if (settled) return
          settled = true
          resolveResult({ stopReason: 'aborted', output })
        }
        if (signal?.aborted === true) settleAborted()
        else signal?.addEventListener('abort', settleAborted, { once: true })
      }
      return { id, result, dispose: async () => {} }
    }
    return {
      id,
      result: Promise.resolve(settleWith),
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
function makeDispatcher(cwd = 'D:\\work'): unknown {
  return {
    id: 'parent-1',
    options: { provider: 'zai', model: 'glm-5.3' },
    session: { header: { id: 'parent-1', cwd } },
    ctx: {
      get: (name: string): unknown =>
        name === 'agentPresets' ? { composedPreset: () => 'standard' } : undefined,
    },
  }
}

/**
 * A1: `effortRungs` is pure (role + attempt number) and private, so the ladder's
 * SHAPE is asserted directly off the prototype — the rung order IS the contract,
 * and inferring it from spawn counts would not pin it.
 */
function rungsFor(role: { reasoningEffort?: string; effortFallbacks?: string[] }, attemptNumber: number): Array<string | undefined> {
  const probe = SwarmService.prototype as unknown as {
    effortRungs(role: unknown, attemptNumber: number): Array<string | undefined>
  }
  return probe.effortRungs(role, attemptNumber)
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
  // J21: the effort preflight reads `$DSH_HOME/settings.yaml`. Point it at a fixture
  // deployment for every boot, so these tests neither depend on (nor are fooled by)
  // the developer's real settings — and so the pinning tests run against a deployment
  // that actually DECLARES the levels they pin. One fixture per boot, registered in
  // `dirs`, so the afterEach cleanup can never leave a later test reading a deleted file.
  process.env.DSH_HOME = effortSettingsHome ?? makeSettingsHome(DECLARING_SETTINGS)
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
    // Match production's boot grace so the readiness poll behaves as deployed.
    bootGraceSeconds: 3,
    ...overrides,
  })
  // ctx.get returns a traceable proxy; unwrap to the raw service via symbols.original
  const traced = ctx.get('swarm') as Record<symbol, unknown> | undefined
  if (traced === undefined) throw new Error('swarm service not registered after plugin load')
  const service = traced[Symbol.for('cordis.original')] as SwarmService | undefined
  if (service === undefined) throw new Error('swarm service could not be unwrapped from trace proxy')
  return { ctx, service, fake, dir }
}

const dirs: string[] = []
const contexts: Context[] = []

/**
 * The settings.yaml fixture a booted service reads for its J21 effort preflight
 * (`$DSH_HOME/settings.yaml`). It declares exactly the levels these tests pin: a
 * real deployment must declare `reasoningEfforts` for a pin to be legal at all,
 * because pi-ai refuses any explicit level on a hand-declared model that has no map.
 * `glm-5.3-air` is deliberately map-less — the production mimo shape — so the
 * review-path strip tests have an effort-incapable pi-ai model to pin against.
 */
const DECLARING_SETTINGS = [
  'llm-pi-ai:',
  '  providers:',
  '    zai:',
  '      models:',
  '        - id: glm-5.3',
  '          reasoningEfforts:',
  '            max: max',
  '            high: high',
  '        - id: glm-5.3-flash',
  '          reasoningEfforts:',
  '            max: max',
  '        - id: glm-5.3-air',
  'llm-deepseek:',
  '  models:',
  '    - id: deepseek-flash',
].join('\n')

/** The production shape: hand-declared pi-ai models with NO reasoningEfforts map. */
const UNDECLARED_SETTINGS = [
  'llm-pi-ai:',
  '  providers:',
  '    zai:',
  '      models:',
  '        - id: glm-5.3',
  '        - id: glm-5.3-flash',
].join('\n')

/** A deployment that declares one level only — the `max` pin must be stripped. */
const HIGH_ONLY_SETTINGS = [
  'llm-pi-ai:',
  '  providers:',
  '    zai:',
  '      models:',
  '        - id: glm-5.3',
  '          reasoningEfforts:',
  '            high: high',
].join('\n')

/** The fixture the NEXT booted service reads; `undefined` = the declaring default. */
let effortSettingsHome: string | undefined

function makeSettingsHome(settingsYaml: string): string {
  const home = mkdtempSync(join(tmpdir(), 'swarm-settings-'))
  writeFileSync(join(home, 'settings.yaml'), settingsYaml)
  dirs.push(home)
  return home
}

describe('swarm service (integration, fake subagents)', () => {

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

  it('J17: a reviewer with no usable verdict completes fail-open but is COUNTED and marked', async () => {
    // Caught by the live end-to-end audit: the reviewer emitted no "VERDICT:" line,
    // the task completed fail-open, and the run report showed reviewsPassed=0 with
    // nothing to distinguish that from a clean pass.
    //
    // Item 8 added one re-ask before the fail-open — so BOTH reviewer passes must
    // refuse to give a verdict for this test to exercise the fail-open path.
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')

    // The reviewer's output carries no verdict at all — and neither does the re-ask.
    fake.script = { 1: 'looks fine to me, nothing to add', 2: 'still no explicit verdict here' }

    const result = service.dispatch({
      title: 'fail-open review',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', reviewBy: 'reviewer' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run completes fail-open')

    const run = service.snapshot().runs.find((r) => r.id === result.runId)!
    // The task still passes (deliberate fail-open)…
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.status).toBe('completed')
    // …but the skipped review is now visible in three places.
    expect(run.stats?.reviewsUnavailable).toBe(1)
    expect(run.stats?.reviewsPassed).toBe(0)
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.reviewUnavailable).toBe(true)
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.reviewed).toBe(false)
    // Item 8: the reviewer was re-asked once before the fail-open.
    expect(fake.calls.length).toBe(3)
  })

  it('Item 8: a reviewer that forgets the verdict is re-asked once, then recorded', async () => {
    // The overnight StockSelector run failed W00's review open because the
    // reviewer wrote a long assessment and no verdict line. Item 8 gives the
    // reviewer one explicit re-ask; when it then produces the line, the review
    // is recorded as a real pass instead of a fail-open.
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')

    fake.script = { 1: 'looks fine to me, nothing to add', 2: 'VERDICT: APPROVE' }

    const result = service.dispatch({
      title: 're-ask review',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', reviewBy: 'reviewer' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run completes with the re-asked verdict')

    const run = service.snapshot().runs.find((r) => r.id === result.runId)!
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.status).toBe('completed')
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.reviewed).toBe(true)
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.reviewUnavailable).toBeUndefined()
    expect(run.stats?.reviewsPassed).toBe(1)
    expect(run.stats?.reviewsUnavailable).toBe(0)
    expect(fake.calls.length).toBe(3)
  })

  it('J18: an unsupported reasoning effort is detected', () => {
    expect(isUnsupportedEffortError('provider "zai" model "glm-5.3" does not support reasoning effort "max"')).toBe(true)
    expect(isUnsupportedEffortError('UNSUPPORTED_REASONING_EFFORT')).toBe(true)
    expect(isUnsupportedEffortError('child stopped: error')).toBe(false)
    expect(isUnsupportedEffortError(undefined)).toBe(false)
  })

  it('J18 END-TO-END: a model that rejects the effort pin no longer fails the run', async () => {
    // Reproduces the "Stock Selector Audit and Update" failure exactly: the role
    // pinned reasoningEffort "max", the fallback model zai/glm-5.3 does not support
    // it, every task died ~1s in, and all 6 tasks failed in one second.
    const { service, fake, dir } = await bootRunnable()
    fake.effortRestricted = true
    fake.service = service

    const result = service.dispatch({
      title: 'effort mismatch',
      spec: 's',
      tasks: [{ id: 'e1', subject: 'E', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed',
      10000,
      'run completed after degrading the effort pin',
      () => 'calls=' + fake.calls.length + ' effortErrs=' + fake.effortErrorCount +
        ' tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, String(t.lastNote ?? '').slice(0, 130)])),
    )
    // The effort error fired exactly once: the retry ran without the pin and
    // completed, instead of looping or failing the run.
    expect(fake.effortErrorCount).toBe(1)
    // Two spawns: the degraded first attempt, then the successful retry.
    expect(fake.calls.length).toBe(2)
    expect(service.snapshot().tasks.find((t) => t.id === 'e1')?.status).toBe('completed')
  }, 20000)

  it('J18 END-TO-END: the effort error degrades exactly once, then the task proceeds', async () => {
    const { service, fake, dir } = await bootRunnable()
    fake.effortRestricted = true
    fake.service = service

    const result = service.dispatch({
      title: 'effort drop bookkeeping',
      spec: 's',
      tasks: [{ id: 'e2', subject: 'E', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed',
      10000,
      'task completes after one effort degradation',
    )
    // Exactly one effort rejection; the retry without the pin succeeded.
    expect(fake.effortErrorCount).toBe(1)
    expect(fake.calls.length).toBe(2)
  }, 20000)

  // ── J21: preflight effort validation ─────────────────────────────────────
  // ── A1: the effort ladder — effort varies fastest, before the model chain ──
  it('A1: the ladder always ends at an unpinned rung', () => {
    // The production shape that started this: primary unset with a single
    // fallback rung used to collapse to ['max'], pinning max on EVERY attempt and
    // EVERY model — a ladder that could never descend.
    expect(rungsFor({ effortFallbacks: ['max'] }, 1)).toEqual(['max', undefined])
    expect(rungsFor({ effortFallbacks: ['max'] }, 2)).toEqual([undefined])
    expect(rungsFor({}, 1)).toEqual([undefined])
    expect(rungsFor({ reasoningEffort: 'max' }, 1)).toEqual(['max', undefined])
    expect(rungsFor({ reasoningEffort: 'max', effortFallbacks: ['high'] }, 2)).toEqual(['high', undefined])
    expect(rungsFor({ reasoningEffort: 'max', effortFallbacks: ['high'] }, 3)).toEqual([undefined])
    // Consecutive duplicates would spend a whole child on an identical request.
    expect(rungsFor({ reasoningEffort: 'max', effortFallbacks: ['max'] }, 1)).toEqual(['max', undefined])
  })

  it('A1: a fast output-less failure retries the SAME model without the pin', async () => {
    const { service, fake, dir } = await bootEffortLadder()
    fake.holdAll = true
    // The production death: stopReason error, no diagnostic, no output, 42 ms.
    fake.failScript[0] = { stopReason: 'error', output: [] }

    const result = service.dispatch({
      title: 'effort ladder',
      spec: 's',
      tasks: [{ id: 'l1', subject: 'L', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => service.effortFor('sess-1') === 'max', 5000, 'first child pinned at max')
    fake.release()

    await waitFor(() => fake.calls.length === 2, 5000, 'the ladder retried without rotating models')
    // Same route as the first child, and the retry carries no pin.
    expect(fake.calls[1].agentOptions).toEqual(fake.calls[0].agentOptions)
    expect(service.effortFor('sess-2')).toBeUndefined()

    fake.release()
    await waitFor(
      () => service.snapshot().tasks.find((t) => t.id === 'l1')?.status === 'completed',
      10000,
      'task completed on the unpinned rung',
      () => 'calls=' + fake.calls.length + ' tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, t.agent])),
    )
    expect(fake.calls.length).toBe(2)
  }, 20000)

  it('A1: a failure that produced output is not effort-suspect (no rung burned)', async () => {
    const { service, fake, dir } = await bootEffortLadder({ maxRetries: 0 })
    // The child ran, said something, then died: a real task failure, not a
    // request-level rejection, so the pin is not what failed.
    fake.failScript[0] = {
      stopReason: 'error',
      output: [{ type: 'text', text: 'partial work before dying' }],
      diagnostic: 'child stopped: error',
    }

    const result = service.dispatch({
      title: 'no rung on a real failure',
      spec: 's',
      tasks: [{ id: 'l2', subject: 'L', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'l2')?.status === 'failed', 10000, 'task failed normally')
    expect(fake.calls.length).toBe(1)
  }, 20000)

  it('A1: a slow output-less failure is not effort-suspect either (time arm)', async () => {
    const { service, fake, dir } = await bootEffortLadder({ maxRetries: 0 })
    fake.holdAll = true
    fake.failScript[0] = { stopReason: 'error', output: [] }
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const result = service.dispatch({
        title: 'slow failure',
        spec: 's',
        tasks: [{ id: 'l3', subject: 'L', description: 'd', role: 'builder' }],
      }, makeDispatcher(dir) as never)
      service.endorse(result.runId)

      await waitFor(() => fake.calls.length === 1, 5000, 'child started')
      // The child was alive well past the fast-failure window before it died.
      vi.setSystemTime(new Date(Date.now() + FAST_FAILURE_MS + 1000))
      fake.release()

      await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'l3')?.status === 'failed', 10000, 'task failed without a rung retry')
      expect(fake.calls.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('A1: the rung retry consumes no task retry budget and no A6 rotation', async () => {
    // maxRetries 2, so a genuine failure WOULD be retried: this proves the
    // internal retry is invisible to the task's own accounting.
    const { service, fake, dir } = await bootEffortLadder({ maxRetries: 2 })
    fake.holdAll = true
    fake.failScript[0] = { stopReason: 'error', output: [] }

    const result = service.dispatch({
      title: 'retry budget',
      spec: 's',
      tasks: [{ id: 'l4', subject: 'L', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => service.effortFor('sess-1') === 'max', 5000, 'first child pinned')
    fake.release()
    await waitFor(() => fake.calls.length === 2, 5000, 'rung retry started')
    // Mid-flight, between the two children: still one attempt, one task/started.
    expect(service.snapshot().tasks.find((t) => t.id === 'l4')?.attempts).toBe(1)
    expect(service.events.all().filter((e) => e.kind === 'task/started' && e.taskId === 'l4').length).toBe(1)

    fake.release()
    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'l4')?.status === 'completed', 10000, 'task completed')
    expect(fake.calls.length).toBe(2)
    expect(service.snapshot().tasks.find((t) => t.id === 'l4')?.attempts).toBe(1)
    expect(service.events.all().filter((e) => e.kind === 'task/started' && e.taskId === 'l4').length).toBe(1)
  }, 20000)

  it('A1: the pinned effort is recorded on task/started and survives projection', async () => {
    const { service, fake, dir } = await bootEffortLadder()
    const result = service.dispatch({
      title: 'effort on the board',
      spec: 's',
      tasks: [{ id: 'l5', subject: 'L', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'l5')?.status === 'completed', 10000, 'task completed')
    // The pin is on the event (the durable record) AND on the projected task (the
    // board) — this is what made the 42 ms death diagnosable only from provider logs.
    expect(service.events.all().find((e) => e.kind === 'task/started' && e.taskId === 'l5')?.data?.effort).toBe('max')
    expect(service.snapshot().tasks.find((t) => t.id === 'l5')?.agent?.effort).toBe('max')
    expect(fake.calls.length).toBe(1)
  }, 20000)

  it('J21: checkEffortSupport flags a declared model without an efforts map', async () => {
    const { parseEffortSupport, checkEffortSupport } = await import('../src/preflight.js')
    const settings = [
      'llm-pi-ai:',
      '  providers:',
      '    zai:',
      '      models:',
      '        - id: glm-5.3-flash',
      '          reasoningEfforts:',
      '            max: max',
      '        - id: glm-5.3',
    ].join('\n')
    const support = parseEffortSupport(settings)
    expect(support.supported.has('glm-5.3-flash')).toBe(true)
    expect(support.declaredWithoutMap.has('glm-5.3')).toBe(true)
    // The exact production mismatch: max pinned on glm-5.3.
    const check = checkEffortSupport('glm-5.3', 'max', support)
    expect(check.incompatible).toBe(true)
    expect(check.warning).toMatch(/glm-5\.3/)
  })

  it('J21: a model with no declaration is not judged', async () => {
    const { parseEffortSupport, checkEffortSupport } = await import('../src/preflight.js')
    // deepseek models declare no effort maps but accept efforts.
    const settings = 'llm-deepseek:\n  models:\n    - id: deepseek-v4-flash\n'
    const support = parseEffortSupport(settings)
    expect(checkEffortSupport('deepseek-v4-flash', 'max', support).incompatible).toBe(false)
  })

  it('J21: an unreadable settings file yields no declarations, so no warnings', async () => {
    const { parseEffortSupport, checkEffortSupport } = await import('../src/preflight.js')
    const support = parseEffortSupport('')
    expect(support.supported.size).toBe(0)
    expect(support.declaredWithoutMap.size).toBe(0)
    expect(checkEffortSupport('anything', 'max', support).incompatible).toBe(false)
  })

  it('J21: the parser records which levels a map declares, and only those', async () => {
    const { parseEffortSupport, checkEffortSupport } = await import('../src/preflight.js')
    const settings = [
      'llm-pi-ai:',
      '  providers:',
      '    zai:',
      '      models:',
      '        - id: glm-5.3',
      '          reasoningEfforts:',
      '            low: low',
      '            high: high',
      '          contextWindow: 1000000',
      '        - id: glm-5.3-flash',
    ].join('\n')
    const support = parseEffortSupport(settings)
    // The level keys belong to the declaring model, and the block ends at the next
    // sibling field — `contextWindow` is not a reasoning level.
    expect([...(support.declaredLevels.get('glm-5.3') ?? [])].sort()).toEqual(['high', 'low'])
    expect(checkEffortSupport('glm-5.3', 'high', support).incompatible).toBe(false)
    const denied = checkEffortSupport('glm-5.3', 'max', support)
    expect(denied.incompatible).toBe(true)
    // The warning names the levels the model does declare, so the fix is obvious.
    expect(denied.warning).toMatch(/high, low/)
    // A model in the same file with no map is refused at every explicit level.
    expect(checkEffortSupport('glm-5.3-flash', 'max', support).incompatible).toBe(true)
  })

  it('J21: an undeclared pi-ai model gets the pin stripped, and keeps its place in the chain', async () => {
    // The production shape (xiaomi/mimo-v2.6-pro, 2026-09-23): hand-declared under
    // llm-pi-ai with no reasoningEfforts map. The old parser judged such a file not at
    // all, so the pin went out and the child died 41 ms after agent-started.
    effortSettingsHome = makeSettingsHome(UNDECLARED_SETTINGS)
    try {
      const { service, fake, dir } = await bootEffortLadder()
      const result = service.dispatch({
        title: 'undeclared effort',
        spec: 's',
        tasks: [{ id: 'u1', subject: 'U', description: 'd', role: 'builder' }],
      }, makeDispatcher(dir) as never)
      service.endorse(result.runId)

      await waitFor(
        () => service.snapshot().tasks.find((t) => t.id === 'u1')?.status === 'completed',
        10000,
        'task completed without a pin',
      )
      // No pin anywhere: not on the durable event, not on the board.
      expect(service.events.all().find((e) => e.kind === 'task/started' && e.taskId === 'u1')?.data?.effort).toBeUndefined()
      expect(service.snapshot().tasks.find((t) => t.id === 'u1')?.agent?.effort).toBeUndefined()
      // The MODEL was not dropped with the pin: the attempt ran on the role's model,
      // once, with no rung retry (every rung would be refused by the same model).
      expect(fake.calls.length).toBe(1)
      expect(fake.calls[0].agentOptions?.model).toBe('glm-5.3')
    } finally {
      effortSettingsHome = undefined
    }
  }, 20000)

  it('J21: a model declaring only "high" has a "max" pin stripped', async () => {
    effortSettingsHome = makeSettingsHome(HIGH_ONLY_SETTINGS)
    try {
      const { service, fake, dir } = await bootEffortLadder()
      const result = service.dispatch({
        title: 'undeclared level',
        spec: 's',
        tasks: [{ id: 'u2', subject: 'U', description: 'd', role: 'builder' }],
      }, makeDispatcher(dir) as never)
      service.endorse(result.runId)

      await waitFor(
        () => service.snapshot().tasks.find((t) => t.id === 'u2')?.status === 'completed',
        10000,
        'task completed without the max pin',
      )
      expect(service.events.all().find((e) => e.kind === 'task/started' && e.taskId === 'u2')?.data?.effort).toBeUndefined()
      expect(fake.calls.length).toBe(1)
      expect(fake.calls[0].agentOptions?.model).toBe('glm-5.3')
    } finally {
      effortSettingsHome = undefined
    }
  }, 20000)

  it('J21: a declared level is pinned exactly as configured', async () => {
    effortSettingsHome = makeSettingsHome(HIGH_ONLY_SETTINGS)
    try {
      const { service, fake, dir } = await bootRunnable()
      const table = structuredClone(service.duty.get())
      table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' }
      service.setDutyTable(table, 'test')

      const result = service.dispatch({
        title: 'declared level',
        spec: 's',
        tasks: [{ id: 'u3', subject: 'U', description: 'd', role: 'builder' }],
      }, makeDispatcher(dir) as never)
      service.endorse(result.runId)

      await waitFor(
        () => service.snapshot().tasks.find((t) => t.id === 'u3')?.status === 'completed',
        10000,
        'task completed with its declared pin',
      )
      // The fix must not over-reach: a level the model declares still goes out.
      expect(service.events.all().find((e) => e.kind === 'task/started' && e.taskId === 'u3')?.data?.effort).toBe('high')
      expect(fake.calls.length).toBe(1)
    } finally {
      effortSettingsHome = undefined
    }
  }, 20000)

  it('J21: a model outside the validating roots keeps its pin (deepseek adapter)', async () => {
    // This is why the same pin survived on deepseek-flash while every pi-ai child
    // died: `llm-deepseek` declares no maps and accepts efforts, so nothing is judged.
    const { service, fake, dir } = await bootRunnable()
    const table = structuredClone(service.duty.get())
    table.roles.builder = {
      ...table.roles.builder, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
    }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'unjudged model',
      spec: 's',
      tasks: [{ id: 'u4', subject: 'U', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().tasks.find((t) => t.id === 'u4')?.status === 'completed',
      10000,
      'task completed with its pin intact',
    )
    expect(service.events.all().find((e) => e.kind === 'task/started' && e.taskId === 'u4')?.data?.effort).toBe('max')
    expect(fake.calls.length).toBe(1)
  }, 20000)

  // ── J21 (review paths): the reviewer's pin goes through the same strip ─────
  // The review spawns pinned `reviewerRole.reasoningEffort` RAW — bypassing the
  // preflight entirely — so a role with a pin whose reviewer ran on a map-less
  // pi-ai model (the production mimo shape, fixture model glm-5.3-air) died the
  // 41 ms death with no strip and no ladder to catch it. The spy records the pin
  // at the exact call site the fix changes, so there is no timing window: the
  // value is captured when the child is registered, not polled afterwards
  // (`forgetChildSession` deletes it the moment the review spawn resolves).
  function spyPins(service: SwarmService): Array<{ child: string; effort?: string }> {
    const pins: Array<{ child: string; effort?: string }> = []
    const anyService = service as unknown as {
      trackChildSession: (id: string, taskKey: string, effort?: string, attemptId?: string) => void
    }
    const original = anyService.trackChildSession.bind(service)
    anyService.trackChildSession = (id, taskKey, effort, attemptId) => {
      pins.push({ child: id, effort })
      original(id, taskKey, effort, attemptId)
    }
    return pins
  }

  it('J21: a reviewer pinned on a map-less pi-ai model gets the pin stripped, and the review still completes', async () => {
    const { service, fake, dir } = await bootRunnable()
    const pins = spyPins(service)
    const table = structuredClone(service.duty.get())
    table.roles.reviewer = { ...table.roles.reviewer, provider: 'zai', model: 'glm-5.3-air', reasoningEffort: 'max' }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'reviewer strip',
      spec: 's',
      tasks: [{ id: 'r1', subject: 'R', description: 'd', role: 'builder', reviewBy: 'reviewer' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().tasks.find((t) => t.id === 'r1')?.status === 'completed',
      10000,
      'task completed with a stripped reviewer pin',
    )
    // call 0 = builder (sess-1, unpinned), call 1 = reviewer (sess-2).
    expect(fake.calls[1]?.agentOptions?.model).toBe('glm-5.3-air')
    expect(pins.find((p) => p.child === 'sess-2')?.effort).toBeUndefined()
    expect(service.snapshot().tasks.find((t) => t.id === 'r1')?.reviewed).toBe(true)
  }, 20000)

  it('J21: a reviewer pinned to a DECLARED level keeps the pin', async () => {
    const { service, fake, dir } = await bootRunnable()
    const pins = spyPins(service)
    const table = structuredClone(service.duty.get())
    // glm-5.3 declares max and high in the fixture, so this pin is legal.
    table.roles.reviewer = { ...table.roles.reviewer, provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'reviewer keep',
      spec: 's',
      tasks: [{ id: 'r2', subject: 'R', description: 'd', role: 'builder', reviewBy: 'reviewer' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().tasks.find((t) => t.id === 'r2')?.status === 'completed',
      10000,
      'task completed with the reviewer pin kept',
    )
    expect(fake.calls[1]?.agentOptions?.model).toBe('glm-5.3')
    expect(pins.find((p) => p.child === 'sess-2')?.effort).toBe('max')
  }, 20000)

  it('J21: the reviewer re-ask spawn gets the same strip', async () => {
    const { service, fake, dir } = await bootRunnable()
    const pins = spyPins(service)
    const table = structuredClone(service.duty.get())
    table.roles.reviewer = { ...table.roles.reviewer, provider: 'zai', model: 'glm-5.3-air', reasoningEffort: 'high' }
    service.setDutyTable(table, 'test')
    // The reviewer forgets the verdict line on the first pass; the 0.6.9 re-ask
    // (the SECOND review spawn site) then supplies it.
    fake.script = { 1: 'a long assessment with no verdict line at all', 2: 'VERDICT: APPROVE' }

    const result = service.dispatch({
      title: 'reviewer re-ask strip',
      spec: 's',
      tasks: [{ id: 'r3', subject: 'R', description: 'd', role: 'builder', reviewBy: 'reviewer' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().tasks.find((t) => t.id === 'r3')?.status === 'completed',
      10000,
      'task completed after the re-ask',
    )
    expect(fake.calls.length).toBe(3) // builder + reviewer + re-ask
    expect(pins.find((p) => p.child === 'sess-2')?.effort).toBeUndefined()
    expect(pins.find((p) => p.child === 'sess-3')?.effort).toBeUndefined()
    expect(service.snapshot().tasks.find((t) => t.id === 'r3')?.reviewed).toBe(true)
  }, 20000)

  it('swarm_report authenticates tracked child sessions only', async () => {
    const { service, fake } = await bootRunnable()

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

  it('evidence contract: missing files are advisory warnings on the board, not hard failures', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    // ADVISORY: the required file does not exist — task completes with a warning (P5).
    const bad = service.dispatch({
      title: 'evidence advisory',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { files: ['definitely-missing-evidence.txt'] } }],
    }, makeDispatcher() as never)
    service.endorse(bad.runId)
    await waitFor(() => service.snapshot().runs.find((r) => r.id === bad.runId)?.status === 'completed', 5000, 'run completes on evidence warning')
    const a = service.snapshot().tasks.find((t) => t.runId === bad.runId && t.id === 'a')!
    expect(a.status).toBe('completed')

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
    //
    // Wait for the RETRY's spawn before releasing: release() drains the held list
    // with splice(0), so a child pushed to held AFTER release has already run would
    // never settle and the run would hang forever. This ordering matters — release
    // must happen only once every child we intend to complete is already in the
    // queue.
    await waitFor(() => fake.calls.length >= 2, 8000, 'retry spawned')
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

  /**
   * Boot a swarm with the builder role pinned so dispatches can actually spawn.
   * Mirrors the setup used by the core dispatch test; without a pinned role (or
   * a captured run route) `resolveCandidates` returns undefined and nothing runs.
   */
  async function bootRunnable(overrides: Record<string, unknown> = {}): Promise<{ service: SwarmService; fake: FakeSubagents; dir: string }> {
    const { ctx, service, fake, dir } = await bootSwarm(overrides)
    contexts.push(ctx)
    dirs.push(dir)
    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
    service.setDutyTable(table, 'test')
    return { service, fake, dir }
  }

  /**
   * A1: the builder role in the production ladder shape — the primary effort
   * UNSET with `effortFallbacks: ['max']`, which is what collapsed to a permanent
   * `max` pin on every model (seq 3913-3915).
   */
  async function bootEffortLadder(overrides: Record<string, unknown> = {}): Promise<{ service: SwarmService; fake: FakeSubagents; dir: string }> {
    const booted = await bootRunnable(overrides)
    const table = structuredClone(booted.service.duty.get())
    const builder: Record<string, unknown> = {
      ...table.roles.builder, provider: 'zai', model: 'glm-5.3', effortFallbacks: ['max'],
    }
    delete builder.reasoningEffort
    table.roles.builder = builder as never
    booted.service.setDutyTable(table, 'test')
    return booted
  }

  // ── J6: orphan recovery must not re-fail tasks of a terminal run ──────────
  // Production evidence: run-mtvrocbe-tns8 was aborted, yet its task
  // vhp-cryo-embed was re-failed 13 times over 21.5h ("host restarted
  // mid-flight"). `fold` ignores task transitions on terminal runs, so each
  // event was a no-op that left the task `running` for the next boot to fail
  // again — inflating failure counts and never reaching a terminal state.
  it('J6: recoverOrphans skips tasks whose run is not running (no ghost re-fails)', async () => {
    const { service, fake } = await bootRunnable()

    fake.holdAll = true

    const result = service.dispatch({
      title: 'zombie guard',
      spec: 's',
      tasks: [{ id: 'z1', subject: 'Z', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    // Wait until the task is genuinely mid-flight (running), still held.
    const seen: string[] = []
    await waitFor(
      () => {
        const t = service.snapshot().tasks.find((x) => x.id === 'z1')
        const tag = `${t?.status ?? 'none'}|ev=${service.events.all().filter((e) => e.taskId === 'z1').map((e) => e.kind.replace('task/', '')).join(',')}`
        if (seen[seen.length - 1] !== tag) seen.push(tag)
        return t?.status === 'running'
      },
      5000,
      'task running',
      () => 'transitions=' + JSON.stringify(seen) + ' calls=' + fake.calls.length,
    )

    // Abort the run: the projection now freezes this run's task transitions.
    service.abort(result.runId)
    expect(service.snapshot().runs.find((r) => r.id === result.runId)?.status).toBe('aborted')

    const failsBefore = service.events.all().filter((e) => e.kind === 'task/failed' && e.taskId === 'z1').length

    // Three "host restarts" in a row, as production experienced.
    const recover = (service as unknown as { recoverOrphans(): void }).recoverOrphans.bind(service)
    recover()
    recover()
    recover()

    const failsAfter = service.events.all().filter((e) => e.kind === 'task/failed' && e.taskId === 'z1').length
    expect(failsAfter).toBe(failsBefore) // the ghost loop is gone

    fake.release()
  }, 15000)

  it('J6 (control): recoverOrphans still requeues a genuine restart orphan', async () => {
    // A genuine orphan is a task the fold reports as running while NOTHING in this
    // process owns it — i.e. exactly what a fresh host sees after a crash. Append
    // those events directly so no live flight exists (J13 ignores live tasks).
    const { service } = await bootRunnable()

    const runId = 'run-orphan-control'
    service.events.append('run/created', {
      runId,
      data: {
        title: 'orphan control',
        spec: 's',
        tasks: [{ id: 'z2', subject: 'Z', description: 'd', role: 'builder' }],
      },
    })
    service.events.append('run/endorsed', { runId })
    service.events.append('task/started', { runId, taskId: 'z2', data: { label: 'swarm:z2' } })
    service.events.append('task/agent-started', { runId, taskId: 'z2', data: { sessionId: 'sess-orphan' } })

    const before = service.events.all().filter((e) => e.kind === 'task/failed' && e.taskId === 'z2').length
    const recover = (service as unknown as { recoverOrphans(): void }).recoverOrphans.bind(service)
    recover()
    const after = service.events.all().filter((e) => e.kind === 'task/failed' && e.taskId === 'z2')

    // The guard must not disable legitimate orphan recovery.
    expect(after.length).toBe(before + 1)
    expect(String(after[after.length - 1]?.data?.reason)).toMatch(/host restarted mid-flight/)
  }, 15000)

  it('J13: recoverOrphans never touches a task this process is actively running', async () => {
    // Regression for a bug caught by a live one-shot-host smoke run: recovery fires
    // asynchronously after boot, and a dispatch that happened in the meantime was
    // killed with "host restarted mid-flight" (task/started -> agent-started ->
    // failed -> heartbeat). A live in-memory flight means the task is not an orphan.
    const { service, fake } = await bootRunnable()
    fake.holdAll = true

    const result = service.dispatch({
      title: 'live task is not an orphan',
      spec: 's',
      tasks: [{ id: 'live', subject: 'L', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().tasks.some((t) => t.id === 'live' && t.status === 'running'), 5000, 'task running')

    const failsBefore = service.events.all().filter((e) => e.kind === 'task/failed' && e.taskId === 'live').length
    const recover = (service as unknown as { recoverOrphans(): void }).recoverOrphans.bind(service)
    recover()

    expect(service.events.all().filter((e) => e.kind === 'task/failed' && e.taskId === 'live').length).toBe(failsBefore)
    expect(service.snapshot().tasks.find((t) => t.id === 'live')?.status).toBe('running')

    service.abort(result.runId)
    fake.release()
  }, 15000)

  // ── J8: the spawn ceiling covers the `dispatching` state ──────────────────
  it('J8: spawnTimeoutSeconds aborts a child that never reports started', async () => {
    const { service, fake } = await bootRunnable({
      spawnTimeoutSeconds: 1, // 1s ceiling
      maxRetries: 0,
      circuitBreakerThreshold: 0,
    })
    fake.abortAware = true

    fake.holdAll = true

    const result = service.dispatch({
      title: 'spawn ceiling',
      spec: 's',
      tasks: [{ id: 'slow', subject: 'S', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().tasks.some((t) => t.id === 'slow' && t.status === 'running'), 5000, 'task running')

    // The held child never resolves; without the ceiling the slot is held forever.
    await waitFor(() => {
      const t = service.snapshot().tasks.find((x) => x.id === 'slow')
      return t !== undefined && t.status !== 'running' && t.status !== 'dispatching'
    }, 12000, 'spawn ceiling released the task')

    fake.release()
  }, 20000)

  it('J8: spawnTimeoutSeconds = 0 disables the ceiling', async () => {
    const { service, fake } = await bootRunnable({ spawnTimeoutSeconds: 0, maxRetries: 0 })
    fake.abortAware = true

    fake.holdAll = true

    const result = service.dispatch({
      title: 'no ceiling',
      spec: 's',
      tasks: [{ id: 'held', subject: 'H', description: 'd', role: 'builder' }],
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().tasks.some((t) => t.id === 'held' && t.status === 'running'), 5000, 'task running')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // Still running: no ceiling was applied.
    expect(service.snapshot().tasks.find((t) => t.id === 'held')?.status).toBe('running')

    service.abort(result.runId)
    fake.release()
  }, 15000)

  // ── J3: evidence commands must run under a shell that accepts PS syntax ────
  it('J3: evidence commands run under PowerShell on Windows, not cmd.exe', async () => {
    const { service, fake, dir } = await bootRunnable()

    // The gate runs in the run's workspace, so point the dispatcher at a real
    // directory and give it a file to find (the default fake cwd D:\work does not
    // exist, which is itself reported as a distinct, non-gate failure).
    writeFileSync(join(dir, 'package.json'), '{"name":"evidence-fixture"}')

    // This is exactly the syntax that produced 59 cmd.exe failures in production.
    const result = service.dispatch({
      title: 'evidence shell',
      spec: 's',
      tasks: [{
        id: 'gate',
        subject: 'G',
        description: 'd',
        role: 'builder',
        evidence: { commands: ['if (Test-Path package.json) { exit 0 } else { exit 1 }'] },
      }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed',
      8000,
      'PowerShell evidence passed',
      () => 'run=' + service.snapshot().runs.find((r) => r.id === result.runId)?.status +
        ' tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, t.lastNote])) +
        ' calls=' + fake.calls.length,
    )
    expect(fake.calls.length).toBeGreaterThan(0)
  }, 15000)

  it('J3: a nonexistent run workspace is reported as such, not as a failed gate', async () => {
    const { service } = await bootRunnable()

    const result = service.dispatch({
      title: 'evidence cwd guard',
      spec: 's',
      tasks: [{
        id: 'gate2',
        subject: 'G',
        description: 'd',
        role: 'builder',
        evidence: { commands: ['exit 0'] },
      }],
    }, makeDispatcher('D:\\definitely-missing-workspace-xyz') as never)
    service.endorse(result.runId)

    // A7: an evidence command that cannot even START — its workspace is gone — is an
    // evidence-only failure of finished work, so it blocks for a human instead of
    // spending the task's retry budget on a respawn that cannot help.
    await waitFor(() => {
      const t = service.snapshot().tasks.find((x) => x.id === 'gate2')
      return t !== undefined && t.status === 'blocked'
    }, 8000, 'gate2 blocked for a human')

    const task = service.snapshot().tasks.find((x) => x.id === 'gate2')
    const reason = task?.blockedReason ?? ''
    // The verdict must name the real cause (the command never started) rather than a
    // bare "evidence contract failed" — the point this test has always made.
    expect(task?.humanReview).toBe(true)
    expect(reason.length).toBeGreaterThan(0)
    expect(reason).not.toBe('evidence contract failed')
    expect(reason).toMatch(/could not be started/)
  }, 15000)

  // ── J9: boot readiness waits for the spawn provider ──────────────────────
  it('J9: orphan recovery runs after the subagents provider is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-readiness-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    const fake = new FakeSubagents()
    // Provide `subagents` only AFTER the plugin loads — the real post-restart race.
    await ctx.plugin(swarmPlugin, {
      storageDir: dir,
      maxConcurrent: 5,
      staleTimeoutSeconds: 14400,
      maxRetries: 2,
      reviewLoops: 3,
      requireArchitectReview: false,
      workspaceRunPolicy: 'off',
      retryBackoffBaseMs: 0,
      circuitBreakerThreshold: 0,
    })
    const traced = ctx.get('swarm') as Record<symbol, unknown>
    const service = traced[Symbol.for('cordis.original')] as SwarmService
    expect(service).toBeDefined()

    // Plugin loaded with no provider; the readiness poll must not have thrown,
    // and loading must not have crashed the context.
    expect(ctx.get('swarm')).toBeDefined()
    ctx.reflect.provide('subagents', fake as never)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(ctx.get('swarm')).toBeDefined()
  }, 15000)

  // ── J10: durable task handoff ─────────────────────────────────────────────
  it('J10: a completed on-disk task report is adopted instead of re-running the task', async () => {
    const { service, fake, dir } = await bootRunnable({ maxRetries: 0 })
    fake.failOnce = true // the child dies after writing its work

    // The agent finished the work and wrote its report, then died before the
    // dispatcher could record it — exactly the production "landed on disk" case.
    // Written from the spawn-time hook so it lands during the attempt (J22).
    fake.beforeFail = () => {
      mkdirSync(join(dir, '.dsh-swarm'), { recursive: true })
      writeFileSync(
        join(dir, '.dsh-swarm', 'task-hand.json'),
        JSON.stringify({ taskId: 'hand', status: 'completed', summary: 'work landed before the crash' }),
      )
    }

    const result = service.dispatch({
      title: 'durable handoff',
      spec: 's',
      tasks: [{ id: 'hand', subject: 'H', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => service.snapshot().tasks.find((t) => t.id === 'hand')?.status === 'completed',
      8000,
      'task adopted from its on-disk report',
      () => 'tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, t.lastNote])),
    )
    expect(service.snapshot().tasks.find((t) => t.id === 'hand')?.summary).toMatch(/landed before the crash/)
  }, 15000)

  it('J10: a report that does not claim completion is NOT adopted', async () => {
    const { service, fake, dir } = await bootRunnable({ maxRetries: 0 })
    fake.failOnce = true
    // Fresh (written during the attempt), so the ONLY reason to refuse is the status.
    fake.beforeFail = () => {
      mkdirSync(join(dir, '.dsh-swarm'), { recursive: true })
      writeFileSync(
        join(dir, '.dsh-swarm', 'task-half.json'),
        JSON.stringify({ taskId: 'half', status: 'in-progress', summary: 'still going' }),
      )
    }

    const result = service.dispatch({
      title: 'no false adoption',
      spec: 's',
      tasks: [{ id: 'half', subject: 'H', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => ['failed', 'retrying'].includes(service.snapshot().tasks.find((t) => t.id === 'half')?.status ?? ''),
      8000,
      'incomplete report left the task failed',
    )
    expect(service.snapshot().tasks.find((t) => t.id === 'half')?.status).not.toBe('completed')
  }, 15000)

  // ── J22: an adopted report must belong to the attempt that is settling ────
  // Live trigger: `.dsh-swarm/task-<id>.json` is keyed by task id, not by run. A
  // compatibility run reused the ids alpha/beta from an earlier run and both agents
  // found (and had to correct) a stale "completed" report already sitting there.
  // Had either child died before writing its own report, the dispatcher would have
  // adopted that earlier run's file as proof of work this attempt never did.
  it('J22: a completed report left behind by an earlier run is NOT adopted', async () => {
    const { service, fake, dir } = await bootRunnable({ maxRetries: 0 })
    fake.failOnce = true

    // The previous run's report: same task id, claims completion, well-formed.
    mkdirSync(join(dir, '.dsh-swarm'), { recursive: true })
    const stale = join(dir, '.dsh-swarm', 'task-stale.json')
    writeFileSync(stale, JSON.stringify({ taskId: 'stale', status: 'completed', summary: 'work from an earlier run' }))
    const earlier = new Date(Date.now() - 60_000)
    utimesSync(stale, earlier, earlier)

    const result = service.dispatch({
      title: 'stale report',
      spec: 's',
      tasks: [{ id: 'stale', subject: 'S', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => ['failed', 'retrying'].includes(service.snapshot().tasks.find((t) => t.id === 'stale')?.status ?? ''),
      8000,
      'stale report rejected so the task is charged as failed',
      () => 'tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, t.summary])),
    )
    const task = service.snapshot().tasks.find((t) => t.id === 'stale')
    expect(task?.status).not.toBe('completed')
    expect(task?.summary ?? '').not.toMatch(/earlier run/)
  }, 15000)

  it('J10: the task prompt instructs the agent to write its report last', async () => {
    const { service, fake, dir } = await bootRunnable()
    const result = service.dispatch({
      title: 'prompt contract',
      spec: 's',
      tasks: [{ id: 'p1', subject: 'P', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')
    const prompt = fake.calls[0]?.prompt?.[0]?.text ?? ''
    expect(prompt).toContain('.dsh-swarm/task-p1.json')
    expect(prompt).toMatch(/LAST thing you do/)
    service.abort(result.runId)
  }, 15000)

  // ── J11: swarm_report no longer requires the model to pass taskId ─────────
  it('J11: report() resolves the task from the authenticated agent when taskId is omitted', async () => {
    const { service, fake, dir } = await bootRunnable()
    fake.holdAll = true

    const result = service.dispatch({
      title: 'report binding',
      spec: 's',
      tasks: [{ id: 'r1', subject: 'R', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')
    const childId = 'sess-1' // first minted child session id

    // Omitted taskId: resolved from the tracked child session.
    expect(service.report(childId, undefined, 'progress: half way')).toBe('ok')
    const notes = service.events.all().filter((e) => e.kind === 'task/heartbeat')
    expect(notes.length).toBe(1)
    expect(notes[0]?.taskId).toBe('r1')

    // A wrong explicit id is still rejected — authentication is not weakened.
    expect(() => service.report(childId, 'someone-else', 'nope')).toThrow(/not assigned to this agent/)
    // An untracked agent cannot report at all.
    expect(() => service.report('not-a-swarm-child', undefined, 'hi')).toThrow(/not a tracked swarm task agent/)

    service.abort(result.runId)
    fake.release()
  }, 15000)

  // ── write-scope discipline ───────────────────────────────────────────────
  it('warns when a task claims a broad scope that contains a sibling\'s files', async () => {
    const { service, dir } = await bootRunnable()
    const result = service.dispatch({
      title: 'nested scope',
      spec: 's',
      tasks: [
        { id: 'build', subject: 'B', description: 'd', role: 'builder', writes: ['scripts/build.mjs'] },
        { id: 'qa', subject: 'Q', description: 'd', role: 'builder', writes: ['scripts'] },
      ],
    }, makeDispatcher(dir) as never)
    const joined = (result.warnings ?? []).join(' | ')
    expect(joined).toMatch(/broad scope "scripts"/)
    expect(joined).toContain('build')
    service.abort(result.runId)
  }, 15000)

  it('does not warn when the broad scope is serialised behind blockedBy', async () => {
    const { service, dir } = await bootRunnable()
    const result = service.dispatch({
      title: 'serialised scope',
      spec: 's',
      tasks: [
        { id: 'build', subject: 'B', description: 'd', role: 'builder', writes: ['scripts/build.mjs'] },
        { id: 'qa', subject: 'Q', description: 'd', role: 'builder', writes: ['scripts'], blockedBy: ['build'] },
      ],
    }, makeDispatcher(dir) as never)
    expect((result.warnings ?? []).join(' | ')).not.toMatch(/broad scope/)
    service.abort(result.runId)
  }, 15000)

  // ── J12: role toolFilter reaches the spawn provider ──────────────────────
  it('J12: a role toolFilter is passed through to the spawn provider', async () => {
    const { service, fake, dir } = await bootRunnable()
    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, toolFilter: { deny: ['modlens'] } }
    service.setDutyTable(table, 'test')

    const result = service.dispatch({
      title: 'tool filter',
      spec: 's',
      tasks: [{ id: 'f1', subject: 'F', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')
    const sent = (fake.calls[0] as unknown as { toolFilter?: { deny?: string[] } }).toolFilter
    expect(sent?.deny).toEqual(['modlens'])
    service.abort(result.runId)
  }, 15000)

  it('J12: the duty table keeps its toolFilter across a save round-trip', async () => {
    const { service } = await bootRunnable()
    const table = structuredClone(service.duty.get())
    table.roles.reviewer = { ...table.roles.reviewer, toolFilter: { deny: ['modlens'] } }
    service.setDutyTable(table, 'test')
    expect(service.duty.role('reviewer')?.toolFilter?.deny).toEqual(['modlens'])
  }, 15000)

  // ── J15: an unknown toolFilter name must not fail the whole run ──────────
  // Production: a role toolFilter naming "modlens" (the real tool is
  // `modlens_read_image`) made tools.restrict() throw during child creation, so
  // all 10 tasks failed across 3 waves and the run failed.
  it('J15: unknown tool names are dropped and reported, not fatal', () => {
    const known = new Set(['read', 'write', 'modlens_read_image', 'pwsh'])
    const r = sanitizeToolNames({ deny: ['modlens', 'write'] }, known)
    expect(r.filter?.deny).toEqual(['write'])
    expect(r.dropped).toEqual(['modlens'])
    expect(r.refusal).toBeUndefined()
  })

  it('J15: an allow-list that loses every name refuses the filter rather than widening access', () => {
    const known = new Set(['read', 'write'])
    const r = sanitizeToolNames({ allow: ['totally-bogus'] }, known)
    // An empty allow-list would permit EVERYTHING — refuse instead of widening.
    expect(r.filter).toBeUndefined()
    expect(r.refusal).toMatch(/allow-list/)
    expect(r.dropped).toEqual(['totally-bogus'])
  })

  it('J15: a partly-valid allow-list keeps the valid names', () => {
    const known = new Set(['read', 'write'])
    const r = sanitizeToolNames({ allow: ['read', 'nope'] }, known)
    expect(r.filter?.allow).toEqual(['read'])
    expect(r.dropped).toEqual(['nope'])
  })

  it('J15: an unverifiable registry passes the filter through untouched', () => {
    // Without a readable registry we must not silently strip a legitimate filter.
    const r = sanitizeToolNames({ deny: ['anything'] }, undefined)
    expect(r.filter?.deny).toEqual(['anything'])
    expect(r.dropped).toEqual([])
  })

  it('J15: no filter means no work', () => {
    const r = sanitizeToolNames(undefined, new Set(['read']))
    expect(r.filter).toBeUndefined()
    expect(r.dropped).toEqual([])
  })

  it('J15 END-TO-END: the exact production misconfiguration no longer kills the run', async () => {
    // Reproduces run-mtxidssw-4bky, which failed 10/10 tasks in 3 waves because a
    // role toolFilter named "modlens" while the real tool is `modlens_read_image`.
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)

    // The host's real tool registry, including the correctly-named tool.
    const KNOWN = ['ask_user_question', 'edit', 'glob', 'grep', 'modlens_read_image',
      'pwsh', 'read', 'read_image', 'skill', 'subagent', 'swarm_report', 'write']
    ctx.reflect.provide('tools', { restrictableNames: new Set(KNOWN) } as never)

    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3', toolFilter: { deny: ['modlens'] } }
    // Saved through the STORE, not setDutyTable: the dashboard path now rejects
    // an unknown name at save time (B-config), and this test pins the DISPATCH
    // behavior for the tables that still reach storage by other routes — a
    // hand-edited duty-table.json is exactly how the production typo persisted.
    service.duty.save(table)

    // The bad name is sanitised away rather than passed through to restrict().
    expect(service.toolFilterFor('builder')).toBeUndefined()

    const result = service.dispatch({
      title: 'production misconfig',
      spec: 's',
      tasks: [{ id: 'p1', subject: 'P', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    // Before the fix this threw during child creation and failed every task.
    await waitFor(
      () => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed',
      8000,
      'run survived the bad tool name',
      () => 'tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, String(t.lastNote ?? '').slice(0, 70)])),
    )
    expect(fake.calls.length).toBeGreaterThan(0)
    expect((fake.calls[0] as unknown as { toolFilter?: unknown }).toolFilter).toBeUndefined()
  }, 15000)

  it('J15 END-TO-END: a valid tool name still reaches the spawn provider', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    ctx.reflect.provide('tools', { restrictableNames: new Set(['read', 'write', 'modlens_read_image']) } as never)

    const table = structuredClone(service.duty.get())
    table.roles.builder = {
      ...table.roles.builder, provider: 'zai', model: 'glm-5.3',
      toolFilter: { deny: ['modlens_read_image', 'typo'] },
    }
    // Store save, not the dashboard path — see the misconfiguration test above.
    service.duty.save(table)

    const result = service.dispatch({
      title: 'valid name survives',
      spec: 's',
      tasks: [{ id: 'p2', subject: 'P', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')
    const sent = (fake.calls[0] as unknown as { toolFilter?: { deny?: string[] } }).toolFilter
    expect(sent?.deny).toEqual(['modlens_read_image'])
    service.abort(result.runId)
  }, 15000)

  // ── J14: task agents must not spawn invisible descendants ────────────────
  // Production evidence: the `vhp-cryo-embed` task spawned 12 DSH subagents in
  // 42 minutes while the orchestrator saw exactly one task; a separate chain
  // reached delegation depth 3. None of those were counted by the global agent
  // cap, tracked by the watchdog, or shown on the board.
  it('J14: maxDepth is passed to the spawn provider by default', async () => {
    const { service, fake, dir } = await bootRunnable()
    const result = service.dispatch({
      title: 'depth bound',
      spec: 's',
      tasks: [{ id: 'd1', subject: 'D', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')
    const sent = (fake.calls[0] as unknown as { maxDepth?: number }).maxDepth
    expect(sent).toBe(1) // depth 1 = the task agent itself; grandchildren rejected
    service.abort(result.runId)
  }, 15000)

  it('J14: maxSubagentDepth 0 disables the bound (opt-out)', async () => {
    const { service, fake, dir } = await bootRunnable({ maxSubagentDepth: 0 })
    const result = service.dispatch({
      title: 'no depth bound',
      spec: 's',
      tasks: [{ id: 'd2', subject: 'D', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')
    const sent = (fake.calls[0] as unknown as { maxDepth?: number }).maxDepth
    expect(sent).toBeUndefined()
    service.abort(result.runId)
  }, 15000)

  it('J14: a delegation attempt beyond the cap surfaces as a task failure, not silently', async () => {
    const { service, fake, dir } = await bootRunnable()
    // Simulate the provider rejecting a grandchild the way the real depth guard does.
    fake.throwDepthError = true
    const result = service.dispatch({
      title: 'depth rejection',
      spec: 's',
      tasks: [{ id: 'd3', subject: 'D', description: 'd', role: 'builder' }],
    }, makeDispatcher(dir) as never)
    service.endorse(result.runId)

    await waitFor(
      () => ['failed', 'retrying'].includes(service.snapshot().tasks.find((t) => t.id === 'd3')?.status ?? ''),
      8000,
      'depth rejection recorded',
    )
    const note = service.snapshot().tasks.find((t) => t.id === 'd3')?.lastNote ?? ''
    expect(note).toMatch(/depth/i)
  }, 15000)
})

describe('A7: evidence-contract failure path', () => {
  /** The raw event log — a verdict must be assertable from events.jsonl alone. */
  const eventsOf = (dir: string): Array<{ kind: string; taskId?: string; data?: Record<string, unknown> }> =>
    readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind: string; taskId?: string; data?: Record<string, unknown> })

  const taskOf = (service: SwarmService, runId: string) =>
    service.snapshot().tasks.find((t) => t.runId === runId && t.id === 'a')!

  /**
   * How many times a command actually executed, read off a marker file it appends to.
   * PowerShell 5.1 writes `>>` redirection as UTF-16LE, so the raw bytes interleave
   * NULs and a line count is not an execution count; strip them and count the marker.
   */
  const markerCount = (path: string, marker: string): number =>
    existsSync(path) ? (readFileSync(path, 'utf8').replace(/\0/g, '').match(new RegExp(marker, 'g')) ?? []).length : 0

  /** One builder task whose child SUCCEEDS and whose evidence contract is `commands`. */
  async function dispatchWithCommands(commands: string[], overrides: Record<string, unknown> = {}) {
    const { ctx, service, fake, dir } = await bootSwarm(overrides)
    contexts.push(ctx)
    dirs.push(dir)
    const dispatched = service.dispatch({
      title: 'evidence hardening',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands } }],
    }, makeDispatcher(dir) as never)
    service.endorse(dispatched.runId)
    return { service, fake, dir, runId: dispatched.runId }
  }

  it('re-runs only the declared commands, once, and never respawns the finished child', async () => {
    // The incident's shape: a green summary, then a non-zero exit from a teardown
    // artefact. The command counts its own executions by appending a marker, so
    // "exactly one recheck" is measured rather than inferred from timing.
    const { service, fake, dir, runId } = await dispatchWithCommands(["echo '191 passed in 4.50s'; echo run >> runs.txt; exit 1"])

    await waitFor(() => taskOf(service, runId).status === 'blocked', 20000, 'task blocks for a human after the recheck')

    // The deliverable was already on disk and verified — the child must NOT be respawned.
    expect(fake.calls.length).toBe(1)
    // One run, one recheck. Never a loop.
    expect(markerCount(join(dir, 'runs.txt'), 'run')).toBe(2)

    const task = taskOf(service, runId)
    expect(task.status).toBe('blocked')
    expect(task.humanReview).toBe(true)
    expect(task.blockedReason ?? '').toMatch(/evidence contract failed twice/)

    // No whole-task retry: the old behaviour emitted task/failed with retry: true here.
    const events = eventsOf(dir)
    expect(events.filter((e) => e.kind === 'task/failed' && e.taskId === 'a')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'task/blocked' && e.taskId === 'a').length).toBeGreaterThanOrEqual(1)
    // The recheck itself is on the record, marked as such.
    const recheckNotes = events.filter(
      (e) => e.kind === 'task/heartbeat' && e.taskId === 'a'
        && (e.data?.evidence as { recheck?: boolean } | undefined)?.recheck === true,
    )
    expect(recheckNotes).toHaveLength(1)
  }, 30000)

  it('records the exit code and an output tail, so the log explains the failure', async () => {
    const { service, dir, runId } = await dispatchWithCommands(["echo '191 passed in 4.50s'; echo run >> runs.txt; exit 1"])
    await waitFor(() => taskOf(service, runId).status === 'blocked', 20000, 'blocked')

    const blocked = eventsOf(dir).filter((e) => e.kind === 'task/blocked' && e.taskId === 'a').pop()!
    const reason = String(blocked.data?.reason ?? '')
    expect(reason).toMatch(/exit code 1/)            // the verdict is never truncated away
    expect(reason).toMatch(/191 passed in 4\.50s/)   // nor is the tail that explains it

    const evidence = blocked.data?.evidence as
      | { commands?: Array<Record<string, unknown>>; firstRun?: Array<Record<string, unknown>> }
      | undefined
    const recorded = evidence?.commands ?? []
    expect(recorded).toHaveLength(1)
    expect(recorded[0].exitCode).toBe(1)
    expect(recorded[0].timedOut).toBe(false)
    expect(typeof recorded[0].elapsedMs).toBe('number')
    expect(String(recorded[0].outputTail)).toMatch(/191 passed in 4\.50s/)
    // The FIRST run's detail survives too, so a transient failure is still explained.
    expect(evidence?.firstRun ?? []).toHaveLength(1)
    expect((evidence?.firstRun ?? [])[0].exitCode).toBe(1)
  }, 30000)

  it('reports a hung command as TIMED OUT, distinct from a non-zero exit', async () => {
    const { service, dir, runId } = await dispatchWithCommands(['sleep 30'], { evidenceTimeoutMs: 1200 })
    await waitFor(() => taskOf(service, runId).status === 'blocked', 30000, 'blocked after two timeouts')

    const blocked = eventsOf(dir).filter((e) => e.kind === 'task/blocked' && e.taskId === 'a').pop()!
    const reason = String(blocked.data?.reason ?? '')
    expect(reason).toMatch(/TIMED OUT/)
    expect(reason).not.toMatch(/exit code/) // the whole point: the two are distinguishable

    const recorded = (blocked.data?.evidence as { commands?: Array<Record<string, unknown>> } | undefined)?.commands ?? []
    expect(recorded).toHaveLength(1)
    expect(recorded[0].timedOut).toBe(true)
    expect(recorded[0]).not.toHaveProperty('exitCode')
    expect(Number(recorded[0].elapsedMs)).toBeGreaterThanOrEqual(1000)
  }, 60000)

  it('leaves a genuine child failure on the existing retry path, with no evidence recheck', async () => {
    const { ctx, service, fake, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    // The child never reports done, so the evidence contract is not consulted at all.
    fake.failScript[0] = { stopReason: 'error', output: [] }
    fake.failScript[1] = { stopReason: 'error', output: [] }
    fake.failScript[2] = { stopReason: 'error', output: [] }
    const dispatched = service.dispatch({
      title: 'genuine failure',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands: ['echo x >> runs.txt; exit 1'] } }],
    }, makeDispatcher(dir) as never)
    service.endorse(dispatched.runId)

    await waitFor(() => taskOf(service, dispatched.runId).status === 'failed', 20000, 'task fails after its retries')

    // 1 + maxRetries(2): the retry budget is untouched by this work.
    expect(fake.calls.length).toBe(3)
    const task = taskOf(service, dispatched.runId)
    expect(task.status).toBe('failed')
    expect(task.humanReview).not.toBe(true)

    // The command never ran and no human gate was raised.
    expect(existsSync(join(dir, 'runs.txt'))).toBe(false)
    const events = eventsOf(dir)
    expect(events.filter((e) => e.kind === 'task/blocked' && e.taskId === 'a')).toHaveLength(0)
    expect(events.filter(
      (e) => e.kind === 'task/heartbeat' && e.taskId === 'a' && e.data?.evidence !== undefined,
    )).toHaveLength(0)
  }, 30000)
})

describe('B-config: duty-table toolFilter guard (fail-open)', () => {
  /** The current table with the builder role's toolFilter replaced. */
  const tableWithFilter = (service: SwarmService, filter: { deny?: string[]; allow?: string[] }): unknown => {
    const table = structuredClone(service.duty.get())
    table.roles.builder = { ...table.roles.builder, toolFilter: filter }
    return table
  }

  it('rejects a save naming a tool this host does not expose — naming the tool, the role, and known names', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    // The host exposes exactly these; "modlens" is the production typo (the real
    // tool is modlens_read_image — 27 task-attempts died across 3 runs on it).
    ctx.reflect.provide('tools', { restrictableNames: new Set(['bash', 'read', 'write', 'modlens_read_image']) } as never)

    expect(() => service.setDutyTable(tableWithFilter(service, { deny: ['modlens'] }) as never, 'test'))
      .toThrow(/modlens/)
    expect(() => service.setDutyTable(tableWithFilter(service, { deny: ['modlens'] }) as never, 'test'))
      .toThrow(/builder/)
    expect(() => service.setDutyTable(tableWithFilter(service, { deny: ['modlens'] }) as never, 'test'))
      .toThrow(/bash/)
    // The allow list is validated exactly the same way.
    expect(() => service.setDutyTable(tableWithFilter(service, { allow: ['nope'] }) as never, 'test'))
      .toThrow(/nope/)
  })

  it('accepts a save whose filter names only tools the host exposes', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    ctx.reflect.provide('tools', { restrictableNames: new Set(['bash', 'read', 'write']) } as never)

    const saved = service.setDutyTable(tableWithFilter(service, { deny: ['bash'], allow: ['read'] }) as never, 'test')
    expect((saved.roles.builder as { toolFilter?: { deny?: string[] } }).toolFilter?.deny).toEqual(['bash'])
    // And the save really landed (not silently swallowed).
    expect((service.duty.get().roles.builder as { toolFilter?: { deny?: string[] } }).toolFilter?.deny).toEqual(['bash'])
  })

  it('fails OPEN: an unknown name is accepted when the host tool list is unavailable', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    // No `tools` service provided at all — the read fails, the guard must not
    // invent a rejection the host cannot back up.
    const saved = service.setDutyTable(tableWithFilter(service, { deny: ['modlens'] }) as never, 'test')
    expect((saved.roles.builder as { toolFilter?: { deny?: string[] } }).toolFilter?.deny).toEqual(['modlens'])
  })
})

describe('B2: human-attention notification to the dispatching session', () => {
  /** Boot with a live dispatching session whose inbox records every followup's text. */
  async function bootWithInbox(overrides: Record<string, unknown> = {}) {
    const { ctx, service, fake, dir } = await bootSwarm(overrides)
    contexts.push(ctx)
    dirs.push(dir)
    // Decoded to the message TEXT (not the stringified envelope) so assertions
    // read what the dispatching agent actually sees.
    const followupTexts: string[] = []
    const agents = new FakeAgents()
    ctx.reflect.provide('agents', agents as never)
    const originalGet = agents.get.bind(agents)
    ;(agents as unknown as { get: (id: string) => unknown }).get = (id: string): unknown => {
      // makeDispatcher()'s session id is 'parent-1'.
      if (id === 'parent-1') {
        return {
          followup: (message: unknown): void => {
            const text = (message as { content?: Array<{ type: string; text?: string }> })?.content?.[0]?.text
            followupTexts.push(typeof text === 'string' ? text : JSON.stringify(message))
          },
        }
      }
      return originalGet(id)
    }
    return { service, fake, dir, followupTexts }
  }

  /** Only the attention pings — the completion/failed pushes ride the same inbox. */
  const attention = (calls: string[]): string[] => calls.filter((c) => c.includes('[swarm attention]'))

  const taskOfRun = (service: SwarmService, runId: string, id: string) =>
    service.snapshot().tasks.find((t) => t.runId === runId && t.id === id)!

  it('pings once with the task, the reason, and every resolution option', async () => {
    const { service, dir, followupTexts } = await bootWithInbox()
    const dispatched = service.dispatch({
      title: 'attention demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands: ["echo '191 passed in 4.50s'; exit 1"] } }],
    }, makeDispatcher(dir) as never)
    service.endorse(dispatched.runId)

    await waitFor(() => taskOfRun(service, dispatched.runId, 'a').status === 'blocked', 20000, 'task blocks')
    await waitFor(() => attention(followupTexts).length === 1, 8000, 'attention ping arrives after the coalescing window')

    const ping = attention(followupTexts)[0]
    expect(ping).toContain('[swarm attention]')
    expect(ping).toContain('1 item')                       // singular for one item
    expect(ping).toContain('task "a"')                     // the task is named
    expect(ping).toContain(dispatched.runId)               // and its run
    expect(ping).toContain('191 passed in 4.50s')          // the recorded reason explains itself
    expect(ping).toContain('swarm_review')
    expect(ping).toContain('swarm_retry')
    expect(ping).toContain('swarm_complete')
    expect(ping).toContain('multiple-choice')              // the agent may prompt the user
  }, 30000)

  it('aggregates: tasks blocking in one burst produce ONE ping listing all of them', async () => {
    const { service, dir, followupTexts } = await bootWithInbox()
    const dispatched = service.dispatch({
      title: 'burst demo',
      spec: 's',
      tasks: [
        { id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands: ['exit 1'] } },
        { id: 'b', subject: 'B', description: 'd', role: 'builder', evidence: { commands: ['exit 1'] } },
      ],
    }, makeDispatcher(dir) as never)
    service.endorse(dispatched.runId)

    await waitFor(() => {
      const tasks = service.snapshot().tasks.filter((t) => t.runId === dispatched.runId)
      return tasks.length === 2 && tasks.every((t) => t.status === 'blocked')
    }, 20000, 'both tasks block')
    await waitFor(() => attention(followupTexts).length === 1, 8000, 'exactly one aggregated ping')

    const ping = attention(followupTexts)[0]
    expect(ping).toContain('2 items')
    expect(ping).toContain('task "a"')
    expect(ping).toContain('task "b"')
    // The production incident had eight — one ping, not eight.
    expect(attention(followupTexts).length).toBe(1)
  }, 30000)

  it('re-pings only when the set changes: a re-block after resolution pings, an unchanged set stays silent', async () => {
    const { service, dir, followupTexts } = await bootWithInbox()
    const dispatched = service.dispatch({
      title: 'dedupe demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands: ['exit 1'] } }],
    }, makeDispatcher(dir) as never)
    service.endorse(dispatched.runId)

    await waitFor(() => taskOfRun(service, dispatched.runId, 'a').status === 'blocked', 20000, 'first block')
    await waitFor(() => attention(followupTexts).length === 1, 8000, 'first ping')

    // Resolve by requeueing: the task unblocks, re-runs, its evidence still
    // fails, the fresh attempt's recheck fails, and it blocks again — a NEW
    // wait, so it must ping again.
    service.retryTask(dispatched.runId, 'a')
    await waitFor(() => taskOfRun(service, dispatched.runId, 'a').status === 'blocked', 20000, 'blocks again after retry')
    await waitFor(() => attention(followupTexts).length === 2, 8000, 'second ping after re-block')

    // An unchanged set must stay silent: force a flush with nothing new waiting.
    ;(SwarmService.prototype as unknown as { flushHumanWaiting: (runId: string) => void })
      .flushHumanWaiting.call(service, dispatched.runId)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(attention(followupTexts).length).toBe(2)
  }, 40000)

  it('stays silent when notifyDispatchSession is false', async () => {
    const { service, dir, followupTexts } = await bootWithInbox({ notifyDispatchSession: false })
    const dispatched = service.dispatch({
      title: 'silent demo',
      spec: 's',
      tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder', evidence: { commands: ['exit 1'] } }],
    }, makeDispatcher(dir) as never)
    service.endorse(dispatched.runId)

    await waitFor(() => taskOfRun(service, dispatched.runId, 'a').status === 'blocked', 20000, 'blocked but silent')
    // Well past the coalescing window.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(attention(followupTexts).length).toBe(0)
  }, 30000)
})

describe('A8: board run management — rename + the three board states', () => {
  /** A finished run with one completed task, seeded straight through the event log. */
  const seedTerminalRun = (service: SwarmService, runId: string, title: string): void => {
    service.events.append('run/created', {
      runId,
      data: { title, spec: 's', tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }] },
    })
    service.events.append('run/endorsed', { runId })
    service.events.append('task/started', { runId, taskId: 'a', data: { label: 'swarm:a' } })
    service.events.append('task/completed', { runId, taskId: 'a', data: { summary: 'done' } })
    service.events.append('run/completed', { runId, data: {} })
  }

  it('renames a finished run, trims it, and rejects a blank or over-long title', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    seedTerminalRun(service, 'run-r1', 'original')

    expect(service.renameRun('run-r1', '  Renamed run  ')).toBe('Renamed run')
    expect(service.snapshot().runs.find((r) => r.id === 'run-r1')?.title).toBe('Renamed run')
    expect(service.events.all().some((e) => e.kind === 'run/renamed' && e.runId === 'run-r1')).toBe(true)

    expect(() => service.renameRun('run-r1', '   ')).toThrow(/title required/)
    expect(() => service.renameRun('run-r1', 'x'.repeat(121))).toThrow(/too long/)
    expect(service.renameRun('run-r1', 'x'.repeat(120))).toBe('x'.repeat(120))
    expect(() => service.renameRun('run-ghost', 'nope')).toThrow(/unknown run/)
  })

  it('removes a run and its tasks from the board, keeps every event, and lists it for restore', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    seedTerminalRun(service, 'run-keep', 'stays')
    seedTerminalRun(service, 'run-gone', 'goes')
    const eventsBefore = service.events.all().length

    service.setRunBoardState('run-gone', 'removed')

    const snap = service.snapshot()
    expect(snap.runs.map((r) => r.id)).toEqual(['run-keep'])
    // Nothing is orphaned: the removed run's tasks leave the columns with it.
    expect(snap.tasks.every((task) => task.runId === 'run-keep')).toBe(true)
    // The recycle bin is the only place it still appears.
    expect(snap.removedRuns?.map((r) => r.id)).toEqual(['run-gone'])
    expect(snap.removedRuns?.[0]?.title).toBe('goes')
    // `swarm_status` reads this same snapshot, so it cannot disagree with the board.

    // Soft means soft: the log only GREW, and history is intact.
    const after = service.events.all()
    expect(after.length).toBe(eventsBefore + 1)
    expect(after.filter((e) => e.kind === 'run/created').map((e) => e.runId)).toContain('run-gone')
  })

  it('restores a removed run unchanged — same status, same task summary', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    seedTerminalRun(service, 'run-back', 'returns')

    service.setRunBoardState('run-back', 'removed')
    expect(service.snapshot().runs).toHaveLength(0)
    expect(() => service.setRunBoardState('run-ghost', 'removed')).toThrow(/unknown run/)

    service.setRunBoardState('run-back', 'visible')
    const snap = service.snapshot()
    const restored = snap.runs.find((r) => r.id === 'run-back')
    expect(restored?.title).toBe('returns')
    expect(restored?.status).toBe('completed')
    expect(snap.tasks.find((task) => task.runId === 'run-back' && task.id === 'a')?.summary).toBe('done')
    // Nothing left to restore, so the list is gone from the payload entirely.
    expect(snap.removedRuns).toBeUndefined()
  })

  it('hides a RUNNING run without aborting it or changing its status', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    service.events.append('run/created', {
      runId: 'run-live',
      data: { title: 'live', spec: 's', tasks: [{ id: 'a', subject: 'A', description: 'd', role: 'builder' }] },
    })
    service.events.append('run/endorsed', { runId: 'run-live' })

    service.setRunBoardState('run-live', 'removed')
    expect(service.snapshot().runs).toHaveLength(0)

    service.setRunBoardState('run-live', 'visible')
    // The board state is a view concern: scheduling state is untouched, so
    // clearing a noisy run off the board can never abort work in flight.
    expect(service.snapshot().runs.find((r) => r.id === 'run-live')?.status).toBe('running')
  })

  it('purges a run out of BOTH lists while deleting nothing (the soft-only proof)', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    seedTerminalRun(service, 'run-bin', 'in the bin')
    seedTerminalRun(service, 'run-puff', 'gone for good')
    service.setRunBoardState('run-bin', 'removed')
    const eventsBefore = service.events.all().length

    // removed -> purged. (visible -> purged is the same single event path; the
    // projection test folds both chains.)
    service.setRunBoardState('run-puff', 'purged')

    const snap = service.snapshot()
    // Out of sight everywhere: not on the board, and not in the recycle bin.
    expect(snap.runs.map((r) => r.id)).toEqual([])
    expect(snap.removedRuns?.map((r) => r.id)).toEqual(['run-bin'])
    // Nor are its tasks orphaned anywhere.
    expect(snap.tasks).toHaveLength(0)

    // Soft only: the log grew by exactly one event, and it is still folded in
    // the unfolded view with its status, tasks and history intact.
    const after = service.events.all()
    expect(after.length).toBe(eventsBefore + 1)
    expect(after[after.length - 1]?.kind).toBe('run/board-state')
    expect(after[after.length - 1]?.data?.state).toBe('purged')
    const unfolded = (service as unknown as {
      view(): { runs: Map<string, { boardState?: string; status: string }>; tasks: Map<string, { summary?: string }> }
    }).view()
    expect(unfolded.runs.get('run-puff')?.boardState).toBe('purged')
    expect(unfolded.runs.get('run-puff')?.status).toBe('completed')
    expect(unfolded.tasks.get('run-puff/a')?.summary).toBe('done')
    // Not even purging destroys anything: the run can be brought back.
    service.setRunBoardState('run-puff', 'visible')
    expect(service.snapshot().runs.map((r) => r.id)).toEqual(['run-puff'])
  })

  it('rejects an invalid state string and an unknown run without writing an event', async () => {
    const { ctx, service, dir } = await bootSwarm()
    contexts.push(ctx)
    dirs.push(dir)
    seedTerminalRun(service, 'run-r1', 'r1')

    expect(() => service.setRunBoardState('run-r1', 'deleted')).toThrow(/state must be visible, removed or purged/)
    expect(() => service.setRunBoardState('run-r1', '')).toThrow(/state must be visible, removed or purged/)
    expect(() => service.setRunBoardState('run-r1', 'REMOVED')).toThrow(/state must be visible, removed or purged/)
    expect(() => service.setRunBoardState('run-ghost', 'purged')).toThrow(/unknown run/)
    // A rejected call must not have appended anything.
    expect(service.events.all().some((e) => e.kind === 'run/board-state')).toBe(false)
  })
})
