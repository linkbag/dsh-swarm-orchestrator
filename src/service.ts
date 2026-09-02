import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
import type { DispatchInput, DispatchResult, DutyTable, RoleConfig, Task, TaskSpec } from './domain/types.js'

interface InFlight {
  controller: AbortController
  taskKey: string
  childSessionId?: string
}

/** Structural view of ctx.agents for anchor creation (see ensureAnchor). */
interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta?: { cwd?: string; delegationDepth?: number }
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>
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

  /** Abort in-flight agents whose task shows no progress within the stale timeout. */
  private watchdog(): void {
    const state = this.view()
    const staleMs = this.swarmConfig.staleTimeoutSeconds * 1000
    for (const [key, flight] of [...this.inFlight]) {
      const task = state.tasks.get(key)
      if (task === undefined) {
        this.inFlight.delete(key)
        continue
      }
      if (this.view().runs.get(task.runId)?.status === 'aborted') continue
      if (Date.now() - task.updatedAt > staleMs) {
        this.inFlight.delete(key)
        flight.controller.abort()
        this.events.append('task/failed', {
          runId: task.runId, taskId: task.id,
          data: { retry: task.attempts <= this.swarmConfig.maxRetries, reason: `stale: no progress for ${Math.round(staleMs / 1000)}s (watchdog)` },
        })
        this.ctx.logger('swarm').warn('watchdog aborted stale task %s', key)
      }
    }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  dispatch(input: DispatchInput, parent: Agent | undefined): DispatchResult {
    const tasks: TaskSpec[] = input.tasks
    if (tasks.length === 0) throw new Error('a run needs at least one task')
    const dag = validateDag(tasks)
    if (!dag.valid) throw new Error(`invalid task DAG: ${dag.errors.join('; ')}`)
    const known = Object.keys(this.duty.get().roles)
    const unknownRoles = [...new Set(tasks.map((t) => t.role).filter((r) => !known.includes(r)))]
    if (unknownRoles.length > 0) throw new Error(`unknown roles ${unknownRoles.join(', ')} — known: ${known.join(', ')}`)

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.events.append('run/created', {
      runId,
      data: { title: input.title, spec: input.spec, tasks },
    })
    if (parent !== undefined) this.runParents.set(runId, parent)
    if (input.endorse === true) {
      this.events.append('run/endorsed', { runId })
    }
    this.scheduleTick()
    return { runId, status: this.view().runs.get(runId)?.status ?? 'planning', taskCount: tasks.length }
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

  snapshot(): BoardSnapshot {
    const state = this.view()
    return buildBoardSnapshot(state, this.duty.get(), this.events.seq, PLUGIN_VERSION)
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
   * first launch — its cwd is captured from the dispatcher's session while the
   * dispatcher is still alive, and its scope chain is the deployment default
   * composition, so task agents never depend on the dispatching session's
   * ad-hoc grants. Hosts without an agents factory (unit tests) fall back to
   * the dispatching agent.
   */
  private async ensureAnchor(runId: string): Promise<Agent | undefined> {
    const existing = this.runAnchors.get(runId)
    if (existing !== undefined) return existing.agent
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    const dispatcher = this.runParents.get(runId)
    if (agents === undefined) return dispatcher
    const header = dispatcher?.session?.header
    const handle = await agents.create({
      sessionId: SessionId(randomUUID()),
      meta: {
        ...(header?.cwd !== undefined ? { cwd: header.cwd } : {}),
        delegationDepth: 0,
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

  /** Dispose a run's anchor once the run reaches a terminal status. */
  private releaseAnchor(runId: string): void {
    const handle = this.runAnchors.get(runId)
    if (handle === undefined) return
    this.runAnchors.delete(runId)
    void handle.dispose().catch((err) => {
      this.ctx.logger('swarm').warn('anchor for run %s failed to dispose: %s', runId, String(err))
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

  /** Launch ready tasks up to the concurrency cap. Synchronous planning; async spawns are fire-and-track. */
  private tick(): void {
    const state = this.view()
    for (const run of state.runs.values()) {
      if (run.status !== 'running') continue
      const tasks = run.taskIds
        .map((id) => state.tasks.get(`${run.id}/${id}`))
        .filter((t): t is Task => t !== undefined)
      let capacity = this.swarmConfig.maxConcurrent - runningCount(state, run.id)
      for (const task of tasks) {
        if (capacity <= 0) break
        if (!isReady(state, task)) continue
        if (this.inFlight.has(taskKeyOf(task))) continue
        this.launchTask(run.id, task)
        capacity -= 1
        state.tasks.get(taskKeyOf(task))!.status = 'dispatching'
      }
      this.checkRunCompletion(run.id)
    }
  }

  private launchTask(runId: string, task: Task): void {
    const role: RoleConfig | undefined = this.duty.role(task.role)
    const run = this.view().runs.get(runId)
    if (run === undefined || role === undefined) {
      this.events.append('task/blocked', { runId, taskId: task.id, data: { reason: 'run context unavailable' } })
      return
    }
    const candidates = this.duty.resolveChain(task.role)
    const controller = new AbortController()
    const key = taskKeyOf(task)
    this.inFlight.set(key, { controller, taskKey: key })

    this.events.append('task/started', {
      runId, taskId: task.id,
      data: {
        label: `swarm:${task.id}`,
        provider: candidates[0]?.provider,
        model: candidates[0]?.model,
      },
    })

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
      const outcome = await spawnTaskAgent(deps, {
        parent, run, task, role, candidates, signal: controller.signal,
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
          this.trackChildSession(childSessionId, key, role.reasoningEffort)
          this.events.append('task/agent-started', { runId, taskId: task.id, data: { sessionId: childSessionId } })
        },
      })
      this.inFlight.delete(key)
      if (outcome.childSessionId !== undefined) this.forgetChildSession(outcome.childSessionId)
      const fresh = this.view().tasks.get(key)
      if (fresh === undefined) return
      if (this.view().runs.get(runId)?.status === 'aborted') return
      // The watchdog (or abort path) may already have recorded a terminal transition.
      if (fresh.status !== 'running' && fresh.status !== 'dispatching') return
      if (outcome.ok) {
        this.events.append('task/completed', {
          runId, taskId: task.id,
          data: { summary: outcome.summary ?? '' },
        })
        if (task.reviewBy !== undefined && task.reviewBy.length > 0) {
          void this.runReview(runId, task.id, task.reviewBy)
        }
      } else {
        const retry = fresh.attempts <= this.swarmConfig.maxRetries
        this.events.append('task/failed', {
          runId, taskId: task.id,
          data: { retry, reason: outcome.reason ?? `stop: ${outcome.stopReason ?? 'unknown'}` },
        })
      }
    }).catch((err: unknown) => {
      this.inFlight.delete(key)
      this.ctx.logger('swarm').warn('task %s crashed dispatcher bookkeeping: %s', key, String(err))
    })
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
    const candidates = this.duty.resolveChain(reviewerRoleId)
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
    if (tasks.length === 0 || !tasks.every((t) => t.status === 'completed')) return
    const byStatus: Record<string, number> = {}
    for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    this.events.append('run/completed', {
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

  /** Requeue a failed/blocked task for another attempt (dashboard action). */
  retryTask(runId: string, taskId: string): void {
    const task = this.view().tasks.get(`${runId}/${taskId}`)
    if (task === undefined) throw new Error(`unknown task ${runId}/${taskId}`)
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new Error(`task ${taskId} is ${task.status}; only failed or blocked tasks can be retried`)
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
