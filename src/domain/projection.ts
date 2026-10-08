import type { Run, SwarmEventRecord, Task } from './types.js'
import { validAuthority } from '../authority.js'
/** Folded, owned board state — plain JSON only, no live harness objects. */
export interface SwarmState {
  runs: Map<string, Run>
  tasks: Map<string, Task>
}

export function newState(): SwarmState {
  return { runs: new Map(), tasks: new Map() }
}

/** Task ids keyed per run for fast lookups. */
function taskKey(runId: string, taskId: string): string {
  return `${runId}/${taskId}`
}

export function taskKeyOf(task: Task): string {
  return taskKey(task.runId, task.id)
}

/** Whether every blocker of `task` is completed (tasks without blockers are always ready). */
export function isReady(state: SwarmState, task: Task): boolean {
  if (task.status !== 'pending' && task.status !== 'retrying') return false
  const run = state.runs.get(task.runId)
  if (run === undefined) return false
  for (const blocker of task.blockedBy ?? []) {
    const blockerTask = state.tasks.get(taskKey(task.runId, blocker))
    if (blockerTask === undefined || blockerTask.status !== 'completed') return false
  }
  return true
}

/** Count tasks currently dispatched/running/reviewing for concurrency accounting. */
export function runningCount(state: SwarmState, runId: string): number {
  let count = 0
  for (const task of state.tasks.values()) {
    if (task.runId === runId && (task.status === 'running' || task.status === 'dispatching' || task.status === 'reviewing')) count++
  }
  return count
}

/** Fold the whole event log into the current state. Unknown kinds are ignored (forward-compatible). */
export function fold(events: readonly SwarmEventRecord[], state = newState()): SwarmState {
  for (const event of events) apply(state, event)
  return state
}

/**
 * J19: whether an event carries a superseded attempt's id.
 *
 * `task.attemptId` names the attempt currently allowed to write to a task. An event
 * naming a *different* attempt is a late write from work already replaced — applying
 * it would let a zombie overwrite live results. Events with no attemptId are legacy
 * or operator-driven and stay permitted, so an upgraded log still folds and a manual
 * retry is never blocked by its own bookkeeping.
 */
function staleAttempt(task: Task, d: Record<string, unknown>): boolean {
  if (d.source === 'operator') return false
  const claimed = d.attemptId
  if (task.attemptProtocol === 2) return task.attemptRevoked === true || typeof claimed !== 'string' || claimed !== task.attemptId
  if (typeof claimed !== 'string' || claimed.length === 0) return false
  return task.attemptId !== undefined && task.attemptId !== claimed
}

function apply(state: SwarmState, event: SwarmEventRecord): void {
  const { kind, runId, taskId, data } = event
  const d = (data ?? {}) as Record<string, unknown>
  const str = (key: string): string | undefined => (typeof d[key] === 'string' ? (d[key] as string) : undefined)

  if (kind === 'run/created' && runId !== undefined) {
    const run: Run = {
      id: runId,
      title: str('title') ?? '(untitled)',
      spec: str('spec') ?? '',
      status: 'planning',
      createdAt: event.at,
      updatedAt: event.at,
      taskIds: [],
      stats: { fallbacks: 0, retries: 0, reviewsPassed: 0, reviewsRejected: 0, reviewsUnavailable: 0 },
    }
    const dispatch = d.dispatch as Record<string, unknown> | undefined
    if (dispatch !== null && typeof dispatch === 'object') {
      const captured: Run['dispatch'] = {}
      if (typeof dispatch.sessionId === 'string') captured.sessionId = dispatch.sessionId
      if (typeof dispatch.presetId === 'string') captured.presetId = dispatch.presetId
      if (typeof dispatch.provider === 'string') captured.provider = dispatch.provider
      if (typeof dispatch.model === 'string') captured.model = dispatch.model
      if (typeof dispatch.cwd === 'string') captured.cwd = dispatch.cwd
      if (validAuthority(dispatch.authority)) captured.authority = dispatch.authority
      run.dispatch = captured
    }
    if (typeof d.planPath === 'string') run.planPath = d.planPath
    state.runs.set(runId, run)
    const specs = Array.isArray(d.tasks) ? (d.tasks as Record<string, unknown>[]) : []
    for (const spec of specs) {
      const id = typeof spec.id === 'string' ? spec.id : ''
      if (id.length === 0) continue
      const key = taskKey(runId, id)
      const task: Task = {
        runId,
        id,
        subject: typeof spec.subject === 'string' ? spec.subject : id,
        description: typeof spec.description === 'string' ? spec.description : '',
        role: typeof spec.role === 'string' ? spec.role : 'builder',
        blockedBy: Array.isArray(spec.blockedBy) ? (spec.blockedBy as string[]) : undefined,
        reviewBy: typeof spec.reviewBy === 'string' ? spec.reviewBy : undefined,
        reviewGate: spec.reviewGate === 'human' ? 'human' : undefined,
        writes: Array.isArray(spec.writes) ? (spec.writes as string[]).filter((w) => typeof w === 'string') : undefined,
        model: spec.model !== null && typeof spec.model === 'object'
          && typeof (spec.model as Record<string, unknown>).provider === 'string'
          && typeof (spec.model as Record<string, unknown>).model === 'string'
          ? { provider: (spec.model as { provider: string }).provider, model: (spec.model as { model: string }).model }
          : undefined,
        evidence: spec.evidence !== null && typeof spec.evidence === 'object' ? (spec.evidence as Task['evidence']) : undefined,
        status: 'pending',
        attempts: 0,
        reviews: 0,
        updatedAt: event.at,
      }
      state.tasks.set(key, task)
      run.taskIds.push(id)
    }
    return
  }

  if (runId !== undefined) {
    const run = state.runs.get(runId)
    if (run === undefined) return
    // Task events touch the run only AFTER task ownership/phase fences below.
    if (kind.startsWith('run/')) run.updatedAt = event.at

    if (kind === 'run/endorsed') {
      // J5 legality: an endorsement may only bring a not-yet-running run to
      // life — a crafted replay must not resurrect an aborted/terminal run.
      if (run.status === 'planning' || run.status === 'awaiting-endorsement') {
        run.status = 'running'
        run.endorsedAt = event.at
      }
    } else if (kind === 'run/started') {
      if (run.status !== 'completed' && run.status !== 'aborted') run.status = 'running'
    } else if (kind === 'run/completed') {
      run.status = 'completed'
      run.completedAt = event.at
      if (d.report !== null && typeof d.report === 'object') run.report = d.report as Run['report']
    } else if (kind === 'run/failed') {
      run.status = 'failed'
      run.completedAt = event.at
      if (d.report !== null && typeof d.report === 'object') run.report = d.report as Run['report']
    } else if (kind === 'run/paused') {
      run.status = 'paused'
      run.pauseReason = str('reason')
    } else if (kind === 'run/resumed') {
      if (validAuthority(d.authority)) run.dispatch = { ...run.dispatch, authority: d.authority }
      run.status = 'running'
      run.completedAt = undefined
      run.pauseReason = undefined
    } else if (kind === 'run/aborted') {
      run.status = 'aborted'
    } else if (kind === 'run/renamed') {
      // A8: display-only, and deliberately unrestricted by status — the run you
      // are finished with is exactly the one you want to relabel. An unknown
      // runId was already tolerated by the guard above.
      const title = str('title')
      if (title !== undefined && title.length > 0) run.title = title
    } else if (kind === 'run/board-state') {
      // A8: a VIEW property only. Status, tasks, stats and the report are
      // untouched, so hiding a run can never affect scheduling, recovery or
      // history. An unknown runId was already tolerated by the guard above, and
      // an unrecognised state is ignored rather than corrupting the flag.
      const state = str('state')
      if (state === 'visible' || state === 'removed' || state === 'purged') run.boardState = state
    }
  }

  if (taskId !== undefined && runId !== undefined) {
    const task = state.tasks.get(taskKey(runId, taskId))
    if (task === undefined) return
    // Terminal owners remain frozen; revival must first append run/resumed.
    const ownerRun = state.runs.get(runId)
    if (ownerRun !== undefined && (ownerRun.status === 'aborted' || ownerRun.status === 'completed' || ownerRun.status === 'failed')) return
    // Pause stops autonomous writes, not explicit operator decisions. These do
    // not resume the run or launch any sibling until the owner resumes it.
    if (ownerRun?.status === 'paused' && d.source !== 'operator') return
    if (kind !== 'task/started' && staleAttempt(task, d)) return
    if (task.attemptProtocol === 2 && d.source !== 'operator') {
      if (kind === 'task/started' && task.attemptRevoked !== true && (task.status === 'running' || task.status === 'reviewing' || task.status === 'dispatching')) return
      if (kind === 'task/completed' && task.status !== 'running' && task.status !== 'dispatching') return
      if (kind === 'task/reviewed' && task.status !== 'reviewing') return
    }
    task.updatedAt = event.at
    if (ownerRun !== undefined) ownerRun.updatedAt = event.at

    switch (kind) {
      case 'task/started':
        if (task.attemptProtocol === 2 && task.attemptRevoked !== true && (task.status === 'running' || task.status === 'reviewing' || task.status === 'dispatching')) break
        if (d.attemptProtocol === 2) task.attemptProtocol = 2
        delete task.attemptRevoked
        delete task.humanReview
        delete task.reviewed
        delete task.reviewUnavailable
        delete task.reviewExhausted
        delete task.summary
        delete task.reviewerAgent
        delete task.fileWarnings
        delete task.evidenceOutcomes
        delete task.recovered
        task.status = 'running'
        task.attempts += 1
        // J19: a new attempt becomes the one and only writer for this task.
        if (typeof d.attemptId === 'string') task.attemptId = d.attemptId
        else delete task.attemptId
        // J22: the reference point for "was this report written by the live attempt?".
        task.attemptStartedAt = event.at
        // A fresh attempt is silent by definition: the previous attempt's note and
        // its timestamp must not feed this attempt's watchdog silence clock (that
        // carryover reclaimed a healthy 7-minute-old retry as "61 min silent").
        delete task.lastNote
        delete task.lastNoteAt
        task.agent = {
          label: str('label') ?? task.agent?.label ?? `swarm:${taskId}`,
          provider: str('provider') ?? task.agent?.provider,
          model: str('model') ?? task.agent?.model,
          // A1: the effort this attempt pinned, so a fast child death is
          // diagnosable from the board. Absent on an attempt that pinned nothing,
          // which also clears any previous attempt's value (JSON drops undefined).
          effort: str('effort'),
          requestedEffort: str('requestedEffort'),
        }
        task.blockedReason = undefined
        break
      case 'task/agent-started': {
        if (task.status === 'dispatching') task.status = 'running'
        const field = d.phase === 'review' ? 'reviewerAgent' : 'agent'
        task[field] = {
          ...task[field],
          label: task[field]?.label ?? `swarm:${taskId}${d.phase === 'review' ? ':review' : ''}`,
          provider: str('provider') ?? task[field]?.provider,
          model: str('model') ?? task[field]?.model,
          ...('effort' in d ? { effort: str('effort') } : {}),
        }
        break
      }
      case 'task/heartbeat':
        // J19: a superseded attempt must not even annotate the live task — its note
        // would misrepresent work the current attempt has not done.
        if (staleAttempt(task, d)) break
        if (typeof d.note === 'string') task.lastNote = d.note
        task.lastNoteAt = event.at
        break
      case 'task/model-fallback': {
        const field = d.phase === 'review' ? 'reviewerAgent' : 'agent'
        task[field] = {
          ...task[field],
          label: task[field]?.label ?? `swarm:${taskId}:${d.phase === 'review' ? 'review' : 'build'}`,
          provider: str('provider') ?? task[field]?.provider,
          model: str('model') ?? task[field]?.model,
        }
        const runStats = state.runs.get(runId)?.stats
        if (runStats !== undefined) runStats.fallbacks += 1
        break
      }
      case 'task/review-agent':
        task.reviewerAgent = { label: `swarm:${taskId}:review`, provider: str('provider'), model: str('model'), effort: str('effort'), requestedEffort: str('requestedEffort') }
        break
      case 'task/effort-changed': {
        const field = d.phase === 'review' ? 'reviewerAgent' : 'agent'
        task[field] = { ...task[field], label: task[field]?.label ?? `swarm:${taskId}`, effort: str('effort') }
        break
      }
      case 'task/recovery-started':
        if (task.status === 'reviewing') task.status = 'running'
        break
      case 'task/completed':
        // J19: a superseded attempt's success must not close the live task.
        if (staleAttempt(task, d)) break
        if (task.attemptProtocol === 2 && d.source !== 'operator' && task.status !== 'running' && task.status !== 'dispatching') break
        task.status = 'completed'
        delete task.humanReview
        if (d.revokeAttempt === true) task.attemptRevoked = true
        if (Array.isArray(d.fileWarnings)) task.fileWarnings = d.fileWarnings.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(d.evidence)) task.evidenceOutcomes = d.evidence.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
        if (d.recovered === true) task.recovered = true
        if (typeof d.summary === 'string') {
          task.summary = d.summary
          task.lastNote = d.summary
        }
        break
      case 'task/failed': {
        // J19: a superseded attempt's failure must not knock down the live task —
        // this is the fence that stops a zombie's late error from aborting a run
        // whose retry is already making progress.
        if (staleAttempt(task, d)) break
        const retrying = d.retry === true
        task.status = retrying ? 'retrying' : 'failed'
        if (task.attemptProtocol === 2) task.attemptRevoked = true
        delete task.humanReview
        task.lastNote = str('reason') ?? task.lastNote
        if (retrying) {
          const runStats = state.runs.get(runId)?.stats
          if (runStats !== undefined) runStats.retries += 1
        }
        break
      }
      case 'task/blocked':
        if (task.attemptProtocol === 2) task.attemptRevoked = true
        task.status = 'blocked'
        task.blockedReason = str('reason')
        // A7: reuse the review gate's `human: true` flag (J7). A task blocked because
        // only a person can decide — the work is done but its evidence command keeps
        // failing — must be visible as waiting on a human, not as a silent block.
        if (d.human === true) task.humanReview = true
        break
      case 'task/unblocked':
        if (task.status === 'blocked') {
          task.status = 'pending'
          task.blockedReason = undefined
        }
        break
      case 'task/nudged':
        task.nudgedAt = event.at
        break
      case 'task/review-started':
        if (task.status === 'completed') task.status = 'reviewing'
        if (d.human === true) task.humanReview = true
        break
      case 'task/reviewed': {
        // J19: a review verdict produced for a superseded attempt is not a verdict
        // on the current one.
        if (staleAttempt(task, d)) break
        if (task.attemptProtocol === 2 && d.source !== 'operator' && task.status !== 'reviewing') break
        delete task.humanReview
        if (task.attemptProtocol === 2) task.attemptRevoked = true
        const verdict = str('verdict') ?? 'error'
        const feedback = str('feedback')
        if (feedback !== undefined) task.reviewFeedback = feedback
        const runStats = state.runs.get(runId)?.stats
        if (verdict === 'approve') {
          task.status = 'completed'
          task.reviewed = true
          if (runStats !== undefined) runStats.reviewsPassed += 1
        } else if (verdict === 'reject') {
          task.reviewed = true
          if (d.exhausted === true) {
            task.status = 'completed'
            task.reviewExhausted = true
          } else {
            task.status = 'pending'
            if (typeof d.reviews === 'number') task.reviews = d.reviews
          }
          if (runStats !== undefined) runStats.reviewsRejected += 1
        } else {
          // Reviewer unavailable / no explicit verdict — fail-open: the builder's
          // output stands, but the skip is now COUNTED and marked on the task.
          // J17: this path completes the task while leaving `reviewed` false and
          // `reviewsPassed` unchanged, so a silently skipped review used to be
          // indistinguishable from a clean pass in the run report.
          task.status = 'completed'
          task.reviewed = false
          task.reviewUnavailable = true
          task.reviewFeedback = `review unavailable: ${feedback ?? 'unknown reason'}`
          if (runStats !== undefined) runStats.reviewsUnavailable += 1
        }
        break
      }
      default:
        break
    }
  }
}
