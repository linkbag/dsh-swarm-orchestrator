import type { Run, SwarmEventRecord, Task } from './types.js'
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
      stats: { fallbacks: 0, retries: 0, reviewsPassed: 0, reviewsRejected: 0 },
    }
    const dispatch = d.dispatch as Record<string, unknown> | undefined
    if (dispatch !== null && typeof dispatch === 'object') {
      const captured: Run['dispatch'] = {}
      if (typeof dispatch.presetId === 'string') captured.presetId = dispatch.presetId
      if (typeof dispatch.provider === 'string') captured.provider = dispatch.provider
      if (typeof dispatch.model === 'string') captured.model = dispatch.model
      if (typeof dispatch.cwd === 'string') captured.cwd = dispatch.cwd
      run.dispatch = captured
    }
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
    run.updatedAt = event.at

    if (kind === 'run/endorsed') {
      run.status = 'running'
      run.endorsedAt = event.at
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
    } else if (kind === 'run/aborted') {
      run.status = 'aborted'
    }
  }

  if (taskId !== undefined && runId !== undefined) {
    const task = state.tasks.get(taskKey(runId, taskId))
    if (task === undefined) return
    task.updatedAt = event.at

    switch (kind) {
      case 'task/started':
        task.status = 'running'
        task.attempts += 1
        task.agent = {
          label: str('label') ?? task.agent?.label ?? `swarm:${taskId}`,
          provider: str('provider') ?? task.agent?.provider,
          model: str('model') ?? task.agent?.model,
        }
        task.blockedReason = undefined
        break
      case 'task/agent-started':
        if (task.status === 'dispatching') task.status = 'running'
        if (typeof d.sessionId === 'string') task.agent = { ...(task.agent ?? { label: `swarm:${taskId}` }), label: task.agent?.label ?? `swarm:${taskId}` }
        break
      case 'task/heartbeat':
        if (typeof d.note === 'string') task.lastNote = d.note
        break
      case 'task/model-fallback': {
        task.agent = {
          label: task.agent?.label ?? `swarm:${taskId}`,
          provider: str('provider'),
          model: str('model'),
        }
        const runStats = state.runs.get(runId)?.stats
        if (runStats !== undefined) runStats.fallbacks += 1
        break
      }
      case 'task/completed':
        task.status = 'completed'
        if (typeof d.summary === 'string') {
          task.summary = d.summary
          task.lastNote = d.summary
        }
        break
      case 'task/failed': {
        const retrying = d.retry === true
        task.status = retrying ? 'retrying' : 'failed'
        task.lastNote = str('reason') ?? task.lastNote
        if (retrying) {
          const runStats = state.runs.get(runId)?.stats
          if (runStats !== undefined) runStats.retries += 1
        }
        break
      }
      case 'task/blocked':
        task.status = 'blocked'
        task.blockedReason = str('reason')
        break
      case 'task/review-started':
        if (task.status === 'completed') task.status = 'reviewing'
        break
      case 'task/reviewed': {
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
          // reviewer unavailable — fail-open: the builder's output stands
          task.status = 'completed'
          task.reviewFeedback = `review unavailable: ${feedback ?? 'unknown reason'}`
        }
        break
      }
      default:
        break
    }
  }
}
