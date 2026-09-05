import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { PLUGIN_VERSION, type SwarmConfig } from './config.js'
import { validateDag } from './domain/dag.js'
import { DutyTableStore } from './domain/duty-table.js'
import { EventStore } from './domain/event-store.js'
import { fold, isReady, newState, runningCount, taskKeyOf, type SwarmState } from './domain/projection.js'
import type { BoardSnapshot } from './board.js'
import { buildBoardSnapshot } from './board.js'
import { spawnTaskAgent, buildReviewPrompt, parseVerdict, type SpawnDeps } from './dispatch/spawn.js'
import type { DispatchInput, DispatchResult, DutyTable, ModelRef, RoleConfig, Run, Task, TaskSpec } from './domain/types.js'

const execAsync = promisify(exec)

/** Classify a spawn-failure reason for pause (A3) and adaptive-concurrency (K1) decisions. */
function classifyFailure(reason: string): 'quota' | 'provider' | 'other' {
  if (/quota|insufficient (balance|credit|funds)|balance (exhausted|depleted)|402|payment required|credit (ran out|exhausted)/i.test(reason)) return 'quota'
  if (/timeout|timed out|rate limit|429|empty response|stream|503|502|server error|transport|econn/i.test(reason)) return 'provider'
  return 'other'
}

/** Canonical workspace compare: forward slashes, no trailing separator, case-folded on Windows. */
function normalizePath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Read the durable session header's cwd without booting the session: the log's
 * first zstd frame is the header event itself, so decode exactly that frame.
 */
function decodeSessionHeaderCwd(logPath: string): string | undefined {
  try {
    const buf = readFileSync(logPath)
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const start = buf.indexOf(magic)
    if (start === -1) return undefined
    let end = buf.indexOf(magic, start + 1)
    if (end === -1) end = buf.length
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    const header = JSON.parse(text.split('\n')[0]) as { cwd?: unknown }
    return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  } catch {
    return undefined
  }
}

interface InFlight {
  controller: AbortController
  taskKey: string
  childSessionId?: string
}

/** Structural view of ctx.agents for anchor creation (see ensureAnchor). */
interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string; delegationDepth?: number; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (anchorCtx: unknown) => void | Promise<void>
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>
  /** Live-agent lookup by session id (workspace resolution). */
  get?(id: string): { session?: { header?: { cwd?: string } } } | undefined
}

/** Structural view of the agentPresets service for anchor composition. */
interface PresetsLike {
  mount(anchorCtx: unknown, id?: string): Promise<unknown>
}

/**
 * Capture the dispatching agent's world as plain JSON while it is alive:
 * its preset, model route, and workspace — everything later spawns need once
 * the dispatching session is gone. Reads are defensive: a dispatcher whose
 * fiber already went inactive still answers plain scope-chain reads, and any
 * failure just drops that field.
 */
function captureDispatchContext(parent: Agent | undefined): Partial<Run['dispatch']> {
  if (parent === undefined) return {}
  const captured: Partial<Run['dispatch']> = {}
  try {
    const options = (parent as { options?: { provider?: string; model?: string } }).options
    if (typeof options?.provider === 'string' && typeof options.model === 'string'
      && options.provider.length > 0 && options.model.length > 0) {
      captured.provider = options.provider
      captured.model = options.model
    }
  } catch { /* route unreadable — leave unset */ }
  try {
    const header = (parent as { session?: { header?: { id?: string; cwd?: string } } }).session?.header
    if (typeof header?.id === 'string' && header.id.length > 0) captured.sessionId = header.id
    if (typeof header?.cwd === 'string' && header.cwd.length > 0) captured.cwd = header.cwd
  } catch { /* header unreadable — leave unset */ }
  try {
    const presets = (parent as { ctx?: { get(name: string): unknown } }).ctx?.get('agentPresets') as
      | { composedPreset(agentCtx: unknown): string | undefined }
      | undefined
    const presetId = presets?.composedPreset?.((parent as { ctx?: unknown }).ctx)
    if (typeof presetId === 'string' && presetId.length > 0) captured.presetId = presetId
  } catch { /* preset unreadable — leave unset */ }
  return captured
}

/**
 * The host-side swarm service: duty table + JSONL event store + dispatcher.
 * State is folded from the event log on every change; the dispatcher launches
 * one-shot task agents through ctx.subagents with the role's model chain.
 */
export class SwarmService extends Service {
  private readonly swarmConfig: SwarmConfig
  readonly events: EventStore
  readonly duty: DutyTableStore
  readonly startedAt: number

  private state: SwarmState = newState()
  private stateDirty = true
  private readonly inFlight = new Map<string, InFlight>()
  /** The dispatching agent per run — provenance and cwd source, never the spawn route (see ensureAnchor). */
  private readonly runParents = new Map<string, Agent>()
  /** Service-owned idle anchor agents every spawn of a run is routed through. */
  private readonly runAnchors = new Map<string, { agent: Agent; dispose(): Promise<void> }>()
  /** K1: per-run adaptive launch capacity (shrinks on provider-class failures, recovers on completions). */
  private readonly adaptiveLimits = new Map<string, number>()
  /** Last silence-nudge timestamp per in-flight task (dedupes re-nudges). */
  private readonly nudgedAt = new Map<string, number>()
  private readonly sessionTasks = new Map<string, { taskKey: string; effort?: string }>()
  private tickScheduled = false

  constructor(ctx: Context, config: SwarmConfig) {
    super(ctx, 'swarm')
    this.swarmConfig = config
    this.startedAt = Date.now()
    mkdirSync(config.storageDir, { recursive: true })
    this.events = new EventStore(join(config.storageDir, 'events.jsonl'))
    this.duty = new DutyTableStore(join(config.storageDir, 'duty-table.json'))
    this.recoverOrphans()
    this.events.subscribe(() => {
      this.stateDirty = true
      this.scheduleTick()
    })
    // Watchdog: abort task agents that go silent past staleTimeoutSeconds.
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          this.watchdog()
        } catch (err) {
          this.ctx.logger('swarm').warn('watchdog sweep failed: %s', String(err))
        }
      }, 60000)
      return () => clearInterval(timer)
    })
    this.ctx.logger('swarm').info('swarm service ready v%s (storage: %s)', PLUGIN_VERSION, config.storageDir)
  }

  // ── state ────────────────────────────────────────────────────────────────

  private view(): SwarmState {
    if (this.stateDirty) {
      this.state = fold(this.events.all())
      this.stateDirty = false
    }
    return this.state
  }

  /** Tasks orphaned by a host restart (running/dispatching/reviewing with no live run object). */
  private recoverOrphans(): void {
    const state = fold(this.events.all())
    let recovered = false
    for (const task of state.tasks.values()) {
      if (task.status === 'running' || task.status === 'dispatching' || task.status === 'reviewing') {
        this.events.append('task/failed', {
          runId: task.runId, taskId: task.id,
          data: { retry: task.attempts <= this.swarmConfig.maxRetries, reason: 'host restarted mid-flight' },
        })
        recovered = true
      }
    }
    if (recovered) this.ctx.logger('swarm').info('recovered orphaned running tasks after restart')
  }

  /**
   * Watchdog sweep. Two tiers over a running task's silence:
   * past `nudgeAfterMinutes` without a note → a `task/nudged` marker on the
   * board (early warning, re-nudged per additional silent window); past
   * `staleTimeoutSeconds` → the agent is aborted and the task requeued.
   * `now` is injectable for tests.
   */
  watchdog(now = Date.now()): void {
    const state = this.view()
    const staleMs = this.swarmConfig.staleTimeoutSeconds * 1000
    const nudgeMs = this.swarmConfig.nudgeAfterMinutes * 60000
    for (const [key, flight] of [...this.inFlight]) {
      const task = state.tasks.get(key)
      if (task === undefined) {
        this.inFlight.delete(key)
        continue
      }
      if (this.view().runs.get(task.runId)?.status === 'aborted') continue
      if (now - task.updatedAt > staleMs) {
        this.inFlight.delete(key)
        flight.controller.abort()
        this.events.append('task/failed', {
          runId: task.runId, taskId: task.id,
          data: { retry: task.attempts <= this.swarmConfig.maxRetries, reason: `stale: no progress for ${Math.round(staleMs / 1000)}s (watchdog)` },
        })
        this.ctx.logger('swarm').warn('watchdog aborted stale task %s', key)
        continue
      }
      // Early-warning tier: surface long silences long before the reclaim.
      if (nudgeMs > 0 && task.status === 'running') {
        const last = task.lastNoteAt ?? task.updatedAt
        const silentMs = now - last
        const lastNudge = this.nudgedAt.get(key) ?? 0
        if (silentMs > nudgeMs && now - lastNudge > nudgeMs) {
          this.nudgedAt.set(key, now)
          this.events.append('task/nudged', {
            runId: task.runId, taskId: task.id,
            data: { silentMinutes: Math.round(silentMs / 60000) },
          })
        }
      }
    }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  /**
   * Detect concurrent tasks claiming the same exclusive write scope: two tasks
   * that share a `writes` entry and have no dependency path between them may
   * edit the same file at the same time. Non-fatal — surfaced as warnings.
   */
  private writeOverlapWarnings(tasks: TaskSpec[]): string[] {
    const reach = new Map<string, Set<string>>()
    for (const task of tasks) {
      const seen = new Set<string>()
      const stack = [...(task.blockedBy ?? [])]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (seen.has(current)) continue
        seen.add(current)
        const upstream = tasks.find((t) => t.id === current)
        if (upstream !== undefined) stack.push(...(upstream.blockedBy ?? []))
      }
      reach.set(task.id, seen)
    }
    const warnings: string[] = []
    for (let i = 0; i < tasks.length; i++) {
      const a = tasks[i]!
      if (a.writes === undefined || a.writes.length === 0) continue
      for (let j = i + 1; j < tasks.length; j++) {
        const b = tasks[j]!
        if (b.writes === undefined || b.writes.length === 0) continue
        const shared = a.writes.find((f) => b.writes!.some((g) => g.toLowerCase() === f.toLowerCase()))
        if (shared === undefined) continue
        if (reach.get(a.id)?.has(b.id) || reach.get(b.id)?.has(a.id)) continue
        warnings.push(`tasks "${a.id}" and "${b.id}" may run concurrently and both declare write scope over "${shared}" — consider blockedBy or narrower scopes`)
        if (warnings.length >= 5) return warnings
      }
    }
    return warnings
  }

  dispatch(input: DispatchInput, parent: Agent | undefined): DispatchResult {
    const tasks: TaskSpec[] = input.tasks
    if (tasks.length === 0) throw new Error('a run needs at least one task')
    const dag = validateDag(tasks)
    if (!dag.valid) throw new Error(`invalid task DAG: ${dag.errors.join('; ')}`)
    const known = Object.keys(this.duty.get().roles)
    const unknownRoles = [...new Set(tasks.map((t) => t.role).filter((r) => !known.includes(r)))]
    if (unknownRoles.length > 0) throw new Error(`unknown roles ${unknownRoles.join(', ')} — known: ${known.join(', ')}`)
    const writeWarnings = this.writeOverlapWarnings(tasks)

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.events.append('run/created', {
      runId,
      data: {
        title: input.title,
        spec: input.spec,
        tasks,
        dispatch: captureDispatchContext(parent),
      },
    })
    if (parent !== undefined) this.runParents.set(runId, parent)
    if (input.endorse === true && this.swarmConfig.requireManualEndorsement !== true) {
      this.events.append('run/endorsed', { runId })
    }
    this.scheduleTick()
    return {
      runId,
      status: this.view().runs.get(runId)?.status ?? 'planning',
      taskCount: tasks.length,
      ...(writeWarnings.length > 0 ? { warnings: writeWarnings } : {}),
    }
  }

  endorse(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    if (run.status !== 'planning' && run.status !== 'awaiting-endorsement') {
      throw new Error(`run ${runId} is ${run.status}; only unendorsed runs can be endorsed`)
    }
    this.events.append('run/endorsed', { runId })
  }

  abort(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    for (const [key, flight] of this.inFlight) {
      if (flight.taskKey.startsWith(runId + '/')) {
        flight.controller.abort()
        this.inFlight.delete(key)
      }
    }
    this.events.append('run/aborted', { runId })
    this.releaseAnchor(runId)
  }

  /** Heartbeat from a task agent, authenticated by its child session id. */
  report(childAgentId: string, taskId: string, note: string): string {
    const entry = this.sessionTasks.get(childAgentId)
    if (entry === undefined) throw new Error('this agent is not a tracked swarm task agent')
    const task = this.view().tasks.get(entry.taskKey)
    if (task === undefined || task.id !== taskId) throw new Error(`task ${taskId} is not assigned to this agent`)
    this.events.append('task/heartbeat', { runId: task.runId, taskId, data: { note } })
    return 'ok'
  }

  setDutyTable(next: DutyTable, actor: string): DutyTable {
    if (next.version !== 1) throw new Error('duty table version must be 1')
    if (next.roles === undefined || typeof next.roles !== 'object') throw new Error('duty table needs a roles object')
    for (const [id, role] of Object.entries(next.roles)) {
      if (role.id !== id) throw new Error(`role ${id} has mismatched id ${String(role.id)}`)
      if (!Array.isArray(role.fallbacks)) throw new Error(`role ${id} needs a fallbacks array`)
    }
    const saved = this.duty.save({ ...next, override: next.override })
    this.events.append('duty/updated', { data: { actor } })
    return saved
  }

  /**
   * Resolve the workspace (cwd) a session belongs to: the live agent's
   * session header first, then the persisted session log's durable header.
   * Undefined = unresolvable (the caller falls back to the unfiltered view).
   */
  resolveSessionWorkspace(sessionId: string): string | undefined {
    if (sessionId.length === 0) return undefined
    try {
      const agents = this.ctx.get('agents') as AgentsLike | undefined
      const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      const liveCwd = (live as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
      if (typeof liveCwd === 'string' && liveCwd.length > 0) return liveCwd
    } catch { /* live lookup unavailable — fall through to the durable header */ }
    try {
      // $DSH_HOME/sessions/<workspace-dir>/<sessionId>/session.jsonl.zstd
      const sessionsRoot = join(dirname(dirname(this.swarmConfig.storageDir)), 'sessions')
      for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const logPath = join(sessionsRoot, entry.name, sessionId, 'session.jsonl.zstd')
        if (!existsSync(logPath)) continue
        return decodeSessionHeaderCwd(logPath)
      }
    } catch { /* best effort */ }
    return undefined
  }

  snapshot(filter?: { session?: string; cwd?: string }): BoardSnapshot {
    const state = this.view()
    let effective = state
    let scopeCwd: string | undefined
    let scopeUnresolvable = false
    if (filter?.cwd !== undefined || filter?.session !== undefined) {
      const cwd = filter?.cwd !== undefined
        ? filter.cwd
        : (filter?.session !== undefined ? this.resolveSessionWorkspace(filter.session) : undefined)
      if (cwd === undefined) {
        // Couldn't tie the request to a workspace: serve the unfiltered board
        // and say so, rather than showing an empty screen.
        scopeUnresolvable = true
      } else {
        scopeCwd = cwd
        const norm = normalizePath(cwd)
        const keep = new Set<string>()
        for (const run of state.runs.values()) {
          const runCwd = run.dispatch?.cwd
          // Runs without a recorded workspace (legacy) stay in the global view only.
          if (runCwd !== undefined && normalizePath(runCwd) === norm) keep.add(run.id)
        }
        effective = {
          runs: new Map([...state.runs.entries()].filter(([id]) => keep.has(id))),
          tasks: new Map([...state.tasks.entries()].filter(([, t]) => keep.has(t.runId))),
        }
      }
    }
    return buildBoardSnapshot(effective, this.duty.get(), this.events.seq, PLUGIN_VERSION, { cwd: scopeCwd, unresolvable: scopeUnresolvable })
  }

  statusText(runId?: string): string {
    const snap = this.snapshot()
    const runs = runId !== undefined ? snap.runs.filter((r) => r.id === runId) : snap.runs
    if (runs.length === 0) return runId !== undefined ? `unknown run ${runId}` : 'no swarm runs yet'
    const lines: string[] = []
    for (const run of runs) {
      const tasks = snap.tasks.filter((t) => t.runId === run.id)
      const byStatus = new Map<string, number>()
      for (const task of tasks) byStatus.set(task.status, (byStatus.get(task.status) ?? 0) + 1)
      lines.push(`${run.id} [${run.status}] "${run.title}" — ${tasks.length} tasks: ${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(', ')}`)
      for (const task of tasks) {
        lines.push(`  - ${task.id} [${task.status}] (${task.role}${task.agent?.model !== undefined ? ` @ ${task.agent.provider ?? ''}/${task.agent.model}` : ''})${task.lastNote !== undefined ? ` — ${String(task.lastNote).slice(0, 160)}` : ''}`)
      }
    }
    return lines.join('\n')
  }

  // ── dispatcher ───────────────────────────────────────────────────────────

  /**
   * The live agent every task-agent spawn for a run is routed through.
   *
   * Spawning through the DISPATCHING agent couples the run's lifetime to that
   * agent's context: when its turn ends and its session unloads (one-shot
   * subagent callers) or the session closes, every later spawn of the run dies
   * with "cannot create effect on inactive context". A run must outlive its
   * dispatcher, so each run gets a service-owned idle ANCHOR agent created on
   * first launch.
   *
   * The anchor joins the dispatch context captured at dispatch() — the
   * dispatcher's preset (falling back to the deployment default preset) and
   * model route — because a bare factory agent joins NO preset, and in a
   * rostered deployment its children then fail prompt assembly ("addressed a
   * model without joining any agent preset") and inherit no model route. The
   * durable meta records the same preset so a cold resume rebuilds the same
   * world. Hosts without an agents factory (unit tests) fall back to the
   * dispatching agent.
   */
  private async ensureAnchor(runId: string): Promise<Agent | undefined> {
    const existing = this.runAnchors.get(runId)
    if (existing !== undefined) return existing.agent
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    if (agents === undefined) return this.runParents.get(runId)
    const captured = this.view().runs.get(runId)?.dispatch
    const handle = await agents.create({
      sessionId: SessionId(randomUUID()),
      meta: {
        ...(captured?.cwd !== undefined ? { cwd: captured.cwd } : {}),
        delegationDepth: 0,
        ...(captured?.presetId !== undefined ? { agentPreset: captured.presetId } : {}),
      },
      ...(captured?.provider !== undefined && captured.model !== undefined
        ? { agentOptions: { provider: captured.provider, model: captured.model } }
        : {}),
      setup: async (anchorCtx) => {
        const presets = (anchorCtx as { get(name: string): unknown }).get('agentPresets') as PresetsLike | undefined
        if (presets !== undefined) {
          // undefined id = the deployment default preset (recovered runs).
          await presets.mount(anchorCtx, captured?.presetId)
        }
      },
    })
    // The run may have gone terminal (abort) while the factory was creating.
    if (this.view().runs.get(runId)?.status !== 'running') {
      void handle.dispose().catch(() => {})
      return undefined
    }
    this.runAnchors.set(runId, handle)
    this.ctx.logger('swarm').info('run %s anchored to idle agent %s', runId, String(handle.agent.id))
    return handle.agent
  }

  /**
   * Model candidate chain for a role, with the run's captured route filling
   * every "inherit the default" (empty) entry. Undefined when no route at all
   * is resolvable — the caller then fails the task with an actionable reason.
   */
  private resolveCandidates(run: Run, roleId: string, task?: Task): Array<{ provider: string; model: string }> | undefined {
    // K4: an explicit per-task model override leads the whole chain.
    if (task?.model !== undefined && task.model.provider.length > 0 && task.model.model.length > 0) {
      const override: ModelRef = { provider: task.model.provider, model: task.model.model }
      const rest = this.duty.resolveChain(roleId).filter((c) => !(c.provider === override.provider && c.model === override.model))
      return [override, ...rest]
    }
    const fallback = run.dispatch?.provider !== undefined && run.dispatch?.model !== undefined
      ? { provider: run.dispatch.provider, model: run.dispatch.model }
      : undefined
    const chain = this.duty.resolveChain(roleId).map((candidate) =>
      (candidate.provider.length === 0 || candidate.model.length === 0) && fallback !== undefined
        ? fallback
        : candidate,
    )
    // An unpinned role resolves to an EMPTY chain ("inherit the deployment
    // default") — with a captured run route that default is the route.
    if (chain.length === 0 && fallback !== undefined) return [fallback]
    const first = chain[0]
    if (first === undefined || first.provider.length === 0 || first.model.length === 0) return undefined
    return chain
  }

  /** Dispose a run's anchor once the run reaches a terminal status. */
  private releaseAnchor(runId: string): void {
    const handle = this.runAnchors.get(runId)
    if (handle === undefined) return
    this.runAnchors.delete(runId)
    void handle.dispose().catch((err) => {
      this.ctx.logger('swarm').warn('anchor for run %s failed to dispose: %s', runId, String(err))
    })
  }

  /** K1: the launch capacity this run currently earns (shrinks on provider pain, recovers on success). */
  private effectiveConcurrency(runId: string): number {
    const adaptive = this.adaptiveLimits.get(runId)
    const base = this.swarmConfig.adaptiveConcurrency
      ? Math.min(this.swarmConfig.maxConcurrent, adaptive ?? this.swarmConfig.maxConcurrent)
      : this.swarmConfig.maxConcurrent
    return Math.max(1, base)
  }

  private shrinkConcurrency(runId: string): void {
    if (!this.swarmConfig.adaptiveConcurrency) return
    const next = Math.max(1, this.effectiveConcurrency(runId) - 1)
    this.adaptiveLimits.set(runId, next)
  }

  private growConcurrency(runId: string): void {
    if (!this.swarmConfig.adaptiveConcurrency) return
    if (this.effectiveConcurrency(runId) < this.swarmConfig.maxConcurrent) {
      this.adaptiveLimits.set(runId, this.effectiveConcurrency(runId) + 1)
    } else {
      this.adaptiveLimits.delete(runId)
    }
  }

  /** A1: the effort this attempt uses — primary first, then the ladder, then inherit. */
  private resolveEffort(role: RoleConfig, attemptNumber: number): string | undefined {
    const chain = [role.reasoningEffort, ...(role.effortFallbacks ?? [])]
      .filter((e): e is string => typeof e === 'string' && e.length > 0)
    if (chain.length === 0) return undefined
    return chain[Math.min(Math.max(0, attemptNumber - 1), chain.length - 1)]
  }

  /** J2: machine-check the evidence contract; null = pass, otherwise the first failure. */
  private async checkEvidence(task: Task): Promise<string | null> {
    const evidence = task.evidence
    if (evidence === undefined) return null
    const cwd = this.view().runs.get(task.runId)?.dispatch?.cwd ?? process.cwd()
    for (const file of evidence.files ?? []) {
      try {
        const info = statSync(join(cwd, file))
        if (!info.isFile() || info.size === 0) return `required file "${file}" is missing or empty`
      } catch {
        return `required file "${file}" is missing or empty`
      }
    }
    for (const command of evidence.commands ?? []) {
      try {
        await execAsync(command, { cwd, timeout: 120_000 })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return `evidence command failed: ${command} — ${message.slice(0, 300)}`
      }
    }
    return null
  }

  /** A3: stop launching, abort in-flight children, and park the run for a human resume. */
  private pauseRun(runId: string, cause: string): void {
    for (const [key, flight] of this.inFlight) {
      if (flight.taskKey.startsWith(runId + '/')) {
        flight.controller.abort()
        this.inFlight.delete(key)
      }
    }
    this.events.append('run/paused', { runId, data: { reason: `provider quota exhausted — resume from the Swarm dashboard after topping up (${cause})` } })
  }

  /** A3/K2: resume a paused (or requeue a terminally failed) run, keeping completed tasks. */
  resumeRun(runId: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'aborted') {
      throw new Error(`run ${runId} is ${run.status}; only paused or failed runs can be resumed`)
    }
    this.events.append('run/resumed', { runId })
    for (const id of run.taskIds) {
      const task = this.view().tasks.get(`${runId}/${id}`)
      if (task?.status === 'failed') {
        this.events.append('task/failed', { runId, taskId: id, data: { retry: true, reason: 'run resumed — requeued' } })
      }
    }
    this.scheduleTick()
  }

  /** J7: the human verdict on a human-gated review, from the dashboard. */
  review(runId: string, taskId: string, verdict: 'approve' | 'reject'): void {
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'reviewing' || task.humanReview !== true) {
      throw new Error(`task ${taskId} is not awaiting a human review`)
    }
    const reviews = (task.reviews ?? 0) + 1
    if (verdict === 'approve') {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'approve', feedback: 'approved by human review' } })
    } else {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'reject', reviews, feedback: 'rejected by human review — fix and resubmit' } })
    }
    this.scheduleTick()
  }

  /** C1: resolve when the watched scope changes (long-poll for dispatcher chats). */
  waitForChange(runId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (note: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        resolve(`${note}\n\n${this.statusText(runId)}`)
      }
      const unsubscribe = this.events.subscribe((event) => {
        if (runId === undefined || event.runId === undefined || event.runId === runId) {
          finish(`change at seq ${event.seq}: ${event.kind}${event.taskId !== undefined ? ` (${event.taskId})` : ''}`)
        }
      })
      const timer = setTimeout(() => finish(`no swarm changes within ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
      const onAbort = (): void => finish('wait aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private scheduleTick(): void {
    if (this.tickScheduled) return
    this.tickScheduled = true
    queueMicrotask(() => {
      this.tickScheduled = false
      try {
        this.tick()
      } catch (err) {
        this.ctx.logger('swarm').warn('dispatcher tick failed: %s', String(err))
      }
    })
  }

  /** Launch ready tasks up to the concurrency caps. Sync planning; spawns are staggered + fire-and-track. */
  private tick(): void {
    const state = this.view()
    for (const run of state.runs.values()) {
      if (run.status !== 'running') continue
      const tasks = run.taskIds
        .map((id) => state.tasks.get(`${run.id}/${id}`))
        .filter((t): t is Task => t !== undefined)
      // Cascade: a task whose blocker terminally failed/blocked can never
      // become ready — block it now so the run can reach a terminal status
      // instead of hanging in 'running' with a pending task forever.
      for (const task of tasks) {
        if (task.status === 'blocked') {
          // A5 auto-unblock: every blocker reached completed after a rescue/retry.
          const blockers = (task.blockedBy ?? []).map((b) => state.tasks.get(`${run.id}/${b}`)?.status)
          if (blockers.length > 0 && blockers.every((s) => s === 'completed')) {
            this.events.append('task/unblocked', { runId: run.id, taskId: task.id })
          }
          continue
        }
        if (task.status !== 'pending' && task.status !== 'retrying') continue
        const dead = (task.blockedBy ?? []).find((blocker) => {
          const status = state.tasks.get(`${run.id}/${blocker}`)?.status
          return status === 'failed' || status === 'blocked'
        })
        if (dead !== undefined) {
          this.events.append('task/blocked', {
            runId: run.id, taskId: task.id,
            data: { reason: `upstream task ${dead} did not complete` },
          })
        }
      }
      // A5: refresh — the appends above may have unblocked tasks just now.
      const fresh = this.view()
      const runTasks = run.taskIds
        .map((id) => fresh.tasks.get(`${run.id}/${id}`))
        .filter((t): t is Task => t !== undefined)
      const roleRunning = new Map<string, number>()
      for (const task of runTasks) {
        if (task.status === 'running' || task.status === 'dispatching' || task.status === 'reviewing') {
          roleRunning.set(task.role, (roleRunning.get(task.role) ?? 0) + 1)
        }
      }
      let capacity = this.effectiveConcurrency(run.id) - runningCount(fresh, run.id)
      let wave = 0
      for (const task of runTasks) {
        if (capacity <= 0) break
        if (!isReady(fresh, task)) continue
        if (this.inFlight.has(taskKeyOf(task))) continue
        const role = this.duty.role(task.role)
        const roleCap = role?.maxConcurrent
        if (roleCap !== undefined && (roleRunning.get(task.role) ?? 0) >= roleCap) continue
        const delayMs = wave === 0 ? 0 : this.swarmConfig.spawnStaggerMs * wave
        this.launchTask(run.id, task, delayMs)
        capacity -= 1
        wave += 1
        roleRunning.set(task.role, (roleRunning.get(task.role) ?? 0) + 1)
        fresh.tasks.get(taskKeyOf(task))!.status = 'dispatching'
      }
      this.checkRunCompletion(run.id)
    }
  }

  private launchTask(runId: string, task: Task, delayMs = 0): void {
    const role: RoleConfig | undefined = this.duty.role(task.role)
    const run = this.view().runs.get(runId)
    if (run === undefined || role === undefined) {
      this.events.append('task/blocked', { runId, taskId: task.id, data: { reason: 'run context unavailable' } })
      return
    }
    // K4: per-task model override wins; A1: per-attempt effort comes from the ladder.
    let candidates = this.resolveCandidates(run, task.role, task)
    if (candidates === undefined) {
      // No route and nothing to inherit — retrying cannot fix this.
      this.events.append('task/failed', {
        runId, taskId: task.id,
        data: {
          retry: false,
          reason: `no model route for role "${task.role}": pin a provider/model in the Swarm Roster, or dispatch from a session with a configured model`,
        },
      })
      return
    }
    // A6: from the second attempt on, rotate the chain so a persistently failing
    // primary gets a different model even when its error is not classed as
    // "model unavailable".
    if (task.attempts >= 1 && candidates.length > 1) {
      const offset = task.attempts % candidates.length
      candidates = [...candidates.slice(offset), ...candidates.slice(0, offset)]
    }
    const effort = this.resolveEffort(role, task.attempts + 1)
    const controller = new AbortController()
    const key = taskKeyOf(task)
    this.inFlight.set(key, { controller, taskKey: key })

    const startSpawn = (): void => {
      const deps = this.spawnDeps()
      void this.ensureAnchor(runId).then(async (parent) => {
        if (parent === undefined) {
          this.inFlight.delete(key)
          this.events.append('task/failed', {
            runId, taskId: task.id,
            data: {
              retry: task.attempts <= this.swarmConfig.maxRetries,
              reason: 'no spawn anchor available (agents service absent and the dispatching session is gone)',
            },
          })
          return
        }
        // A4: feed the retry its own history so it resumes instead of restarting.
        const priorNotes = task.attempts > 0
          ? this.events.all()
            .filter((e) => e.taskId === task.id && e.runId === runId && e.kind === 'task/heartbeat' && typeof e.data?.note === 'string')
            .slice(-6)
            .map((e) => String(e.data?.note))
          : undefined
        const outcome = await spawnTaskAgent(deps, {
          parent, run, task, role, candidates, signal: controller.signal,
          ...(role.toolFilter !== undefined ? { toolFilter: role.toolFilter } : {}),
          ...(priorNotes !== undefined && priorNotes.length > 0 ? { priorNotes } : {}),
          ...(task.evidence !== undefined ? { evidence: task.evidence } : {}),
          onFallback: (failed, next) => {
            this.events.append('task/model-fallback', {
              runId, taskId: task.id,
              data: {
                from: `${failed.provider}/${failed.model}`,
                ...(next !== undefined ? { provider: next.provider, model: next.model } : {}),
                reason: 'unavailable',
              },
            })
          },
          onStarted: (childSessionId) => {
            this.trackChildSession(childSessionId, key, effort)
            this.events.append('task/agent-started', { runId, taskId: task.id, data: { sessionId: childSessionId } })
          },
        })
        this.inFlight.delete(key)
        if (outcome.childSessionId !== undefined) this.forgetChildSession(outcome.childSessionId)
        const fresh = this.view().tasks.get(key)
        if (fresh === undefined) return
        if (this.view().runs.get(runId)?.status === 'aborted' || this.view().runs.get(runId)?.status === 'paused') return
        // The watchdog (or abort path) may already have recorded a terminal transition.
        if (fresh.status !== 'running' && fresh.status !== 'dispatching') return
        if (outcome.ok) {
          this.growConcurrency(runId)
          // J2: the evidence contract gates completion.
          if (task.evidence !== undefined) {
            const evidenceFailure = await this.checkEvidence(task)
            if (evidenceFailure !== null) {
              this.events.append('task/failed', {
                runId, taskId: task.id,
                data: {
                  retry: fresh.attempts <= this.swarmConfig.maxRetries,
                  reason: `evidence contract failed — ${evidenceFailure}`,
                },
              })
              return
            }
          }
          this.events.append('task/completed', {
            runId, taskId: task.id,
            data: { summary: outcome.summary ?? '' },
          })
          if (task.reviewBy !== undefined && task.reviewBy.length > 0) {
            if (task.reviewGate === 'human') {
              // J7: park the task for a human verdict on the dashboard.
              this.events.append('task/review-started', { runId, taskId: task.id, data: { reviewer: task.reviewBy, human: true } })
              this.scheduleTick()
            } else {
              void this.runReview(runId, task.id, task.reviewBy)
            }
          }
        } else {
          const reason = outcome.reason ?? `stop: ${outcome.stopReason ?? 'unknown'}`
          const failureClass = classifyFailure(reason)
          if (failureClass !== 'other') this.shrinkConcurrency(runId)
          if (failureClass === 'quota') {
            // A3: park the whole run — more attempts would just burn quota.
            this.events.append('task/failed', {
              runId, taskId: task.id,
              data: { retry: false, reason: `provider quota exhausted (before this failure: ${reason})` },
            })
            this.pauseRun(runId, reason)
            return
          }
          const retry = fresh.attempts <= this.swarmConfig.maxRetries
          this.events.append('task/failed', {
            runId, taskId: task.id,
            data: { retry, reason },
          })
        }
      }).catch((err: unknown) => {
        this.inFlight.delete(key)
        this.ctx.logger('swarm').warn('task %s crashed dispatcher bookkeeping: %s', key, String(err))
      })
    }

    this.events.append('task/started', {
      runId, taskId: task.id,
      data: {
        label: `swarm:${task.id}`,
        provider: candidates[0]?.provider,
        model: candidates[0]?.model,
      },
    })
    if (delayMs > 0) setTimeout(startSpawn, delayMs)
    else startSpawn()
  }

  /**
   * Review loop: a reviewer-role agent judges the completed task's output.
   * Approve → task stands; reject → requeue with feedback (capped at reviewLoops,
   * then fail-open with reviewExhausted); reviewer unavailable → fail-open.
   */
  private async runReview(runId: string, taskId: string, reviewerRoleId: string): Promise<void> {
    const key = `${runId}/${taskId}`
    const reviewerRole = this.duty.role(reviewerRoleId)
    const run = this.view().runs.get(runId)
    if (reviewerRole === undefined || run === undefined) {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: `reviewer role "${reviewerRoleId}" or run context unavailable` } })
      this.checkRunCompletion(runId)
      return
    }
    const candidates = this.resolveCandidates(run, reviewerRoleId)
    if (candidates === undefined) {
      // No reviewer route — fail-open per the review contract.
      this.events.append('task/reviewed', {
        runId, taskId,
        data: { verdict: 'error', feedback: `no model route for reviewer role "${reviewerRoleId}": pin a provider/model in the Swarm Roster` },
      })
      this.checkRunCompletion(runId)
      return
    }
    const controller = new AbortController()
    this.inFlight.set(key, { controller, taskKey: key })
    // task/review-started must land in the SAME synchronous block as the
    // task/completed append that scheduled this review: if an await separated
    // them, an interleaving dispatcher tick would see every task completed and
    // end the run before the review (let alone a reject-requeue) could run.
    this.events.append('task/review-started', { runId, taskId, data: { reviewer: reviewerRoleId } })
    const parent = await this.ensureAnchor(runId)
    if (parent === undefined) {
      this.inFlight.delete(key)
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: 'no spawn anchor available (agents service absent and the dispatching session is gone)' } })
      this.checkRunCompletion(runId)
      return
    }

    const deps = this.spawnDeps()
    const task = this.view().tasks.get(key)
    if (task === undefined) { this.inFlight.delete(key); return }
    let outcome
    try {
      outcome = await spawnTaskAgent(deps, {
        parent, run, task, role: reviewerRole, candidates, signal: controller.signal,
        prompt: buildReviewPrompt(run, task, reviewerRole),
        onFallback: (failed, next) => {
          this.events.append('task/model-fallback', {
            runId, taskId,
            data: {
              from: `${failed.provider}/${failed.model}`,
              ...(next !== undefined ? { provider: next.provider, model: next.model } : {}),
              reason: 'unavailable',
            },
          })
        },
        onStarted: (childSessionId) => {
          this.trackChildSession(childSessionId, key, reviewerRole.reasoningEffort)
          this.events.append('task/agent-started', { runId, taskId, data: { sessionId: childSessionId } })
        },
      })
    } catch (err) {
      this.inFlight.delete(key)
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: String(err instanceof Error ? err.message : err) } })
      this.checkRunCompletion(runId)
      return
    }
    this.inFlight.delete(key)
    if (outcome.childSessionId !== undefined) this.forgetChildSession(outcome.childSessionId)
    if (this.view().runs.get(runId)?.status === 'aborted') return
    if (this.view().tasks.get(key)?.status !== 'reviewing') return // watchdog/abort raced us

    if (!outcome.ok) {
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'error', feedback: outcome.reason ?? `reviewer stopped: ${outcome.stopReason ?? 'unknown'}` } })
      this.checkRunCompletion(runId)
      return
    }
    const verdict = parseVerdict(outcome.summary ?? '')
    const feedback = (outcome.summary ?? '').trim()
    if (verdict === 'reject') {
      const reviews = (this.view().tasks.get(key)?.reviews ?? 0) + 1
      const exhausted = reviews >= this.swarmConfig.reviewLoops
      this.events.append('task/reviewed', { runId, taskId, data: { verdict: 'reject', reviews, ...(exhausted ? { exhausted: true } : {}), feedback } })
      if (exhausted) this.checkRunCompletion(runId)
      else this.scheduleTick()
      return
    }
    this.events.append('task/reviewed', { runId, taskId, data: { verdict: verdict === 'approve' ? 'approve' : 'error', feedback: verdict === 'approve' ? feedback : 'reviewer gave no explicit verdict (fail-open)' } })
    this.checkRunCompletion(runId)
  }

  private checkRunCompletion(runId: string): void {
    const state = this.view()
    const run = state.runs.get(runId)
    if (run === undefined || run.status !== 'running') return
    const tasks = run.taskIds.map((id) => state.tasks.get(`${runId}/${id}`)).filter((t): t is Task => t !== undefined)
    if (tasks.length === 0) return
    // A run ends when every task is terminal. All completed → 'completed';
    // any terminally failed/blocked (after retries and the upstream cascade)
    // → 'failed' with the same report shape. Runs no longer hang in 'running'
    // forever behind a task that can never succeed.
    const terminal = ['completed', 'failed', 'blocked'] as const
    if (!tasks.every((t) => (terminal as readonly string[]).includes(t.status))) return
    const succeeded = tasks.every((t) => t.status === 'completed')
    const byStatus: Record<string, number> = {}
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    this.events.append(succeeded ? 'run/completed' : 'run/failed', {
      runId,
      data: {
        report: {
          completedAt: Date.now(),
          durationMs: Date.now() - run.createdAt,
          taskCount: tasks.length,
          byStatus,
          stats: run.stats ?? { fallbacks: 0, retries: 0, reviewsPassed: 0, reviewsRejected: 0 },
          tasks: tasks.map((task) => ({
            id: task.id,
            role: task.role,
            ...(task.agent?.model !== undefined ? { model: `${task.agent.provider ?? ''}/${task.agent.model}` } : {}),
            status: task.status,
            ...(task.reviewed === true ? { reviewed: true } : {}),
            ...(task.reviewExhausted === true ? { reviewExhausted: true } : {}),
            ...(task.summary !== undefined && task.summary.length > 0 ? { summary: task.summary.slice(0, 600) } : {}),
          })),
        },
      },
    })
    this.releaseAnchor(runId)
  }

  /** Requeue a failed/blocked task for another attempt (dashboard action or swarm_retry tool). */
  retryTask(runId: string, taskId: string, actorSessionId?: string): void {
    const run = this.view().runs.get(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    // A5: the recovery tool is for the dispatching session; the dashboard bypasses the gate.
    const owner = run.dispatch?.sessionId
    if (actorSessionId !== undefined && owner !== undefined && actorSessionId !== owner) {
      throw new Error(`swarm_retry is gated to the dispatching session (${owner}); use the Swarm dashboard instead`)
    }
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new Error(`task ${taskId} is ${task.status}; only failed or blocked tasks can be retried`)
    }
    // A5: a terminal run comes back to life when one of its tasks is retried.
    if (run.status === 'failed' || run.status === 'aborted' || run.status === 'completed') {
      this.events.append('run/resumed', { runId })
    }
    this.events.append('task/failed', { runId, taskId, data: { retry: true, reason: 'manual retry' } })
  }

  /** Track a spawned child session for report authentication + effort pinning. */
  trackChildSession(childSessionId: string, taskKey: string, effort?: string): void {
    this.sessionTasks.set(childSessionId, { taskKey, ...(effort !== undefined ? { effort } : {}) })
  }

  forgetChildSession(childSessionId: string): void {
    this.sessionTasks.delete(childSessionId)
  }

  /** Per-request reasoning effort for a tracked child (undefined = leave untouched). */
  effortFor(agentId: string): string | undefined {
    return this.sessionTasks.get(agentId)?.effort
  }

  /**
   * Spawn-provider deps resolved with ctx.get(): cordis throws
   * "cannot get property … without inject" on the ctx.subagents property,
   * and this plugin deliberately keeps subagents optional (profiles without
   * it still get roster/board; dispatch reports a clear per-task error).
   */
  private spawnDeps(): SpawnDeps {
    return {
      start: (request) => {
        const subagents = this.ctx.get('subagents') as { start(provider: string, request: unknown): unknown } | undefined
        if (subagents === undefined) throw new Error('subagents service unavailable in this host (spawn provider not mounted?)')
        return subagents.start('spawn', request as never) as never
      },
    }
  }
}
