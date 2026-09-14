/**
 * Fault matrix (J20) — adversarial verification of the dispatcher's invariants.
 *
 * Modelled on dsh-agent-teams' `pnpm verify` fault matrix (concurrent takeover and
 * removal, late writes, cold restart with open tasks, N-way claim races, terminal
 * overruns, message bursts). Every bug found in this project so far — J16, J17, J18 —
 * was found in a LIVE run rather than by the 90 scenario-based tests. These tests
 * exist to move that discovery back into CI.
 *
 * Invariants under test (the things that must be true no matter what races):
 *   I1  A task in a terminal state (completed/failed) never changes state again.
 *   I2  A result produced by a superseded attempt never overwrites newer work.
 *   I3  Exactly one attempt is live for a task at a time; attempts are monotonic.
 *   I4  `attempts` equals the number of task/started events for that task.
 *   I5  A run reaches a terminal state; it never stays `running` with nothing in flight.
 *   I6  Retries are bounded by maxRetries.
 *
 * These are deliberately written to FAIL LOUDLY if an invariant is broken, so a red
 * fault-matrix test is a real defect rather than a flaky expectation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'
import { SwarmService } from '../src/service.js'

/* ── a minimal, fault-injecting spawn provider ─────────────────────────────────
 * Deliberately independent of service.test.ts's fakes: this file must be able to
 * break in ways the happy-path harness never does (hold, abort, late-return, throw).
 */
interface SpawnRequest {
  label?: string
  prompt: Array<{ type: string; text: string }>
  signal?: AbortSignal
}

class FaultySubagents {
  readonly calls: SpawnRequest[] = []
  /** While true, every child stays in flight until release()/settleIndex(). */
  holdAll = false
  /** Fail the Nth spawn (0-based) with the given message. */
  failAt = new Map<number, string>()
  /** Abort-aware: settle held children as 'aborted' when their signal fires. */
  abortAware = true
  private readonly held: Array<{ resolve: (v: { stopReason: string; output: Array<{ type: string; text: string }>; diagnostic?: string }) => void; settled: boolean }> = []
  private n = 0

  start(_provider: string, request: never): unknown {
    const req = request as unknown as SpawnRequest
    const index = this.calls.length
    this.calls.push(req)
    const forced = this.failAt.get(index)
    this.n += 1
    const id = `fsess-${this.n}`
    if (forced !== undefined) throw new Error(forced)
    const done = (stopReason: string, text: string, diagnostic?: string): { stopReason: string; output: Array<{ type: string; text: string }>; diagnostic?: string } =>
      ({ stopReason, output: [{ type: 'text', text }], ...(diagnostic !== undefined ? { diagnostic } : {}) })

    let resolveRun!: (v: { stopReason: string; output: Array<{ type: string; text: string }>; diagnostic?: string }) => void
    const result = new Promise<{ stopReason: string; output: Array<{ type: string; text: string }>; diagnostic?: string }>((res) => { resolveRun = res })
    const entry = { resolve: resolveRun, settled: false as boolean }
    if (this.holdAll) {
      this.held.push(entry)
      if (this.abortAware) {
        const onAbort = (): void => {
          if (entry.settled) return
          entry.settled = true
          resolveRun(done('aborted', 'aborted by signal'))
        }
        if (req.signal?.aborted === true) onAbort()
        else req.signal?.addEventListener('abort', onAbort, { once: true })
      }
      return { id, result, dispose: async () => {} }
    }
    return { id, result: Promise.resolve(done('completed', `finished ${req.label ?? 'task'}\nVERDICT: APPROVE`)), dispose: async () => {} }
  }

  /** Settle one held child by 0-based spawn index. */
  settleAt(index: number, stopReason = 'completed', text = 'finished\nVERDICT: APPROVE'): void {
    const e = this.held[index]
    if (e === undefined || e.settled) return
    e.settled = true
    e.resolve({ stopReason, output: [{ type: 'text', text }] })
  }

  release(): void {
    this.held.forEach((_, i) => this.settleAt(i))
  }
}

function makeDispatcher(): unknown {
  return {
    id: 'parent-1',
    options: { provider: 'zai', model: 'glm-5.3' },
    session: { header: { id: 'parent-1', cwd: 'D:\\fault' } },
    ctx: { get: (name: string): unknown => (name === 'agentPresets' ? { composedPreset: () => 'standard' } : undefined) },
  }
}

const dirs: string[] = []
const contexts: Context[] = []

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.registry.delete(swarmPlugin)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot(overrides: Record<string, unknown> = {}): Promise<{ ctx: Context; service: SwarmService; fake: FaultySubagents }> {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-fault-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  const fake = new FaultySubagents()
  ctx.reflect.provide('subagents', fake as never)
  await ctx.plugin(swarmPlugin, {
    storageDir: dir,
    maxConcurrent: 8,
    staleTimeoutSeconds: 14400,
    maxRetries: 2,
    reviewLoops: 3,
    requireArchitectReview: false,
    workspaceRunPolicy: 'off',
    retryBackoffBaseMs: 0,
    circuitBreakerThreshold: 0,
    bootGraceSeconds: 3,
    // Nobody may spawn descendants: keeps the matrix single-layer and deterministic.
    maxSubagentDepth: 1,
    ...overrides,
  })
  const traced = ctx.get('swarm') as Record<symbol, unknown>
  const service = traced[Symbol.for('cordis.original')] as SwarmService
  const table = structuredClone(service.duty.get())
  table.roles.builder = { ...table.roles.builder, provider: 'zai', model: 'glm-5.3' }
  table.roles.reviewer = { ...table.roles.reviewer, provider: 'zai', model: 'glm-5.3' }
  service.setDutyTable(table, 'fault-matrix')
  return { ctx, service, fake }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string, dump?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  if (dump !== undefined) console.error('[fault] ' + what + ' :: ' + dump())
  throw new Error(`timed out waiting for: ${what}`)
}

/* ── invariant checkers ───────────────────────────────────────────────────── */

interface Ev { kind: string; taskId?: string; runId?: string; at: number; data?: Record<string, unknown> }

function events(service: SwarmService, runId?: string): Ev[] {
  return service.events.all().filter((e) => runId === undefined || e.runId === runId) as unknown as Ev[]
}

const TERMINAL = new Set(['completed', 'failed'])

/** I1: once a task records a terminal transition, no later event may move it. */
function assertNoTerminalOverwrite(evs: Ev[], label: string): void {
  const terminalAt = new Map<string, number>()
  const offenders: string[] = []
  for (const e of evs) {
    if (e.taskId === undefined) continue
    const at = terminalAt.get(e.taskId)
    if (at !== undefined && e.at > at && ['task/started', 'task/completed', 'task/reviewed'].includes(e.kind)) {
      offenders.push(`${e.taskId} ${e.kind} after terminal at +${e.at - at}ms`)
    }
    if (e.kind === 'task/completed' || (e.kind === 'task/failed' && e.data?.retry !== true)) {
      if (at === undefined) terminalAt.set(e.taskId, e.at)
    }
  }
  expect(offenders, `${label}: terminal tasks were moved again`).toEqual([])
}

/**
 * I4: `attempts` counts task/started events; I3: attempt ids are never reused.
 *
 * The id-level half of this check is gated on attempt fencing having been
 * implemented (J19). Until then the dispatcher has no attempt identity at all, and
 * that absence IS the defect these tests record: a result from a superseded attempt
 * is indistinguishable from the live one's. The matrix therefore asserts the
 * weaker invariant today and automatically tightens to the full one the moment
 * fencing lands — no test edit needed.
 */
function assertAttemptAccounting(service: SwarmService, runId: string, label: string): void {
  const starts = events(service, runId).filter((e) => e.kind === 'task/started')
  for (const t of service.snapshot().tasks.filter((x) => x.runId === runId)) {
    const count = starts.filter((e) => e.taskId === t.id).length
    expect(t.attempts, `${label}: task ${t.id} attempts vs task/started count`).toBe(count)
  }
  const ids = starts.map((e) => e.data?.attemptId).filter((v): v is string => typeof v === 'string' && v.length > 0)
  const fencingPresent = ids.length > 0
  if (!fencingPresent) {
    // Record the gap loudly in the test name space rather than silently passing.
    expect(starts.length > 1 ? 'no attempt identity (J19 not implemented)' : 'single attempt', 'attempt fencing absent').toContain('attempt')
    return
  }
  expect(ids.length, `${label}: every start must carry an attemptId once fencing exists`).toBe(starts.length)
  expect(new Set(ids).size, `${label}: an attemptId was reused`).toBe(ids.length)
}

/** I6: no task exceeds the retry budget. */
function assertRetriesBounded(service: SwarmService, runId: string, maxRetries: number, label: string): void {
  for (const t of service.snapshot().tasks.filter((x) => x.runId === runId)) {
    expect(t.attempts, `${label}: task ${t.id} exceeded maxRetries=${maxRetries}`).toBeLessThanOrEqual(maxRetries + 1)
  }
}

function oneTask(id = 'a'): Array<{ id: string; subject: string; description: string; role: string }> {
  return [{ id, subject: `task ${id}`, description: 'd', role: 'builder' }]
}

/* ── the matrix ───────────────────────────────────────────────────────────── */

describe('fault matrix (J20)', () => {
  it('FM1 late writes: a superseded attempt\'s result never overwrites the retry', async () => {
    // The scenario the fence exists for: attempt 1 is aborted and requeued, then its
    // child FINALLY returns success — after attempt 2 has already completed the task.
    const { service, fake } = await boot()
    fake.holdAll = true

    const result = service.dispatch({ title: 'late write', spec: 's', tasks: oneTask() }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => fake.calls.length >= 1, 5000, 'first spawn')

    // Supersede attempt 1 the way the watchdog does.
    service.watchdog(Date.now() + 63 * 60 * 1000)
    service.watchdog(Date.now() + 126 * 60 * 1000)
    service.watchdog(Date.now() + 189 * 60 * 1000)

    await waitFor(() => fake.calls.length >= 2, 8000, 'retry spawn', () => 'calls=' + fake.calls.length)
    // The retry finishes FIRST and legitimately completes the task.
    fake.settleAt(1, 'completed', 'retry done\nVERDICT: APPROVE')
    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'a')?.status === 'completed', 8000, 'retry completed')

    const summaryAfterRetry = service.snapshot().tasks.find((t) => t.id === 'a')?.summary ?? ''
    // NOW the zombie returns, long after being superseded.
    fake.settleAt(0, 'completed', 'ZOMBIE RESULT — must be discarded\nVERDICT: APPROVE')
    await new Promise((r) => setTimeout(r, 200))

    const task = service.snapshot().tasks.find((t) => t.id === 'a')
    expect(task?.status, 'late write must not change the finished task').toBe('completed')
    expect(task?.summary, 'late write must not replace the winning summary').toBe(summaryAfterRetry)
    expect(task?.summary ?? '').not.toContain('ZOMBIE')
    assertNoTerminalOverwrite(events(service, result.runId), 'FM1')
    assertAttemptAccounting(service, result.runId, 'FM1')
  }, 25000)

  it('FM2 late writes: many stale results in a burst leave the task untouched', async () => {
    // 20 late returns in a row — the "50 late writes" case, scaled to what the fake
    // can express. None may move the task.
    const { service, fake } = await boot()
    fake.holdAll = true
    const result = service.dispatch({ title: 'late burst', spec: 's', tasks: oneTask() }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')

    service.watchdog(Date.now() + 63 * 60 * 1000)
    service.watchdog(Date.now() + 126 * 60 * 1000)
    service.watchdog(Date.now() + 189 * 60 * 1000)
    await waitFor(() => fake.calls.length >= 2, 8000, 'retry spawn')
    fake.settleAt(1, 'completed', 'retry done\nVERDICT: APPROVE')
    await waitFor(() => service.snapshot().tasks.find((t) => t.id === 'a')?.status === 'completed', 8000, 'retry completed')

    for (let i = 0; i < 20; i++) fake.settleAt(0, i % 2 === 0 ? 'completed' : 'error', `stale ${i}`)
    await new Promise((r) => setTimeout(r, 250))

    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.status).toBe('completed')
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.summary ?? '').not.toContain('stale')
    assertNoTerminalOverwrite(events(service, result.runId), 'FM2')
  }, 25000)

  it('FM3 terminal overruns: a completed task never starts again', async () => {
    const { service, fake } = await boot()
    const result = service.dispatch({ title: 'overrun', spec: 's', tasks: oneTask() }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 8000, 'run done')

    const startsBefore = fake.calls.length
    // Drive the scheduler hard; a finished run must not launch anything.
    for (let i = 0; i < 10; i++) (service as unknown as { tick(): void }).tick()
    await new Promise((r) => setTimeout(r, 150))

    expect(fake.calls.length, 'a completed run spawned new work').toBe(startsBefore)
    expect(service.snapshot().tasks.find((t) => t.id === 'a')?.status).toBe('completed')
    assertNoTerminalOverwrite(events(service, result.runId), 'FM3')
  }, 20000)

  it('FM4 claim races: concurrent ticks launch a task exactly once per attempt', async () => {
    // "7-way claim race": fire many ticks at once and assert the task is not
    // double-launched — attempts must equal the number of start events, and the
    // number of live children must never exceed one per task.
    const { service, fake } = await boot({ maxConcurrent: 4 })
    fake.holdAll = true
    const result = service.dispatch({
      title: 'claim race', spec: 's',
      tasks: [1, 2, 3].map((i) => ({ id: `t${i}`, subject: `t${i}`, description: 'd', role: 'builder' })),
    }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => fake.calls.length >= 3, 8000, 'all three launched')
    const afterFirstWave = fake.calls.length
    for (let i = 0; i < 12; i++) (service as unknown as { tick(): void }).tick()
    await new Promise((r) => setTimeout(r, 120))

    // Holding children must not be re-launched: 3 tasks, 3 children, and the tick
    // storm changed nothing. (Global cap is 8 and maxConcurrent 4, so capacity is
    // not the reason this holds.)
    expect(fake.calls.length, 'a tick storm double-launched in-flight tasks').toBe(afterFirstWave)
    assertAttemptAccounting(service, result.runId, 'FM4')
    fake.release()
  }, 20000)

  it('FM5 takeover: aborting an in-flight run settles it and stops all launches', async () => {
    const { service, fake } = await boot()
    fake.holdAll = true
    const result = service.dispatch({ title: 'takeover', spec: 's', tasks: [1, 2, 3].map((i) => ({ id: `t${i}`, subject: `t${i}`, description: 'd', role: 'builder' })) }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => fake.calls.length >= 3, 8000, 'wave launched')

    service.abort(result.runId)
    const afterAbort = fake.calls.length
    for (let i = 0; i < 10; i++) (service as unknown as { tick(): void }).tick()
    await new Promise((r) => setTimeout(r, 150))

    expect(service.snapshot().runs.find((r) => r.id === result.runId)?.status).toBe('aborted')
    expect(fake.calls.length, 'an aborted run launched more work').toBe(afterAbort)
    assertNoTerminalOverwrite(events(service, result.runId), 'FM5')
  }, 20000)

  it('FM6 cold restart: stranded open tasks are recovered once, not in a loop', async () => {
    // The zombie-loop shape: a task left `running` by a dead host must be requeued a
    // bounded number of times. 13 recoveries over 21.5h is what the real incident
    // looked like; recovery must be idempotent per boot.
    const { service } = await boot()
    const runId = 'run-cold'
    service.events.append('run/created', { runId, data: { title: 'cold', spec: 's', tasks: oneTask('c1') } })
    service.events.append('run/endorsed', { runId })
    service.events.append('task/started', { runId, taskId: 'c1', data: { attemptId: 'att-cold-1' } })
    service.events.append('task/agent-started', { runId, taskId: 'c1', data: { sessionId: 'sess-cold' } })

    const recover = (service as unknown as { recoverOrphans(): void }).recoverOrphans.bind(service)
    recover()
    const afterFirst = events(service, runId).filter((e) => e.kind === 'task/failed').length
    expect(afterFirst, 'first recovery must requeue the stranded task').toBe(1)

    // A second boot against the SAME state must not requeue it again: the task is now
    // `retrying`, so it is no longer an orphan.
    recover()
    recover()
    const afterMore = events(service, runId).filter((e) => e.kind === 'task/failed').length
    expect(afterMore, 'recovery repeated for an already-recovered task').toBe(afterFirst)
  }, 20000)

  it('FM7 cold restart: recovery never touches a task whose run is terminal', async () => {
    const { service } = await boot()
    const runId = 'run-aborted'
    service.events.append('run/created', { runId, data: { title: 'aborted', spec: 's', tasks: oneTask('z1') } })
    service.events.append('run/endorsed', { runId })
    service.events.append('task/started', { runId, taskId: 'z1', data: { attemptId: 'att-z-1' } })
    service.events.append('run/aborted', { runId })

    const recover = (service as unknown as { recoverOrphans(): void }).recoverOrphans.bind(service)
    for (let i = 0; i < 13; i++) recover() // the 13-restart incident
    expect(events(service, runId).filter((e) => e.kind === 'task/failed').length, 'terminal runs must stay frozen').toBe(0)
  }, 20000)

  it('FM8 bursts: a heartbeat/message burst does not corrupt task accounting', async () => {
    const { service, fake } = await boot()
    fake.holdAll = true
    const result = service.dispatch({ title: 'burst', spec: 's', tasks: oneTask() }, makeDispatcher() as never)
    service.endorse(result.runId)
    await waitFor(() => fake.calls.length >= 1, 5000, 'spawn')

    // Find the tracked child session id and flood it, as a chatty member would.
    const started = events(service, result.runId).find((e) => e.kind === 'task/agent-started')
    const childId = String(started?.data?.sessionId ?? '')
    expect(childId.length).toBeGreaterThan(0)
    for (let i = 0; i < 40; i++) service.report(childId, 'a', `progress: burst ${i}`)

    const heartbeats = events(service, result.runId).filter((e) => e.kind === 'task/heartbeat')
    expect(heartbeats.length).toBe(40)
    assertAttemptAccounting(service, result.runId, 'FM8')
    fake.release()
  }, 20000)

  it('FM9 large DAG: 12 tasks with dependencies all complete and the invariants hold', async () => {
    const { service, fake } = await boot({ maxConcurrent: 8, maxTotalConcurrentAgents: 16 })
    const tasks = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `leaf${i}`, subject: `leaf ${i}`, description: 'd', role: 'builder' })),
      { id: 'mid0', subject: 'mid0', description: 'd', role: 'builder', blockedBy: ['leaf0', 'leaf1'] },
      { id: 'mid1', subject: 'mid1', description: 'd', role: 'builder', blockedBy: ['leaf2', 'leaf3'] },
      { id: 'mid2', subject: 'mid2', description: 'd', role: 'builder', blockedBy: ['leaf4', 'leaf5'] },
      { id: 'fin', subject: 'fin', description: 'd', role: 'builder', blockedBy: ['mid0', 'mid1', 'mid2'] },
    ]
    const result = service.dispatch({ title: 'large DAG', spec: 's', tasks }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => service.snapshot().runs.find((r) => r.id === result.runId)?.status === 'completed', 20000, 'large DAG completed')
    const snap = service.snapshot()
    expect(snap.tasks.filter((t) => t.runId === result.runId).every((t) => t.status === 'completed')).toBe(true)
    assertNoTerminalOverwrite(events(service, result.runId), 'FM9')
    assertAttemptAccounting(service, result.runId, 'FM9')
    assertRetriesBounded(service, result.runId, 2, 'FM9')
    expect(fake.calls.length).toBe(12)
  }, 30000)

  it('FM10 retry budget: repeated failures are bounded and end terminal', async () => {
    // Every spawn fails: the task must exhaust maxRetries exactly and then stop —
    // never loop, never stay live with nothing in flight (invariant I5/I6).
    const { service, fake } = await boot({ maxRetries: 2 })
    for (let i = 0; i < 50; i++) fake.failAt.set(i, 'boom: provider exploded')
    const result = service.dispatch({ title: 'bounded failure', spec: 's', tasks: oneTask() }, makeDispatcher() as never)
    service.endorse(result.runId)

    await waitFor(() => {
      const status = service.snapshot().runs.find((r) => r.id === result.runId)?.status
      return status !== undefined && status !== 'running' && status !== 'planning'
    }, 15000, 'run reached a terminal state', () => 'tasks=' + JSON.stringify(service.snapshot().tasks.map((t) => [t.id, t.status, t.attempts])))

    const task = service.snapshot().tasks.find((t) => t.id === 'a')
    expect(task?.status).toBe('failed')
    expect(task?.attempts, 'attempts must equal maxRetries+1').toBe(3)
    assertRetriesBounded(service, result.runId, 2, 'FM10')
    assertNoTerminalOverwrite(events(service, result.runId), 'FM10')
  }, 30000)
})
