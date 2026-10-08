import { useCallback, useEffect, useMemo, useState } from 'react'
import { boardStore, type Board, type BoardRun, type BoardRunState, type BoardSyncState, type BoardTask } from './board-store'
import { DutyTableEditor } from './DutyTableEditor'
import { FlowChart } from './FlowChart'
import { RuntimeSettings } from './RuntimeSettings'
import { statusT, useT, t as translate } from './locale'
import { isCurationAction, isHostStale, isUnknownActionError } from './version'
import { formatWriteScope } from './write-scope'
import { resolveBoardSelection, selectionAfterSuccessfulAction, toggleTask, visibleRuns, type TaskKey, type WorkspaceState } from './board-selection'
import { agentIdentity, reviewLabel, reviewState } from './review-state'
import { useRequestOwner } from './use-request-owner'

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

// The optional initial* props are a TEST SEAM for renderToStaticMarkup: the board,
// the tab and the selected task are otherwise only reachable through effects or a
// click, which a DOM-less render cannot produce. Production passes none of them.
export function SwarmTab({ sessionId, initialBoard, initialView, initialSelectedTask, initialError, initialActionError, initialSync }: {
  sessionId?: string
  initialBoard?: Board
  initialView?: 'board' | 'flow' | 'roster'
  initialSelectedTask?: BoardTask
  initialError?: string
  initialActionError?: string
  initialSync?: BoardSyncState
} = {}): JSX.Element {
  const t = useT()
  const [board, setBoard] = useState<Board | null>(initialBoard ?? null)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [sync, setSync] = useState<BoardSyncState>(initialSync ?? (initialBoard === undefined ? 'connecting' : 'snapshot'))
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialSelectedTask?.runId ?? null)
  const [selectedTaskKey, setSelectedTaskKey] = useState<TaskKey | null>(initialSelectedTask === undefined ? null : { runId: initialSelectedTask.runId, id: initialSelectedTask.id })
  const workspaceOwner = useRequestOwner()
  const actionOwner = useRequestOwner()
  const [view, setView] = useState<'board' | 'flow' | 'roster'>(initialView ?? 'board')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(initialActionError ?? null)

  // A8: soft run management — a ⋯ menu per row (also on right-click), inline
  // rename, a two-step Remove from board, and a stronger two-step Delete
  // permanently. Every one of them travels the existing board action path as a
  // single append-only event, so no new request or connection is involved.
  const [menuRunId, setMenuRunId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  // A separate confirm for the permanent action: arming Remove must never arm it.
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)
  const [renamingRunId, setRenamingRunId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)

  // Workspace scoping (v0.4.0): default to this chat's workspace; "All" is one click away.
  const [scope, setScope] = useState<'workspace' | 'all'>(() => {
    try { return localStorage.getItem('dsh-swarm-workspace-scope') === 'all' ? 'all' : 'workspace' } catch { return 'workspace' }
  })
  const [workspace, setWorkspace] = useState<WorkspaceState>({ sessionId, cwd: null, loading: !!sessionId, error: null })
  const workspaceLoading = !!sessionId && (workspace.sessionId !== sessionId || workspace.loading)
  const cwdUnresolvable = !!sessionId && !workspaceLoading && workspace.cwd === null

  const resetActions = useCallback(() => {
    actionOwner.cancel()
    setBusy(false)
    setActionError(null)
    setMenuRunId(null)
    setConfirmRemoveId(null)
    setConfirmPurgeId(null)
    setRenamingRunId(null)
  }, [actionOwner])

  const switchScope = useCallback((next: 'workspace' | 'all') => {
    resetActions()
    setScope(next)
    setSelectedRunId(null)
    setSelectedTaskKey(null)
    try { localStorage.setItem('dsh-swarm-workspace-scope', next) } catch { /* storage may be disabled */ }
  }, [resetActions])

  useEffect(() => {
    setSelectedRunId(null)
    setSelectedTaskKey(null)
    setMenuRunId(null)
    setConfirmRemoveId(null)
    setConfirmPurgeId(null)
    setRenamingRunId(null)
    setActionError(null)
    setBusy(false)
    actionOwner.cancel()
    const request = workspaceOwner.begin()
    setWorkspace({ sessionId, cwd: null, loading: !!sessionId, error: null })
    if (!sessionId) return () => { workspaceOwner.cancel() }
    void fetch(`/swarm/workspace?session=${encodeURIComponent(sessionId)}`, { signal: request.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ cwd?: string; unresolvable?: boolean }>
      })
      .then((info) => {
        if (!request.owns()) return
        const cwd = typeof info.cwd === 'string' && info.cwd.length > 0 ? info.cwd : null
        setWorkspace({ sessionId, cwd, loading: false, error: cwd === null ? translate('scope.unresolvableTitle') : null })
      })
      .catch((err: unknown) => {
        if (request.owns()) setWorkspace({ sessionId, cwd: null, loading: false, error: String(err instanceof Error ? err.message : err) })
      })
    return () => { workspaceOwner.cancel() }
  }, [sessionId, workspaceOwner, actionOwner])

  useEffect(() => {
    const store = boardStore()
    const release = store.retain()
    const unsubscribe = store.subscribe((next, err, state) => {
      setBoard(next)
      setError(err)
      setSync(state ?? (err === null ? 'snapshot' : 'reconnecting'))
    })
    return () => {
      unsubscribe()
      release()
    }
  }, [])

  const runs = useMemo(() => visibleRuns(board, scope, sessionId, workspace), [board, scope, sessionId, workspace])
  const { run, task: selectedTask } = useMemo(
    () => resolveBoardSelection(board, runs, selectedRunId, selectedTaskKey),
    [board, runs, selectedRunId, selectedTaskKey],
  )

  useEffect(() => { resetActions() }, [sessionId, scope, run?.id, resetActions])

  // Keys, never stored task snapshots: a live update replaces drawer contents,
  // and removed/filtered tasks cannot leave stale actions or resurrect later.
  useEffect(() => {
    const visible = (id: string | null): boolean => id !== null && runs.some((candidate) => candidate.id === id)
    if (selectedRunId !== null && !visible(selectedRunId)) setSelectedRunId(null)
    if (selectedTaskKey !== null && selectedTask === null) setSelectedTaskKey(null)
    if (menuRunId !== null && !visible(menuRunId)) setMenuRunId(null)
    if (renamingRunId !== null && !visible(renamingRunId)) setRenamingRunId(null)
    if (confirmRemoveId !== null && !visible(confirmRemoveId)) setConfirmRemoveId(null)
    if (confirmPurgeId !== null && !visible(confirmPurgeId) && !board?.removedRuns?.some((candidate) => candidate.id === confirmPurgeId)) setConfirmPurgeId(null)
  }, [runs, board, selectedRunId, selectedTaskKey, selectedTask, menuRunId, renamingRunId, confirmRemoveId, confirmPurgeId])

  const tasks = useMemo(
    () => (board !== null && run !== null ? board.tasks.filter((t) => t.runId === run.id) : []),
    [board, run],
  )

  // B1: is the RUNNING host older than this page? The browser re-reads this bundle
  // from disk on every load while the host only reloads at boot, so after an upgrade
  // the UI can offer actions the host never registered — observed as a bare
  // `unknown action "…"` with nothing happening (the 0.6.20 menu against a 0.6.17
  // host). Capabilities first, then version math, never disabled on a parse failure
  // — see client/version.ts.
  const hostVersion = board?.version ?? '?'
  const hostStale = board !== null && isHostStale(board.version, board.capabilities)
  const hostStaleTitle = t(Array.isArray(board?.capabilities) ? 'run.hostCapabilityMissing' : 'run.hostStaleTitle', { version: hostVersion })

  const runAction = useCallback(async (body: { action: string; runId?: string; taskId?: string; verdict?: string; title?: string; state?: BoardRunState }) => {
    // Refuse the actions only a restarted host serves, so a stale host is never sent
    // a request it must reject. Every other action exists on every host.
    if (isCurationAction(body.action) && hostStale) {
      setActionError(hostStaleTitle)
      return
    }
    if (busy) return
    const request = actionOwner.begin()
    setBusy(true)
    setActionError(null)
    try {
      await boardStore().action(body, request.signal)
      if (!request.owns()) return
      setSelectedTaskKey((current) => selectionAfterSuccessfulAction(current, body))
    } catch (err) {
      if (!request.owns()) return
      const message = String(err instanceof Error ? err.message : err)
      // Last-resort net for any action a FUTURE release adds: a raw
      // `unknown action "…"` means the host has not registered it, which calls for a
      // restart rather than leaving the operator with an opaque string.
      setActionError(isUnknownActionError(message)
        ? translate('run.actionUnknown', { version: boardStore().get()?.version ?? '?' })
        : message)
    } finally {
      if (request.owns()) setBusy(false)
    }
  }, [hostStale, hostStaleTitle, busy, actionOwner])

  // A8: close the row menu on any outside click. The menu itself stops
  // propagation, so its own items — including the two-step confirms — never
  // close it before they act.
  useEffect(() => {
    if (menuRunId === null) return
    const close = (): void => { setMenuRunId(null); setConfirmRemoveId(null); setConfirmPurgeId(null) }
    document.addEventListener('click', close)
    return () => { document.removeEventListener('click', close) }
  }, [menuRunId])

  const startRename = useCallback((target: BoardRun) => {
    setMenuRunId(null)
    setConfirmRemoveId(null)
    setConfirmPurgeId(null)
    setRenamingRunId(target.id)
    setRenameValue(target.title)
  }, [])

  const commitRename = useCallback(() => {
    const id = renamingRunId
    setRenamingRunId(null)
    if (id === null) return
    const title = renameValue.trim()
    // An emptied field is a cancel rather than a failed request (the host rejects
    // a blank title too, so there is nothing to send).
    if (title.length === 0) return
    void runAction({ action: 'rename-run', runId: id, title })
  }, [renamingRunId, renameValue, runAction])

  // One path for all three board states: `removed` (recoverable recycle bin),
  // `visible` (restore) and `purged` (hidden from the board and the removed list).
  // The host records a single append-only event, and deletes nothing on disk
  // either way — the run stays in its view and in the log.
  const setBoardState = useCallback((runId: string, state: BoardRunState) => {
    setMenuRunId(null)
    setConfirmRemoveId(null)
    setConfirmPurgeId(null)
    void runAction({ action: 'set-run-board-state', runId, state })
  }, [runAction])

  // One drawer instance for every view: the Flow canvas and the board share the
  // same selection, so re-nesting this inside the board branch is exactly the
  // defect this replaced (clicking a flow box highlighted the task but opened
  // nothing). tests/flow-drawer.test.ts pins the Flow case.
  const taskDrawer = selectedTask !== null ? (
    <aside className="dsh-swarm-drawer">
      <header>
        <h3>{selectedTask.subject}</h3>
        <button className="dsh-swarm-btn ghost" onClick={() => { setSelectedTaskKey(null) }}>✕</button>
      </header>
      <dl>
        <dt>{t('field.task')}</dt><dd><code>{selectedTask.id}</code></dd>
        <dt>{t('field.status')}</dt><dd style={{ color: statusColor(selectedTask.status) }}>{statusT(selectedTask.status)}{selectedTask.blockedReason !== undefined ? ` — ${selectedTask.blockedReason}` : ''}</dd>
        <dt>{t('field.role')}</dt><dd><kbd>{selectedTask.role}</kbd></dd>
        <dt>{t('field.builder')}</dt>
        <dd>{agentIdentity(selectedTask.agent, t('field.identityUnknown'))}</dd>
        <dt>{t('field.reviewStatus')}</dt><dd>{reviewLabel(selectedTask, t)}</dd>
        {selectedTask.blockedBy !== undefined && selectedTask.blockedBy.length > 0 && (
          <>
            <dt>{t('field.dependsOn')}</dt><dd>{selectedTask.blockedBy.map((b) => <code key={b}>{b}</code>)}</dd>
          </>
        )}
        {(selectedTask.reviewBy !== undefined || selectedTask.reviewerAgent !== undefined || selectedTask.humanReview === true || selectedTask.reviewGate === 'human') && (
          <>
            <dt>{t('field.reviewer')}</dt>
            <dd><kbd>{selectedTask.reviewBy ?? (selectedTask.humanReview === true || selectedTask.reviewGate === 'human' ? t('field.human') : '')}</kbd>{' '}{agentIdentity(selectedTask.reviewerAgent, selectedTask.humanReview === true || selectedTask.reviewGate === 'human' ? t('field.human') : t('field.identityUnknown'))}{(selectedTask.reviews ?? 0) > 0 ? ` ${t('field.rounds', { count: selectedTask.reviews ?? 0, plural: (selectedTask.reviews ?? 0) === 1 ? '' : 's' })}` : ''}</dd>
          </>
        )}
        {Array.isArray(selectedTask.writes) && selectedTask.writes.length > 0 && (
          <>
            <dt>{t('field.writeScope')}</dt>
            <dd>
              {formatWriteScope(selectedTask.writes).map((label, i) => (
                // Formatting lives in client/write-scope.ts (pure, unit-tested):
                // a config-authored scope can be an object, and a malformed
                // payload must never print "[object Object]" or throw.
                <code key={i}>{label}</code>
              ))}
            </dd>
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
      {(selectedTask.fileWarnings?.length ?? 0) > 0 && <div role="alert" className="dsh-swarm-action-error">
        <h4>{t('field.fileWarnings')}</h4>
        <ul>{selectedTask.fileWarnings?.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </div>}
      {(selectedTask.evidenceOutcomes?.length ?? 0) > 0 && <details>
        <summary>{t('field.evidenceOutcomes')}</summary>
        <pre className="dsh-swarm-brief">{JSON.stringify(selectedTask.evidenceOutcomes, null, 2)}</pre>
      </details>}
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
      {((selectedTask.humanReview === true || selectedTask.reviewGate === 'human') && selectedTask.status === 'reviewing') && (
        <>
          <h4>{t('review.pending')}</h4>
          <div className="dsh-swarm-tvc-actions">
            <button
              className="dsh-swarm-btn primary"
              disabled={busy}
              onClick={() => { void runAction({ action: 'review', runId: selectedTask.runId, taskId: selectedTask.id, verdict: 'approve' }) }}
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
  ) : null
  return (
    <div className="dsh-swarm-tab">
      <header className="dsh-swarm-header">
        <h2>Swarm</h2>
        <div className="dsh-swarm-segments" role="tablist">
          <button className={view === 'board' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('board') }}>{t('tab.board')}</button>
          <button className={view === 'flow' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('flow') }}>{t('tab.flow')}</button>
          <button className={view === 'roster' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'} onClick={() => { setView('roster') }}>{t('tab.roster')}</button>
        </div>
  {/* Workspace scope switch: visible whenever the tab knows which chat it is in. */}
  {sessionId !== undefined && (
    <div className="dsh-swarm-segments" role="tablist" title={t('scope.title')}>
      <button
        className={scope === 'workspace' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'}
        disabled={cwdUnresolvable || workspaceLoading}
        title={workspaceLoading ? t('scope.resolving') : cwdUnresolvable ? t('scope.unresolvableTitle') : t('scope.showWorkspace')}
        onClick={() => { switchScope('workspace') }}
      >{t('scope.workspace')}</button>
      <button
        className={scope === 'all' ? 'dsh-swarm-segment active' : 'dsh-swarm-segment'}
        onClick={() => { switchScope('all') }}
      >{t('scope.all')}</button>
    </div>
  )}
        <span role="status" className={error !== null ? 'dsh-swarm-pill warn' : 'dsh-swarm-pill'} title={error ?? undefined}>
          {t(`sync.${sync}`)}{board !== null ? ` · ${t('pill.info', { version: board.version, seq: board.seq, count: runs.length, plural: runs.length === 1 ? '' : 's' })}` : ''}
        </span>
      </header>
      {error !== null && <p role="alert" className="dsh-swarm-action-error">{t('board.refreshError', { error })}{' '}<button className="dsh-swarm-btn ghost" onClick={() => { boardStore().refresh() }}>{t('board.refresh')}</button></p>}
      {actionError !== null && <p role="alert" className="dsh-swarm-action-error">{actionError}</p>}
      {workspace.error !== null && workspace.sessionId === sessionId && scope === 'workspace' && <p role="alert" className="dsh-swarm-action-error">{t('scope.fallback', { error: workspace.error })}</p>}

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
      ) : scope === 'workspace' && workspaceLoading ? (
        <div className="dsh-swarm-placeholder"><p>{t('scope.resolving')}</p></div>
      ) : view === 'flow' ? (
        // The canvas sits in the same two-column body the board uses, so the task
        // drawer has a real column: the canvas shrinks/scrolls inside <main> instead of
        // being clipped by it. Same selection state as the board cards.
        <div className="dsh-swarm-body dsh-swarm-flow-body">
          <main className="dsh-swarm-main dsh-swarm-flow-main">
            {run === null ? (
              <div className="dsh-swarm-placeholder"><p>{t('flow.noRun')}</p></div>
            ) : tasks.length === 0 ? (
              // An empty flow rendered as a legend with no nodes — indistinguishable from
              // a broken canvas. Say so, the way the Board already does for an empty run.
              <div className="dsh-swarm-placeholder"><p>{t('flow.noTasks')}</p></div>
            ) : (
              <FlowChart
                run={run}
                tasks={tasks}
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={(task) => { setSelectedTaskKey((current) => toggleTask(current, task)) }}
              />
            )}
          </main>
          {taskDrawer}
        </div>
      ) : board === null && error === null ? (
        <div className="dsh-swarm-placeholder"><p>{t('board.connecting')}</p></div>
      ) : board === null ? (
        <div className="dsh-swarm-placeholder"><p>{t('board.unavailable')}</p></div>
      ) : runs.length === 0 ? (
        <div className="dsh-swarm-placeholder">
          <p>{t('board.emptyTitle')}</p>
          <p className="dsh-swarm-dim">{t('board.emptyHint')}</p>
        </div>
      ) : (
        <div className="dsh-swarm-body">
          <aside className="dsh-swarm-runs">
            {hostStale && (
              <p className="dsh-swarm-run-notice" title={hostStaleTitle}>
                {Array.isArray(board?.capabilities) ? hostStaleTitle : t('run.hostStaleNotice', { version: hostVersion })}
              </p>
            )}
            {(board?.removedRuns?.length ?? 0) > 0 && (
              <div className="dsh-swarm-removed-head">
                <button className="dsh-swarm-removed-toggle" onClick={() => { setShowRemoved(!showRemoved) }}>
                  {t('run.removedCount', { count: board?.removedRuns?.length ?? 0 })}
                </button>
              </div>
            )}
            {showRemoved && (board?.removedRuns ?? []).map((r) => (
              <div key={r.id} className="dsh-swarm-run removed">
                <span className="dsh-swarm-run-dot" style={{ background: statusColor(r.status) }} />
                <span className="dsh-swarm-run-title">{r.title}</span>
                <span className="dsh-swarm-run-meta">{statusT(r.status)} · {timeAgo(r.createdAt, t)}</span>
                <span className="dsh-swarm-run-removed-actions">
                  <button className="dsh-swarm-btn ghost dsh-swarm-run-restore" disabled={hostStale} title={hostStale ? hostStaleTitle : undefined} onClick={() => { setBoardState(r.id, 'visible') }}>
                    {t('run.restore')}
                  </button>
                  <button
                    className={confirmPurgeId === r.id ? 'dsh-swarm-btn ghost dsh-swarm-run-purge confirm' : 'dsh-swarm-btn ghost dsh-swarm-run-purge'}
                    disabled={hostStale}
                    title={hostStale ? hostStaleTitle : t('run.purgeHint')}
                    onClick={() => {
                      // Same two-step as the menu, and the same stronger wording:
                      // permanent is never one stray click from a recoverable list.
                      if (confirmPurgeId !== r.id) { setConfirmPurgeId(r.id); return }
                      setBoardState(r.id, 'purged')
                    }}
                  >{confirmPurgeId === r.id ? t('run.confirmPurge') : t('run.purge')}</button>
                </span>
              </div>
            ))}
            {runs.map((r) => {
              const selected = run !== null && r.id === run.id
              const open = menuRunId === r.id
              return (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  className={selected ? 'dsh-swarm-run active' : 'dsh-swarm-run'}
                  onClick={() => { resetActions(); setSelectedRunId(r.id); setSelectedTaskKey(null) }}
                  onKeyDown={(event) => {
                    // Only the row itself: keys typed in the ⋯ button or the rename
                    // input must not also select the run through bubbling.
                    if (event.target !== event.currentTarget) return
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    resetActions()
                    setSelectedRunId(r.id)
                    setSelectedTaskKey(null)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    // A stale host cannot serve the menu's actions, so do not offer it.
                    if (hostStale) return
                    setMenuRunId(r.id)
                    setConfirmRemoveId(null)
                    setConfirmPurgeId(null)
                  }}
                >
                  <span className="dsh-swarm-run-dot" style={{ background: statusColor(r.status) }} />
                  {renamingRunId === r.id ? (
                    <input
                      className="dsh-swarm-run-rename"
                      value={renameValue}
                      autoFocus
                      placeholder={t('run.renamePlaceholder')}
                      onClick={(event) => { event.stopPropagation() }}
                      onChange={(event) => { setRenameValue(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); commitRename() } else if (event.key === 'Escape') { event.preventDefault(); setRenamingRunId(null) }
                      }}
                      onBlur={() => { setRenamingRunId(null) }}
                    />
                  ) : (
                    <span className="dsh-swarm-run-title">{r.title}</span>
                  )}
                  <span className="dsh-swarm-run-meta">{statusT(r.status)} · {timeAgo(r.createdAt, t)}</span>
                  {renamingRunId !== r.id && (
                    <button
                      className="dsh-swarm-run-menu-btn"
                      disabled={hostStale}
                      title={hostStale ? hostStaleTitle : t('run.menu')}
                      aria-label={t('run.menu')}
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuRunId(open ? null : r.id)
                        setConfirmRemoveId(null)
                        setConfirmPurgeId(null)
                      }}
                    >⋯</button>
                  )}
                  {open && (
                    <div className="dsh-swarm-run-menu" onClick={(event) => { event.stopPropagation() }}>
                      <button className="dsh-swarm-run-menu-item" onClick={() => { startRename(r) }}>{t('run.rename')}</button>
                      <button
                        className="dsh-swarm-run-menu-item danger"
                        title={t('run.removeHint')}
                        onClick={() => {
                          // Two-step confirm inside the menu: one stray click must
                          // not clear a run off the board. Arming this must never
                          // arm the permanent action below.
                          if (confirmRemoveId !== r.id) { setConfirmRemoveId(r.id); setConfirmPurgeId(null); return }
                          setBoardState(r.id, 'removed')
                        }}
                      >{confirmRemoveId === r.id ? t('run.confirmRemove') : t('run.remove')}</button>
                      <button
                        className={confirmPurgeId === r.id ? 'dsh-swarm-run-menu-item danger strong confirm' : 'dsh-swarm-run-menu-item danger strong'}
                        onClick={() => {
                          // A materially stronger confirm than Remove: its own state
                          // (never armed by Remove), and its second step spells out
                          // "permanent delete" in full.
                          if (confirmPurgeId !== r.id) { setConfirmPurgeId(r.id); setConfirmRemoveId(null); return }
                          setBoardState(r.id, 'purged')
                        }}
                      >{confirmPurgeId === r.id ? t('run.confirmPurge') : t('run.purge')}</button>
                      <p className="dsh-swarm-run-menu-hint">{t('run.purgeHint')}</p>
                    </div>
                  )}
                </div>
              )
            })}
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
                      total: run.report.stats.reviewsPassed + run.report.stats.reviewsRejected + (run.report.stats.reviewsUnavailable ?? 0),
                    })}
                    {(run.report.stats.reviewsUnavailable ?? 0) > 0 && <>{' '}{t('run.reviewsUnavailable', { count: run.report.stats.reviewsUnavailable ?? 0 })}</>}
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
                          onClick={() => { setSelectedTaskKey((current) => toggleTask(current, task)) }}
                        >
                          <span className="dsh-swarm-task-status" style={{ background: statusColor(task.status) }} />
                          <span className="dsh-swarm-task-subject">{task.subject}</span>
                          <span className="dsh-swarm-task-meta">
                            <kbd>{task.role}</kbd>
                            {task.agent?.model !== undefined && <code>{task.agent.provider ?? ''}/{task.agent.model}</code>}
                            {task.attempts > 1 && <em>×{task.attempts}</em>}
                            {reviewState(task) !== 'not-requested' && (
                              <em title={reviewLabel(task, t)} aria-label={reviewLabel(task, t)}>
                                {reviewState(task) === 'approved' ? '✓✓' : ['unavailable', 'exhausted', 'skipped', 'invalidated'].includes(reviewState(task)) ? '!' : reviewState(task) === 'human-pending' ? '👤' : `↻${task.reviews ?? 0}`}
                              </em>
                            )}
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

          {taskDrawer}
        </div>
      )}
    </div>
  )
}
