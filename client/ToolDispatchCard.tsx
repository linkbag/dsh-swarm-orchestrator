// Keyed toolview card for `swarm_dispatch` calls in chat: the run's title,
// task DAG at a glance (K3 live dots via the board SSE), endorsement state,
// and the created run id. Structural typing only: the tool block shape is
// mirrored locally so the bundle keeps its externals table unchanged.
import { useEffect, useState } from 'react'
import { boardStore } from './board-store'
import { statusT, useT } from './locale'

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

interface LiveTask {
  id: string
  status: string
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

function dotColor(status: string): string {
  if (status === 'completed') return 'rgb(46, 160, 67)'
  if (status === 'running' || status === 'dispatching' || status === 'reviewing') return 'rgb(56, 139, 253)'
  if (status === 'failed' || status === 'blocked') return 'rgb(219, 88, 96)'
  return 'rgba(125, 125, 125, 0.6)'
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

function statusLabel(tasks: LiveTask[], t: Translate): { text: string; live: boolean } {
  if (tasks.length === 0) return { text: t('card.queued'), live: false }
  if (tasks.every((t) => t.status === 'completed')) return { text: t('card.allDone'), live: false }
  if (tasks.some((t) => t.status === 'failed' || t.status === 'blocked')) return { text: t('card.needsAttention'), live: true }
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'dispatching' || t.status === 'reviewing').length
  return { text: t('card.progress', { running, queued: tasks.length - running }), live: running > 0 }
}

export function SwarmDispatchCard({ block }: { block: ToolBlock }): JSX.Element {
  const t = useT()
  const settled = 'kind' in block
  const args = parseArgs(settled ? block.call?.argsRaw ?? undefined : block.argsRaw)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const runId = state === 'ok' ? runIdFrom(output) : null
  const tasks = Array.isArray(args.tasks) ? args.tasks : []
  const title = args.title !== undefined && args.title.length > 0 ? args.title : t('card.untitled')

  // K3: once the run id is known, ride the ONE shared board stream and show
  // live per-task dots. Deliberately no per-card EventSource and no per-card
  // fetch: this card renders once per historical `swarm_dispatch` call, so a
  // stream per card exhausts the browser's ~6 connections per origin and queues
  // every other request on the page forever (chat history, other plugins) while
  // the host stays perfectly healthy. The shared store owns the single stream
  // and one debounced refetch for the whole plugin.
  const [live, setLive] = useState<LiveTask[] | null>(null)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  useEffect(() => {
    if (runId === null) return
    const store = boardStore()
    const release = store.retain()
    const unsubscribe = store.subscribe((board) => {
      if (board === null) return
      const liveTasks = board.tasks
        .filter((t) => t.runId === runId)
        .map((t) => ({ id: t.id, status: t.status }))
      const run = board.runs.find((r) => r.id === runId)
      if (liveTasks.length > 0) setLive(liveTasks)
      if (run !== undefined) setRunStatus(run.status)
    })
    return () => {
      unsubscribe()
      release()
    }
  }, [runId])

  const dotTasks: LiveTask[] = live ?? tasks.map((t) => ({ id: t.id ?? '?', status: 'pending' }))
  const progress = statusLabel(dotTasks, t)

  return (
    <div className="dsh-swarm-tvc">
      <div className="dsh-swarm-tvc-head">
        <span className="dsh-swarm-tvc-title">{t('card.swarmTitle', { title })}</span>
        {state === 'running' && <span className="dsh-swarm-pill">{t('card.dispatchingPill')}</span>}
        {state === 'ok' && runId !== null && <span className="dsh-swarm-pill">{t('card.runCreated')}</span>}
        {state === 'error' && <span className="dsh-swarm-pill warn">{t('card.failedPill')}</span>}
      </div>
      {state === 'ok' && (
        <div className="dsh-swarm-tvc-meta">
          {runId !== null ? <>{t('card.live', { runId, status: runStatus !== null ? statusT(runStatus) : '' })}</> : output}
        </div>
      )}
      {state === 'error' && output !== null && <div className="dsh-swarm-tvc-error">{output}</div>}
      {dotTasks.length > 0 && (
        <ul className="dsh-swarm-tvc-tasks">
          {dotTasks.map((task) => {
            const spec = tasks.find((t) => t.id === task.id)
            const isLive = task.status === 'running' || task.status === 'dispatching' || task.status === 'reviewing'
            return (
              <li key={task.id} className="dsh-swarm-tvc-task">
                <span
                  className={isLive ? 'dsh-swarm-tvc-dot live' : 'dsh-swarm-tvc-dot'}
                  style={{ background: dotColor(task.status) }}
                  title={task.status}
                />
                <span className="dsh-swarm-tvc-id">{task.id}</span>
                <span>{spec?.subject ?? ''}</span>
                <span className="dsh-swarm-tvc-meta">
                  {spec?.role ?? 'builder'}
                  {spec?.reviewBy !== undefined ? t('card.reviewedBy', { role: spec.reviewBy }) : ''}
                  {spec?.blockedBy !== undefined && spec.blockedBy.length > 0 ? t('card.after', { list: spec.blockedBy.join(', ') }) : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <div className="dsh-swarm-tvc-meta">
        {state === 'running'
          ? (args.endorse === true ? t('card.endorsed') : t('card.awaitingEndorsement'))
          : state === 'ok' ? progress.text : ''}
      </div>
    </div>
  )
}
