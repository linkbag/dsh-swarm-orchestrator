// Selection logic for the Flow view, kept pure and DOM-free so it can be
// unit-tested — the client has no DOM harness (the same reason badge.ts and
// write-scope.ts exist as separate modules).
//
// Why this is a module and not three lines inside FlowChart: clicking a flow box
// must select exactly the same thing a Board card click selects (the task object
// that drives the shared detail sidebar), and it must NEVER select for nodes that
// are not tasks — the scheduler, the report, and the wave labels are decoration.
// Those two rules are the whole feature, so they get pinned by tests.
import type { BoardTask } from './board-store'

/** Only `taskId` matters: non-task nodes simply do not carry one. */
export interface FlowNodeLike {
  taskId?: string | null
}

export interface FlowSelection {
  runId: string
  taskId: string
  task: BoardTask
}

/**
 * Resolve a flow node to the selection it should open, or `null` when the node is
 * not selectable. Every rejection path is deliberate:
 *  - no/blank/non-string `taskId` → decoration node (scheduler, report, wave pill)
 *  - no `runId` → a flow is always rendered for a run; without one we cannot
 *    guarantee the sidebar shows consistent data, so we select nothing
 *  - malformed `tasks` → treat as absent rather than throwing inside a click
 *  - task not in this run's list → nothing to show
 *  - a task whose own `runId` disagrees with the rendered run → refuse, so the
 *    sidebar can never mix one run's task with another run's context
 */
export function resolveFlowSelection(
  node: FlowNodeLike | null | undefined,
  runId: string | null | undefined,
  tasks: readonly BoardTask[] | null | undefined,
): FlowSelection | null {
  const taskId = typeof node?.taskId === 'string' ? node.taskId : ''
  if (taskId.length === 0) return null
  if (typeof runId !== 'string' || runId.length === 0) return null
  if (!Array.isArray(tasks)) return null
  const task = tasks.find((candidate) => candidate?.id === taskId)
  if (task === undefined) return null
  const owner = typeof task.runId === 'string' && task.runId.length > 0 ? task.runId : runId
  if (owner !== runId) return null
  return { runId: owner, taskId, task }
}

export interface FlowNodeAttributes {
  className: string
  role: 'button' | undefined
  tabIndex: number | undefined
  'aria-pressed': boolean | undefined
}

/**
 * The attributes a flow node carries. Non-interactive nodes get no role, no tab
 * stop and no ARIA state — an inert box must not be announced as a button.
 */
export function flowNodeAttributes(
  interactive: boolean,
  selected: boolean,
  base = 'dsh-swarm-flow-node',
): FlowNodeAttributes {
  if (!interactive) {
    return { className: base, role: undefined, tabIndex: undefined, 'aria-pressed': undefined }
  }
  return {
    className: selected ? `${base} clickable active` : `${base} clickable`,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected,
  }
}

/** Enter and Space activate a button; Space must be prevented from scrolling. */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar'
}
