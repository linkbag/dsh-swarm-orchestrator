import type { Board, BoardActionBody, BoardRun, BoardTask } from './board-store'

export interface TaskKey { runId: string; id: string }
export function sameTask(left: TaskKey | null, right: TaskKey): boolean {
  return left?.runId === right.runId && left.id === right.id
}
export function toggleTask(current: TaskKey | null, next: TaskKey): TaskKey | null {
  return sameTask(current, next) ? null : { runId: next.runId, id: next.id }
}

/** Called only after a successful, still-owned action; rejection keeps its drawer. */
export function selectionAfterSuccessfulAction(current: TaskKey | null, body: Pick<BoardActionBody, 'action' | 'runId' | 'taskId' | 'verdict'>): TaskKey | null {
  return body.action === 'review' && body.verdict === 'approve' && body.runId !== undefined && body.taskId !== undefined
    && sameTask(current, { runId: body.runId, id: body.taskId }) ? null : current
}

export function normalizeWorkspace(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows paths are case-insensitive, POSIX paths are not.
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized || '/'
}

export interface WorkspaceState { sessionId?: string; cwd: string | null; loading: boolean; error: string | null }
export function visibleRuns(board: Board | null, scope: 'workspace' | 'all', sessionId: string | undefined, workspace: WorkspaceState): BoardRun[] {
  const runs = board?.runs ?? []
  if (scope !== 'workspace' || !sessionId) return runs
  // Never briefly show the previous chat's workspace (or all workspaces) while
  // its replacement request is pending. Unresolvable scopes explicitly fall back.
  if (workspace.sessionId !== sessionId || workspace.loading) return []
  if (workspace.cwd === null) return runs
  const cwd = normalizeWorkspace(workspace.cwd)
  return runs.filter((run) => run.dispatch?.cwd !== undefined && normalizeWorkspace(run.dispatch.cwd) === cwd)
}

export function resolveBoardSelection(board: Board | null, runs: BoardRun[], selectedRunId: string | null, selectedTask: TaskKey | null): { run: BoardRun | null; task: BoardTask | null } {
  const run = runs.find((candidate) => candidate.id === selectedRunId)
    ?? runs.find((candidate) => candidate.status === 'running' || candidate.status === 'planning')
    ?? runs[0] ?? null
  const task = run !== null && selectedTask?.runId === run.id
    ? board?.tasks.find((candidate) => candidate.runId === run.id && candidate.id === selectedTask.id) ?? null
    : null
  return { run, task }
}
