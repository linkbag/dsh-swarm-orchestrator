import { useCallback, useEffect, useMemo, useState } from 'react'
import { boardStore, type Board, type BoardTask } from './board-store'
import { DutyTableEditor } from './DutyTableEditor'
import { FlowChart } from './FlowChart'

const STATUS_COLUMNS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'queued', label: 'Queued', statuses: ['pending', 'retrying'] },
  { key: 'running', label: 'Running', statuses: ['dispatching', 'running', 'reviewing'] },
  { key: 'done', label: 'Done', statuses: ['completed'] },
  { key: 'attention', label: 'Failed / Blocked', statuses: ['failed', 'blocked'] },
]

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'var(--dsh-swarm-ok, rgb(46, 160, 67))'
    case 'running': case 'dispatching': return 'var(--dsh-swarm-info, rgb(56, 139, 253))'
    case 'reviewing': return 'rgb(210, 153, 34)'
    case 'paused': return 'rgb(227, 148, 36)'
    case 'retrying': case 'pending': return 'var(--dsh-swarm-dim, rgba(125, 125, 125, 0.9))'
    default: return 'var(--dsh-swarm-warn, rgb(219, 88, 96))'
  }
}

function timeAgo(at: number): string {
  // Clock skew (manual time changes, TZ shifts) can make timestamps land in
  // the "future" — clamp so nothing reads as a negative age.
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

export function SwarmTab(): JSX.Element {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<BoardTask | null>(null)
  const [view, setView] = useState<'board' | 'flow' | 'roster'>('board')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const store = boardStore()
    store.start()
    const unsubscribe = store.subscribe((next, err) => {
      setBoard(next)
      setError(err)
    })
    return () => {
      unsubscribe()
      store.stop()
    }
  }, [])

  const runs = board?.runs ?? []
  const run = useMemo(() => {
    if (selectedRunId !== null) {
      const found = runs.find((r) => r.id === selectedRunId)
      if (found !== undefined) return found
    }
    const active = runs.find((r) => r.status === 'running' || r.status === 'planning')
    return active ?? runs[0] ?? null
  }, [runs, selectedRunId])

  const tasks = useMemo(
    () => (board !== null && run !== null ? board.tasks.filter((t) => t.runId === run.id) : []),
    [board, run],
  )

  const runAction = useCallback(async (body: { action: string; runId?: string; taskId?: string; verdict?: string }) => {
    setBusy(true)
    setActionError(null)
    try {
      await boardStore().action(body)
    } catch (err) {
      setActionError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="dsh-swarm-tab">
      <header className="dsh-swarm-header">
        <h2>Swarm</h2>
        <div className="dsh-swarm-segments" role="tablist">
          <button className={view === 'board' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('board') }}>Board</button>
          <button className={view === 'flow' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('flow') }}>Flow</button>
          <button className={view === 'roster' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('roster') }}>Roster</button>
        </div>
        <span className={error !== null ? 'dsh-swarm-pill warn' : 'dsh-swarm-pill'}>
          {error !== null ? 'host offline' : board !== null ? `v${board.version} · seq ${board.seq} · ${runs.length} run${runs.length === 1 ? '' : 's'}` : 'connecting…'}
        </span>
      </header>

      {view === 'roster' ? (
        <DutyTableEditor board={board} onSaved={() => {}} />
      ) : view === 'flow' ? (
        run !== null ? (
          <FlowChart run={run} tasks={tasks} />
        ) : (
          <div className="dsh-swarm-placeholder"><p>No run selected — dispatch a run or pick one on the Board first.</p></div>
        )
      ) : board === null && error === null ? (
        <div className="dsh-swarm-placeholder"><p>Connecting to the swarm host…</p></div>
      ) : runs.length === 0 ? (
        <div className="dsh-swarm-placeholder">
          <p>No swarm runs yet.</p>
          <p className="dsh-swarm-dim">
            Ask the agent to decompose work and call <code>swarm_dispatch</code>; runs appear here live.
          </p>
        </div>
      ) : (
        <div className="dsh-swarm-body">
          <aside className="dsh-swarm-runs">
            {runs.map((r) => (
              <button
                key={r.id}
                className={run !== null && r.id === run.id ? 'dsh-swarm-run active' : 'dsh-swarm-run'}
                onClick={() => { setSelectedRunId(r.id); setSelectedTask(null) }}
              >
                <span className="dsh-swarm-run-dot" style={{ background: statusColor(r.status) }} />
                <span className="dsh-swarm-run-title">{r.title}</span>
                <span className="dsh-swarm-run-meta">{r.status} · {timeAgo(r.createdAt)}</span>
              </button>
            ))}
          </aside>

          {run !== null && (
            <main className="dsh-swarm-main">
              <div className="dsh-swarm-run-header">
                <div>
                  <h3>{run.title}</h3>
                  <p className="dsh-swarm-dim">{run.spec.length > 220 ? run.spec.slice(0, 220) + '…' : run.spec}</p>
                  <p className="dsh-swarm-dim">created {timeAgo(run.createdAt)}{run.completedAt !== undefined && run.createdAt !== undefined ? ` · finished ${timeAgo(run.completedAt)}` : ` · elapsed ${timeAgo(run.createdAt)}`}</p>
                </div>
                <div className="dsh-swarm-run-actions">
                  {(run.status === 'planning') && (
                    <button className="dsh-swarm-btn primary" disabled={busy} onClick={() => { void runAction({ action: 'endorse', runId: run.id }) }}>
                      ✓ Endorse &amp; Launch
                    </button>
                  )}
                  {(run.status === 'paused' || run.status === 'failed') && (
                    <button className="dsh-swarm-btn primary" disabled={busy} title="Requeue failed tasks and keep completed ones" onClick={() => { void runAction({ action: 'resume', runId: run.id }) }}>
                      ↻ Resume
                    </button>
                  )}
                  {(run.status === 'running' || run.status === 'planning' || run.status === 'paused') && (
                    <button className="dsh-swarm-btn danger" disabled={busy} onClick={() => { void runAction({ action: 'abort', runId: run.id }) }}>
                      Abort
                    </button>
                  )}
                </div>
              </div>
              {run.status === 'paused' && run.pauseReason !== undefined && (
                <p className="dsh-swarm-run-banner">⏸ {run.pauseReason}</p>
              )}
              {run.status === 'failed' && (
                <p className="dsh-swarm-run-banner">✖ Run failed — see the Failed/Blocked column. Fix the cause, then Resume to requeue failed tasks (completed tasks are kept).</p>
              )}
              {actionError !== null && <p className="dsh-swarm-action-error">{actionError}</p>}

              {run.report !== undefined && (
                <details className="dsh-swarm-report" open>
                  <summary>
                    Run report — {run.report.taskCount} tasks in {Math.round(run.report.durationMs / 1000)}s
                    {' · '}{run.report.stats.fallbacks} fallback{run.report.stats.fallbacks === 1 ? '' : 's'}
                    {' · '}{run.report.stats.retries} retr{run.report.stats.retries === 1 ? 'y' : 'ies'}
                    {' · '}{run.report.stats.reviewsPassed}/{run.report.stats.reviewsPassed + run.report.stats.reviewsRejected} reviews passed
                  </summary>
                  <ul>
                    {run.report.tasks.map((t) => (
                      <li key={t.id}>
                        <code>{t.id}</code> <kbd>{t.role}</kbd>
                        {t.model !== undefined && <em> {t.model}</em>}
                        {t.reviewExhausted === true && <strong title="review loop exhausted"> ⚠</strong>}
                        {t.summary !== undefined && <span> — {t.summary.length > 200 ? t.summary.slice(0, 200) + '…' : t.summary}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="dsh-swarm-columns">
                {STATUS_COLUMNS.map((column) => {
                  const columnTasks = tasks.filter((t) => column.statuses.includes(t.status))
                  return (
                    <section key={column.key} className="dsh-swarm-column">
                      <h4>{column.label} <span className="dsh-swarm-count">{columnTasks.length}</span></h4>
                      {columnTasks.map((task) => (
                        <button
                          key={task.id}
                          className="dsh-swarm-task"
                          onClick={() => { setSelectedTask(selectedTask !== null && selectedTask.id === task.id ? null : task) }}
                        >
                          <span className="dsh-swarm-task-status" style={{ background: statusColor(task.status) }} />
                          <span className="dsh-swarm-task-subject">{task.subject}</span>
                          <span className="dsh-swarm-task-meta">
                            <kbd>{task.role}</kbd>
                            {task.agent?.model !== undefined && <code>{task.agent.provider ?? ''}/{task.agent.model}</code>}
                            {task.attempts > 1 && <em>×{task.attempts}</em>}
                            {task.reviewBy !== undefined && (task.reviewed === true
                              ? <em title={`reviewed by ${task.reviewBy}`}>✓✓</em>
                              : task.humanReview === true
                                ? <em title="awaiting human review">👤</em>
                                : <em title={`review loop: ${task.reviewBy}`}>↻{task.reviews ?? 0}</em>)}
                            {task.nudgedAt !== undefined && (
                              <em title={`no progress note recently — the watchdog is watching this task`} style={{ color: 'rgb(227, 148, 36)' }}>🔕</em>
                            )}
                          </span>
                          {task.lastNote !== undefined && (() => {
                            const stale = task.lastNoteAt !== undefined && (Date.now() - task.lastNoteAt) > 10 * 60 * 1000
                            return (
                              <span
                                className={stale ? 'dsh-swarm-task-note stale' : 'dsh-swarm-task-note'}
                                title={stale && task.lastNoteAt !== undefined ? `note from ${timeAgo(task.lastNoteAt)}` : undefined}
                              >
                                {task.lastNote.length > 90 ? task.lastNote.slice(0, 90) + '…' : task.lastNote}
                              </span>
                            )
                          })()}
                        </button>
                      ))}
                      {columnTasks.length === 0 && <p className="dsh-swarm-empty">—</p>}
                    </section>
                  )
                })}
              </div>
            </main>
          )}

          {selectedTask !== null && (
            <aside className="dsh-swarm-drawer">
              <header>
                <h3>{selectedTask.subject}</h3>
                <button className="dsh-swarm-btn ghost" onClick={() => { setSelectedTask(null) }}>✕</button>
              </header>
              <dl>
                <dt>Task</dt><dd><code>{selectedTask.id}</code></dd>
                <dt>Status</dt><dd style={{ color: statusColor(selectedTask.status) }}>{selectedTask.status}{selectedTask.blockedReason !== undefined ? ` — ${selectedTask.blockedReason}` : ''}</dd>
                <dt>Role</dt><dd><kbd>{selectedTask.role}</kbd></dd>
                <dt>Model</dt>
                <dd>{selectedTask.agent?.model !== undefined ? `${selectedTask.agent.provider ?? ''} / ${selectedTask.agent.model}` : 'deployment default'}</dd>
                {selectedTask.blockedBy !== undefined && selectedTask.blockedBy.length > 0 && (
                  <>
                    <dt>Depends on</dt><dd>{selectedTask.blockedBy.map((b) => <code key={b}>{b}</code>)}</dd>
                  </>
                )}
                {selectedTask.reviewBy !== undefined && (
                  <>
                    <dt>Reviewed by</dt><dd><kbd>{selectedTask.reviewBy}</kbd>{selectedTask.reviewed === true ? ' ✓' : ''}{(selectedTask.reviews ?? 0) > 0 ? ` (${selectedTask.reviews} round${selectedTask.reviews === 1 ? '' : 's'})` : ''}{selectedTask.reviewExhausted === true ? ' — loop exhausted, output stands' : ''}</dd>
                  </>
                )}
                {selectedTask.writes !== undefined && selectedTask.writes.length > 0 && (
                  <>
                    <dt>Write scope</dt><dd>{selectedTask.writes.map((f) => <code key={f}>{f}</code>).join(' ')}</dd>
                  </>
                )}
                <dt>Attempts</dt><dd>{selectedTask.attempts}</dd>
                <dt>Updated</dt><dd>{timeAgo(selectedTask.updatedAt)}</dd>
              </dl>
              <h4>Brief</h4>
              <p className="dsh-swarm-brief">{selectedTask.description}</p>
              {selectedTask.summary !== undefined && selectedTask.summary.length > 0 && (
                <>
                  <h4>Final summary</h4>
                  <p className="dsh-swarm-brief">{selectedTask.summary}</p>
                </>
              )}
              {selectedTask.reviewFeedback !== undefined && selectedTask.reviewFeedback.length > 0 && (
                <>
                  <h4>Reviewer feedback</h4>
                  <p className="dsh-swarm-brief">{selectedTask.reviewFeedback}</p>
                </>
              )}
              {selectedTask.lastNote !== undefined && selectedTask.lastNote !== selectedTask.summary && (
                <>
                  <h4>Latest note</h4>
                  <p className="dsh-swarm-brief">{selectedTask.lastNote}</p>
                </>
              )}
              {(selectedTask.humanReview === true && selectedTask.status === 'reviewing') && (
                <>
                  <h4>Human review pending</h4>
                  <div className="dsh-swarm-tvc-actions">
                    <button
                      className="dsh-swarm-btn primary"
                      disabled={busy}
                      onClick={() => { void runAction({ action: 'review', runId: selectedTask.runId, taskId: selectedTask.id, verdict: 'approve' }).then(() => setSelectedTask(null)) }}
                    >
                      ✓ Approve
                    </button>
                    <button
                      className="dsh-swarm-btn danger"
                      disabled={busy}
                      onClick={() => { void runAction({ action: 'review', runId: selectedTask.runId, taskId: selectedTask.id, verdict: 'reject' }) }}
                    >
                      ✖ Reject (send back with feedback)
                    </button>
                  </div>
                </>
              )}
              {(selectedTask.status === 'failed' || selectedTask.status === 'blocked') && (
                <button
                  className="dsh-swarm-btn primary"
                  disabled={busy}
                  onClick={() => { void runAction({ action: 'retry-task', runId: selectedTask.runId, taskId: selectedTask.id }) }}
                >
                  ↻ Retry task
                </button>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
