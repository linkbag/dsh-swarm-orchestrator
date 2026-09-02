import type { DutyTable, Run, Task } from './domain/types.js'
import type { SwarmState } from './domain/projection.js'

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
}

const MAX_RUNS = 50

export function buildBoardSnapshot(state: SwarmState, duty: DutyTable, seq: number, version: string): BoardSnapshot {
  const runs = [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RUNS)
  const runIds = new Set(runs.map((run) => run.id))
  const tasks = [...state.tasks.values()].filter((task) => runIds.has(task.runId))
  return {
    service: 'dsh-swarm-orchestrator',
    version,
    seq,
    runs,
    tasks,
    roles: duty.roles,
    ...(duty.override !== undefined ? { override: duty.override } : {}),
    at: Date.now(),
  }
}
