// Keyed toolview card for `swarm_dispatch` calls in chat: the run's title,
// task DAG at a glance, endorsement state, and the created run id — with a
// link-free pointer to the Swarm tab (the board owns live progress).
// Structural typing only: the tool block shape is mirrored locally so the
// bundle keeps its externals table unchanged.

interface TaskSpecView {
  id?: string
  subject?: string
  role?: string
  blockedBy?: string[]
  reviewBy?: string
}

interface DispatchArgs {
  title?: string
  tasks?: TaskSpecView[]
  endorse?: boolean
}

/** Mirrored subset of the runtime's RunningToolCall | ToolResultNode. */
type ToolBlock = {
  argsRaw?: string
  call?: { argsRaw?: string } | null
  content?: ReadonlyArray<{ type: string; text?: string }>
  isError?: boolean
}

function parseArgs(argsRaw: string | undefined): DispatchArgs {
  if (argsRaw === undefined || argsRaw.length === 0) return {}
  try {
    const parsed = JSON.parse(argsRaw) as DispatchArgs
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function resultText(block: ToolBlock): string | null {
  const parts: string[] = []
  for (const item of block.content ?? []) {
    parts.push(item.type === 'text' && typeof item.text === 'string' ? item.text : JSON.stringify(item))
  }
  return parts.join('\n') || null
}

function runIdFrom(text: string | null): string | null {
  if (text === null) return null
  const match = text.match(/run-[a-z0-9]+-[a-z0-9]+/i)
  return match === null ? null : match[0]
}

function stateOf(block: ToolBlock): 'running' | 'ok' | 'error' {
  if (!('kind' in block)) return 'running'
  return block.isError === true ? 'error' : 'ok'
}

export function SwarmDispatchCard({ block }: { block: ToolBlock }): JSX.Element {
  const settled = 'kind' in block
  const args = parseArgs(settled ? block.call?.argsRaw ?? undefined : block.argsRaw)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const runId = state === 'ok' ? runIdFrom(output) : null
  const tasks = Array.isArray(args.tasks) ? args.tasks : []
  const title = args.title !== undefined && args.title.length > 0 ? args.title : '(untitled run)'

  return (
    <div className="dsh-swarm-tvc">
      <div className="dsh-swarm-tvc-head">
        <span className="dsh-swarm-tvc-title">🐝 Swarm: {title}</span>
        {state === 'running' && <span className="dsh-swarm-pill">dispatching…</span>}
        {state === 'ok' && runId !== null && <span className="dsh-swarm-pill">run created</span>}
        {state === 'error' && <span className="dsh-swarm-pill warn">failed</span>}
      </div>
      {state === 'ok' && (
        <div className="dsh-swarm-tvc-meta">
          {runId !== null ? <>run <span className="dsh-swarm-tvc-runid">{runId}</span> — live progress on the Swarm tab</> : output}
        </div>
      )}
      {state === 'error' && output !== null && <div className="dsh-swarm-tvc-error">{output}</div>}
      {tasks.length > 0 && (
        <ul className="dsh-swarm-tvc-tasks">
          {tasks.map((task) => (
            <li key={typeof task.id === 'string' ? task.id : JSON.stringify(task)} className="dsh-swarm-tvc-task">
              <span className="dsh-swarm-tvc-id">{task.id ?? '?'}</span>
              <span>{task.subject ?? ''}</span>
              <span className="dsh-swarm-tvc-meta">
                {task.role ?? 'builder'}
                {task.reviewBy !== undefined ? ` · reviewed by ${task.reviewBy}` : ''}
                {task.blockedBy !== undefined && task.blockedBy.length > 0 ? ` · after ${task.blockedBy.join(', ')}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {state === 'running' && (
        <div className="dsh-swarm-tvc-meta">
          {tasks.length} task{tasks.length === 1 ? '' : 's'} · {args.endorse === true ? 'endorsed — dispatching now' : 'awaiting your endorsement on the Swarm tab'}
        </div>
      )}
    </div>
  )
}
