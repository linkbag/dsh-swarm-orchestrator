import type { DutyTable, Run, Task } from './domain/types.js'
import type { SwarmState } from './domain/projection.js'
import type { RuntimeOverrides } from './domain/runtime-store.js'

/** Owned, plain-JSON board projection served over HTTP/SSE. Never holds live harness objects. */
export interface BoardSnapshot {
  service: string
  version: string
  seq: number
  runs: Run[]
  tasks: Task[]
  roles: DutyTable['roles']
  override?: DutyTable['override']
  at: number
  /** Workspace scope of this snapshot (present when the request asked for one). */
  scope?: { cwd?: string; unresolvable?: boolean }
  /** Effective runtime parameters (YAML merged with dashboard overrides). */
  runtime?: RuntimeOverrides & Record<string, number>
  /** P6: rolling success-rate telemetry. */
  telemetry?: { completed: number; failed: number; successRate: number }
  /**
   * A8: runs the operator removed from the board (`boardState: 'removed'`),
   * newest first — the recycle bin, and the only place the restore UI reads from.
   * Present only when there are any. Permanently hidden runs (`purged`) appear
   * here in neither list.
   */
  removedRuns?: RemovedRun[]
}

/** A8: a run in the recoverable removed list, carried so the board can offer Restore. */
export interface RemovedRun {
  id: string
  title: string
  status: Run['status']
  createdAt: number
}

const MAX_RUNS = 50

export function buildBoardSnapshot(
  state: SwarmState,
  duty: DutyTable,
  seq: number,
  version: string,
  scope?: { cwd?: string; unresolvable?: boolean },
  runtime?: RuntimeOverrides & Record<string, number>,
  removedRuns?: readonly RemovedRun[],
): BoardSnapshot {
  const runs = [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RUNS)
  const runIds = new Set(runs.map((run) => run.id))
  const tasks = [...state.tasks.values()].filter((task) => runIds.has(task.runId))
  const terminal = runs.filter((r) => r.status === 'completed' || r.status === 'failed')
  const completed = terminal.filter((r) => r.status === 'completed').length
  const telemetry = terminal.length > 0
    ? { completed, failed: terminal.length - completed, successRate: Math.round(completed / terminal.length * 100) }
    : undefined
  return {
    service: 'dsh-swarm-orchestrator',
    version,
    seq,
    runs,
    tasks,
    roles: duty.roles,
    ...(duty.override !== undefined ? { override: duty.override } : {}),
    ...(scope !== undefined && (scope.cwd !== undefined || scope.unresolvable === true) ? { scope } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(removedRuns !== undefined && removedRuns.length > 0 ? { removedRuns: [...removedRuns] } : {}),
    at: Date.now(),
  }
}
