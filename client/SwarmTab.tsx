import { useCallback, useEffect, useMemo, useState } from 'react'
import { boardStore, type Board, type BoardTask } from './board-store'
import { DutyTableEditor } from './DutyTableEditor'
import { FlowChart } from './FlowChart'
import { RuntimeSettings } from './RuntimeSettings'
import { statusT, useT, t as translate } from './locale'

type T = (key: string, vars?: Record<string, string | number>) => string

const STATUS_COLUMNS: Array<{ key: string; labelKey: string; statuses: string[] }> = [
  { key: 'queued', labelKey: 'col.queued', statuses: ['pending', 'retrying'] },
  { key: 'running', labelKey: 'col.running', statuses: ['dispatching', 'running', 'reviewing'] },
  { key: 'done', labelKey: 'col.done', statuses: ['completed'] },
  { key: 'attention', labelKey: 'col.attention', statuses: ['failed', 'blocked'] },
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

function timeAgo(at: number, t: T): string {
  // Clock skew (manual time changes, TZ shifts) can make timestamps land in
  // the "future" — clamp so nothing reads as a negative age.
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return t('time.seconds', { n: seconds })
  if (seconds < 3600) return t('time.minutes', { n: Math.round(seconds / 60) })
  if (seconds < 86400) return t('time.hours', { n: Math.round(seconds / 3600) })
  return t('time.days', { n: Math.round(seconds / 86400) })
}

export function SwarmTab({ sessionId }: { sessionId?: string }): JSX.Element {
  const t = useT()
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<BoardTask | null>(null)
  const [view, setView] = useState<'board' | 'flow' | 'roster'>('board')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Workspace scoping (v0.4.0): default to this chat's workspace; "All" is one click away.
  const [scope, setScope] = useState<'workspace' | 'all'>(() =>
    localStorage.getItem('dsh-swarm-workspace-scope') === 'all' ? 'all' : 'workspace')
  const [chatCwd, setChatCwd] = useState<string | null>(null)
  const [cwdUnresolvable, setCwdUnresolvable] = useState(false)

  const switchScope = useCallback((next: 'workspace' | 'all') => {
    setScope(next)
    localStorage.setItem('dsh-swarm-workspace-scope', next)
  }, [])

  useEffect(() => {
    if (sessionId === undefined || sessionId.length === 0) { setCwdUnresolvable(true); return }
    let cancelled = false
    void fetch(`/swarm/workspace?session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json() as Promise<{ cwd?: string; unresolvable?: boolean }>)
      .then((info) => {
        if (cancelled) return
        if (typeof info.cwd === 'string' && info.cwd.length > 0) setChatCwd(info.cwd)
        else setCwdUnresolvable(true)
      })
      .catch(() => { if (!cancelled) setCwdUnresolvable(true) })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    const store = boardStore()
    const release = store.retain()
    const unsubscribe = store.subscribe((next, err) => {
      setBoard(next)
      setError(err)
    })
    return () => {
      unsubscribe()
      release()
    }
  }, [])

  const normalizeWorkspace = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const workspaceOf = (r: { dispatch?: { cwd?: string } }): string | null => r.dispatch?.cwd ?? null

  const runs = useMemo(() => {
    const all = board?.runs ?? []
    if (scope !== 'workspace' || chatCwd === null) return all
    const norm = normalizeWorkspace(chatCwd)
    return all.filter((r) => {
      const cwd = r.dispatch?.cwd
      return cwd !== undefined && normalizeWorkspace(cwd) === norm
    })
  }, [board, scope, chatCwd])

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
          <button className={view === 'board' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('board') }}>{t('tab.board')}</button>
          <button className={view === 'flow' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('flow') }}>{t('tab.flow')}</button>
          <button className={view === 'roster' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('roster') }}>{t('tab.roster')}</button>
        </div>
  // Workspace scope switch: visible whenever the tab knows which chat it is in.
  {sessionId !== undefined && (
    <div className="dsh-swarm-segments" role="tablist" title={t('scope.title')}>
      <button
        className={scope === 'workspace' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'}
        disabled={cwdUnresolvable}
        title={cwdUnresolvable ? t('scope.unresolvableTitle') : t('scope.showWorkspace')}
        onClick={() => { switchScope('workspace') }}
      >{t('scope.workspace')}</button>
      <button
        className={scope === 'all' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'}
        onClick={() => { switchScope('all') }}
      >{t('scope.all')}</button>
    </div>
  )}
        <span className={error !== null ? 'dsh-swarm-pill warn' : 'dsh-swarm-pill'}>
          {error !== null ? t('pill.offline') : board !== null ? t('pill.info', { version: board.version, seq: board.seq, count: runs.length, plural: runs.length === 1 ? '' : 's' }) : t('pill.connecting')}
        </span>
      </header>

      {view === 'roster' ? (
        <>
          {cwdUnresolvable && sessionId !== undefined && (
            <p className="dsh-swarm-dim" style={{ padding: '8px 16px 0' }}>
              {t('roster.unresolvable')}
            </p>
          )}
          <DutyTableEditor board={board} onSaved={() => {}} />
          <RuntimeSettings board={board} />
        </>
      ) : view === 'flow' ? (
        run !== null ? (
          <FlowChart run={run} tasks={tasks} />
        ) : (
          <div className="dsh-swarm-placeholder"><p>{t('flow.noRun')}</p></div>
        )
      ) : board === null && error === null ? (
        <div className="dsh-swarm-placeholder"><p>{t('board.connecting')}</p></div>
      ) : runs.length === 0 ? (
        <div className="dsh-swarm-placeholder">
          <p>{t('board.emptyTitle')}</p>
          <p className="dsh-swarm-dim">{t('board.emptyHint')}</p>
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
                <span className="dsh-swarm-run-meta">{statusT(r.status)} · {timeAgo(r.createdAt, t)}</span>
              </button>
            ))}
          </aside>

          {run !== null && (
            <main className="dsh-swarm-main">
              <div className="dsh-swarm-run-header">
                <div>
                  <h3>{run.title}</h3>
                  <p className="dsh-swarm-dim">{run.spec.length > 220 ? run.spec.slice(0, 220) + '…' : run.spec}</p>
                  <p className="dsh-swarm-dim">{t('run.created', { time: timeAgo(run.createdAt, t) })}{run.completedAt !== undefined && run.createdAt !== undefined ? ` · ${t('run.finished', { time: timeAgo(run.completedAt, t) })}` : ` · ${t('run.elapsed', { time: timeAgo(run.createdAt, t) })}`}</p>
                  {(() => {
                    const cwd = run.dispatch?.cwd
                    if (cwd === undefined) return null
                    const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
                    const siblings = (board?.runs ?? []).filter((r) =>
                      r.id !== run.id && (r.status === 'planning' || r.status === 'running' || r.status === 'paused')
                      && r.dispatch?.cwd !== undefined && norm(r.dispatch.cwd) === norm(cwd))
                    return siblings.length > 0
                      ? <p className="dsh-swarm-run-banner">⚠ {t('run.others', { count: siblings.length, plural: siblings.length === 1 ? '' : 's', titles: siblings.map((s) => s.title).join(' · ') })}</p>
                      : null
                  })()}
                </div>
                <div className="dsh-swarm-run-actions">
                  {(run.status === 'planning') && (
                    <button className="dsh-swarm-btn primary" disabled={busy} onClick={() => { void runAction({ action: 'endorse', runId: run.id }) }}>
                      {t('run.endorse')}
                    </button>
                  )}
                  {(run.status === 'paused' || run.status === 'failed') && (
                    <button className="dsh-swarm-btn primary" disabled={busy} title={t('run.resumeTitle')} onClick={() => { void runAction({ action: 'resume', runId: run.id }) }}>
                      {t('run.resume')}
                    </button>
                  )}
                  {(run.status === 'running' || run.status === 'planning' || run.status === 'paused') && (
                    <button className="dsh-swarm-btn danger" disabled={busy} onClick={() => { void runAction({ action: 'abort', runId: run.id }) }}>
                      {t('run.abort')}
                    </button>
                  )}
                </div>
              </div>
              {run.status === 'paused' && run.pauseReason !== undefined && (
                <p className="dsh-swarm-run-banner">⏸ {run.pauseReason}</p>
              )}
              {run.status === 'failed' && (
                <p className="dsh-swarm-run-banner">{t('run.failedBanner')}</p>
              )}
              {actionError !== null && <p className="dsh-swarm-action-error">{actionError}</p>}

              {run.report !== undefined && (
                <details className="dsh-swarm-report" open>
                  <summary>
                    {t('run.report', {
                      count: run.report.taskCount,
                      seconds: Math.round(run.report.durationMs / 1000),
                      fallbacks: run.report.stats.fallbacks,
                      plural: run.report.stats.fallbacks === 1 ? '' : 's',
                      retries: run.report.stats.retries,
                      passed: run.report.stats.reviewsPassed,
                      total: run.report.stats.reviewsPassed + run.report.stats.reviewsRejected,
                    })}
                  </summary>
                  <ul>
                    {run.report.tasks.map((t) => (
                      <li key={t.id}>
                        <code>{t.id}</code> <kbd>{t.role}</kbd>
                        {t.model !== undefined && <em> {t.model}</em>}
                        {t.reviewExhausted === true && <strong title={translate('run.reviewExhausted')}> ⚠</strong>}
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
                      <h4>{t(column.labelKey)} <span className="dsh-swarm-count">{columnTasks.length}</span></h4>
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
                              ? <em title={translate('task.reviewedByTitle', { role: task.reviewBy })}>✓✓</em>
                              : task.humanReview === true
                                ? <em title={translate('task.humanReviewTitle')}>👤</em>
                                : <em title={translate('task.reviewLoopTitle', { role: task.reviewBy })}>↻{task.reviews ?? 0}</em>)}
                            {task.nudgedAt !== undefined && (
                              <em title={translate('task.noNoteTitle')} style={{ color: 'rgb(227, 148, 36)' }}>🔕</em>
                            )}
                          </span>
                          {task.lastNote !== undefined && (() => {
                            const stale = task.lastNoteAt !== undefined && (Date.now() - task.lastNoteAt) > 10 * 60 * 1000
                            return (
                              <span
                                className={stale ? 'dsh-swarm-task-note stale' : 'dsh-swarm-task-note'}
                                title={stale && task.lastNoteAt !== undefined ? translate('task.noteFrom', { time: timeAgo(task.lastNoteAt, translate) }) : undefined}
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
                <dt>{t('field.task')}</dt><dd><code>{selectedTask.id}</code></dd>
                <dt>{t('field.status')}</dt><dd style={{ color: statusColor(selectedTask.status) }}>{statusT(selectedTask.status)}{selectedTask.blockedReason !== undefined ? ` — ${selectedTask.blockedReason}` : ''}</dd>
                <dt>{t('field.role')}</dt><dd><kbd>{selectedTask.role}</kbd></dd>
                <dt>{t('field.model')}</dt>
                <dd>{selectedTask.agent?.model !== undefined ? `${selectedTask.agent.provider ?? ''} / ${selectedTask.agent.model}` : t('field.deploymentDefault')}</dd>
                {selectedTask.blockedBy !== undefined && selectedTask.blockedBy.length > 0 && (
                  <>
                    <dt>{t('field.dependsOn')}</dt><dd>{selectedTask.blockedBy.map((b) => <code key={b}>{b}</code>)}</dd>
                  </>
                )}
                {selectedTask.reviewBy !== undefined && (
                  <>
                    <dt>{t('field.reviewedBy')}</dt><dd><kbd>{selectedTask.reviewBy}</kbd>{selectedTask.reviewed === true ? ' ✓' : ''}{(selectedTask.reviews ?? 0) > 0 ? ` ${t('field.rounds', { count: selectedTask.reviews ?? 0, plural: (selectedTask.reviews ?? 0) === 1 ? '' : 's' })}` : ''}{selectedTask.reviewExhausted === true ? t('field.loopExhausted') : ''}</dd>
                  </>
                )}
                {selectedTask.writes !== undefined && selectedTask.writes.length > 0 && (
                  <>
                    <dt>{t('field.writeScope')}</dt><dd>{selectedTask.writes.map((f) => <code key={f}>{f}</code>).join(' ')}</dd>
                  </>
                )}
                <dt>{t('field.attempts')}</dt><dd>{selectedTask.attempts}</dd>
                <dt>{t('field.updated')}</dt><dd>{timeAgo(selectedTask.updatedAt, t)}</dd>
              </dl>
              <h4>{t('field.brief')}</h4>
              <p className="dsh-swarm-brief">{selectedTask.description}</p>
              {selectedTask.summary !== undefined && selectedTask.summary.length > 0 && (
                <>
                  <h4>{t('field.finalSummary')}</h4>
                  <p className="dsh-swarm-brief">{selectedTask.summary}</p>
                </>
              )}
              {selectedTask.reviewFeedback !== undefined && selectedTask.reviewFeedback.length > 0 && (
                <>
                  <h4>{t('field.reviewerFeedback')}</h4>
                  <p className="dsh-swarm-brief">{selectedTask.reviewFeedback}</p>
                </>
              )}
              {selectedTask.lastNote !== undefined && selectedTask.lastNote !== selectedTask.summary && (
                <>
                  <h4>{t('field.latestNote')}</h4>
                  <p className="dsh-swarm-brief">{selectedTask.lastNote}</p>
                </>
              )}
              {(selectedTask.humanReview === true && selectedTask.status === 'reviewing') && (
                <>
                  <h4>{t('review.pending')}</h4>
                  <div className="dsh-swarm-tvc-actions">
                    <button
                      className="dsh-swarm-btn primary"
                      disabled={busy}
                      onClick={() => { void runAction({ action: 'review', runId: selectedTask.runId, taskId: selectedTask.id, verdict: 'approve' }).then(() => setSelectedTask(null)) }}
                    >
                      {t('review.approve')}
                    </button>
                    <button
                      className="dsh-swarm-btn danger"
                      disabled={busy}
                      onClick={() => { void runAction({ action: 'review', runId: selectedTask.runId, taskId: selectedTask.id, verdict: 'reject' }) }}
                    >
                      {t('review.reject')}
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
                  {t('task.retry')}
                </button>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
