// Flow view: the run's task DAG as a top-down flow chart — scheduler node,
// parallel waves (same rank = runs in parallel), dependency arrows, reviewer
// chips, live status colors. Pure client-side layout over the board snapshot.
//
// Fixed-height coordinates keep the source layout deterministic (content is
// truncated to fit). Native-size nodes stay readable by default; explicit zoom
// and Fit provide an overview without leaving an unscaled overflow footprint.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardRun, BoardTask } from './board-store'
import { flowNodeAttributes, isActivationKey, resolveFlowSelection } from './flow-select'
import { createFlowLayout, flowFitScale, FLOW_METRICS } from './flow-layout'
import { statusT, useT, type Translate } from './locale'
import { agentIdentity, reviewLabel, reviewState } from './review-state'

const { nodeWidth: NODE_W, nodeHeight: NODE_H, schedulerHeight: SCHEDULER_H, reportHeight: REPORT_H, gapY: GAP_Y } = FLOW_METRICS
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2

function statusColor(status: string): string {
  if (status === 'completed') return 'rgb(46, 160, 67)'
  if (status === 'running' || status === 'dispatching') return 'rgb(56, 139, 253)'
  if (status === 'reviewing') return 'rgb(210, 153, 34)'
  if (status === 'paused') return 'rgb(227, 148, 36)'
  if (status === 'failed' || status === 'blocked') return 'rgb(219, 88, 96)'
  return 'rgba(125, 125, 125, 0.7)'
}

function phaseLabel(task: BoardTask, t: Translate): string {
  if (task.attemptRevoked === true) return reviewLabel(task, t)
  switch (task.status) {
    case 'completed': return reviewState(task) === 'not-requested' ? t('phase.done') : `${t('phase.done')} · ${reviewLabel(task, t)}`
    case 'reviewing': return task.humanReview === true ? t('phase.humanReview') : t('phase.review', { role: task.reviewBy ?? '' })
    case 'running': return t('phase.running')
    case 'dispatching': return t('phase.dispatching')
    case 'retrying': return t('phase.retrying', { n: task.attempts + 1 })
    case 'failed': return t('phase.failed')
    case 'blocked': return t('phase.blocked')
    default: return (task.blockedBy ?? []).length > 0 ? t('phase.waiting') : t('phase.queued')
  }
}

export function FlowChart({ run, tasks, onSelectTask, selectedTaskId }: {
  run: BoardRun
  tasks: BoardTask[]
  /** Opens the task in the shared detail sidebar — Board and Flow drive one selection state. */
  onSelectTask?: (task: BoardTask) => void
  /** The task currently open in the sidebar, so its box can render as active. */
  selectedTaskId?: string | null
}): JSX.Element {
  const t = useT()
  const layout = useMemo(() => createFlowLayout(tasks), [tasks])
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  // null means explicit Fit mode. Progress updates do not reset a user's zoom.
  const [zoom, setZoom] = useState<number | null>(1)
  const scale = zoom ?? flowFitScale(layout, viewport)
  const scaledWidth = layout.width * scale
  const scaledHeight = layout.height * scale
  const changeZoom = (delta: number): void => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((scale + delta) * 100) / 100)))
  }

  useEffect(() => {
    const el = viewportRef.current
    if (el === null) return
    const update = (): void => {
      const width = el.clientWidth
      const height = el.clientHeight
      setViewport((current) => current.width === width && current.height === height ? current : { width, height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])

  // Start at the left edge, including charts wider than the pane. Resize/drawer/
  // zoom changes return there; ordinary progress leaves a user's pan alone.
  useEffect(() => {
    const el = viewportRef.current
    if (el !== null) el.scrollLeft = 0
  }, [run.id, layout.width, scale, viewport.width])
  useEffect(() => {
    const el = viewportRef.current
    if (el !== null) el.scrollTop = 0
  }, [run.id])

  const sinks = tasks.filter((t) => !tasks.some((other) => (other.blockedBy ?? []).includes(t.id)))
  const decorationX = FLOW_METRICS.padding
  const decorationCx = decorationX + NODE_W / 2

  // S-curve edge: from bottom-center of source to top-center of target
  const edgePath = (sx: number, sy: number, tx: number, ty: number): string => {
    const c1y = sy + (ty - sy) * 0.4
    const c2y = sy + (ty - sy) * 0.6
    return `M ${sx} ${sy} C ${sx} ${c1y}, ${tx} ${c2y}, ${tx} ${ty}`
  }

  // Anchor helpers: bottom-center and top-center of a node
  const bottomCx = (x: number): number => x + NODE_W / 2
  const topCx = (x: number): number => x + NODE_W / 2

  const schedulerStatus = run.status === 'awaiting-endorsement' ? t('flow.awaitingEndorsement') : statusT(run.status)

  return (
    <div className="dsh-swarm-flow">
      <div className="dsh-swarm-flow-toolbar">
        <div className="dsh-swarm-flow-legend">
          <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('completed') }} /> {t('legend.done')}</span>
          <span><span className="dsh-swarm-tvc-dot live" style={{ background: statusColor('running') }} /> {t('legend.running')}</span>
          <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('reviewing') }} /> {t('legend.review')}</span>
          <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('failed') }} /> {t('legend.failed')}</span>
          <span><span className="dsh-swarm-tvc-dot" style={{ background: 'rgba(125, 125, 125, 0.6)' }} /> {t('legend.queued')}</span>
        </div>
        <div className="dsh-swarm-flow-zoom" role="group" aria-label={t('flow.zoomControls')}>
          <button type="button" className="dsh-swarm-btn ghost" onClick={() => { changeZoom(-0.1) }} disabled={scale <= MIN_ZOOM} title={t('flow.zoomOut')} aria-label={t('flow.zoomOut')}>−</button>
          <button type="button" className="dsh-swarm-btn ghost dsh-swarm-flow-zoom-level" onClick={() => { setZoom(1) }} title={t('flow.actualSize')} aria-label={t('flow.actualSize')}>{Math.round(scale * 100)}%</button>
          <button type="button" className="dsh-swarm-btn ghost" onClick={() => { changeZoom(0.1) }} disabled={scale >= MAX_ZOOM} title={t('flow.zoomIn')} aria-label={t('flow.zoomIn')}>+</button>
          <button type="button" className="dsh-swarm-btn ghost" onClick={() => { setZoom(null) }} aria-pressed={zoom === null} title={t('flow.fitTitle')}>{t('flow.fit')}</button>
        </div>
      </div>
      <div ref={viewportRef} className="dsh-swarm-flow-viewport">
        <div className="dsh-swarm-flow-fit" style={{ width: scaledWidth, height: scaledHeight }}>
          <div className="dsh-swarm-flow-scaled" style={{ width: scaledWidth, height: scaledHeight }}>
            <div
              className="dsh-swarm-flow-canvas"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            >
              {/* SVG edges (rendered UNDER the nodes so arrows don't cross boxes) */}
              <svg
                className="dsh-swarm-flow-edges"
                width={layout.width}
                height={layout.height}
                style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 0 }}
              >
                <defs>
                  <marker id="dsh-swarm-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
                    <path d="M 0 0 L 7 3.5 L 0 7 z" fill="rgba(125, 125, 125, 0.7)" />
                  </marker>
                  <marker id="dsh-swarm-arrow-done" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
                    <path d="M 0 0 L 7 3.5 L 0 7 z" fill="rgba(46, 160, 67, 0.7)" />
                  </marker>
                </defs>
                {/* scheduler → wave-0 tasks */}
                {(layout.byRank.get(0) ?? []).map((t) => {
                  const pos = layout.positions.get(t.id)!
                  return (
                    <path
                      key={`s-${t.id}`}
                      d={edgePath(
                        decorationCx, SCHEDULER_H,
                        topCx(pos.x), pos.y,
                      )}
                      className="dsh-swarm-flow-edge"
                      markerEnd="url(#dsh-swarm-arrow)"
                    />
                  )
                })}
                {/* dependency edges: bottom-center of blocker → top-center of dependent */}
                {tasks.map((t) => (t.blockedBy ?? []).map((b) => {
                  const from = layout.positions.get(b)
                  const to = layout.positions.get(t.id)
                  if (from === undefined || to === undefined) return null
                  const done = tasks.find((x) => x.id === b)?.status === 'completed'
                  return (
                    <path
                      key={`${b}-${t.id}`}
                      d={edgePath(
                        bottomCx(from.x), from.y + NODE_H,
                        topCx(to.x), to.y,
                      )}
                      className={done ? 'dsh-swarm-flow-edge done' : 'dsh-swarm-flow-edge'}
                      markerEnd={done ? 'url(#dsh-swarm-arrow-done)' : 'url(#dsh-swarm-arrow)'}
                    />
                  )
                }))}
                {/* sinks → report */}
                {sinks.map((t) => {
                  const pos = layout.positions.get(t.id)
                  if (pos === undefined) return null
                  return (
                    <path
                      key={`r-${t.id}`}
                      d={edgePath(
                        bottomCx(pos.x), pos.y + NODE_H,
                        decorationCx, layout.reportY,
                      )}
                      className={t.status === 'completed' ? 'dsh-swarm-flow-edge done' : 'dsh-swarm-flow-edge'}
                      markerEnd={t.status === 'completed' ? 'url(#dsh-swarm-arrow-done)' : 'url(#dsh-swarm-arrow)'}
                    />
                  )
                })}
              </svg>

              {/* scheduler node */}
              <div
                className="dsh-swarm-flow-node scheduler"
                style={{ left: decorationX, top: 0, width: NODE_W, height: SCHEDULER_H, zIndex: 1 }}
              >
                <div className="dsh-swarm-flow-node-title">{t('flow.scheduler')}</div>
                <div className="dsh-swarm-flow-node-sub">{schedulerStatus}</div>
              </div>

              {/* wave labels (between rows, in the gap) */}
              {layout.ranks.map((r) => {
                const row = layout.byRank.get(r) ?? []
                const parallel = row.length > 1
                const labelY = layout.schedBottom + r * layout.rowStride - GAP_Y / 2 - 6
                return (
                  <div
                    key={`wave-${r}`}
                    className="dsh-swarm-flow-wave"
                    style={{ left: decorationX, top: labelY, zIndex: 1 }}
                  >
                    {t('flow.wave', { n: r + 1 })}{parallel ? t('flow.parallelCount', { count: row.length }) : ''}
                  </div>
                )
              })}

              {/* task nodes (uniform height, content truncated to fit) */}
              {tasks.map((task) => {
                const pos = layout.positions.get(task.id)
                if (pos === undefined) return null
                const color = statusColor(task.status)
                const writeHint = (task.writes ?? []).length > 0
                  ? `✎ ${(task.writes ?? []).slice(0, 2).join(', ')}${(task.writes ?? []).length > 2 ? '…' : ''}`
                  : ''
                // Selection is resolved through the pure module: only a real task of THIS
                // run is selectable, and the same toggle the Board cards use applies here
                // (clicking the open task closes the sidebar).
                const selection = onSelectTask === undefined ? null : resolveFlowSelection({ taskId: task.id }, run.id, tasks)
                const interactive = selection !== null
                const attrs = flowNodeAttributes(interactive, interactive && selectedTaskId === task.id)
                const activate = (): void => {
                  if (selection !== null && onSelectTask !== undefined) onSelectTask(selection.task)
                }
                return (
                  <div
                    key={task.id}
                    className={attrs.className}
                    role={attrs.role}
                    tabIndex={attrs.tabIndex}
                    aria-pressed={attrs['aria-pressed']}
                    onClick={interactive ? activate : undefined}
                    onKeyDown={interactive
                      ? (event) => {
                          if (isActivationKey(event.key)) {
                            event.preventDefault()
                            activate()
                          }
                        }
                      : undefined}
                    style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H, borderColor: color, zIndex: 1 }}
                    title={`${task.subject}\n${reviewLabel(task, t)}${task.agent !== undefined ? `\n${t('field.builder')}: ${agentIdentity(task.agent, '')}` : ''}${task.reviewerAgent !== undefined ? `\n${t('field.reviewer')}: ${agentIdentity(task.reviewerAgent, '')}` : ''}${(task.writes ?? []).length > 0 ? `\n${t('flow.writesTitle', { paths: (task.writes ?? []).join(', ') })}` : ''}`}
                  >
                    <div className="dsh-swarm-flow-node-title">
                      <span className="dsh-swarm-flow-dot" style={{ background: color }} />
                      <code>{task.id}</code>
                      <span className="dsh-swarm-flow-role">{task.role}</span>
                    </div>
                    <div className="dsh-swarm-flow-node-sub">{phaseLabel(task, t)}</div>
                    {writeHint !== '' && <div className="dsh-swarm-flow-node-writes">{writeHint}</div>}
                  </div>
                )
              })}

              {/* report node */}
              <div
                className="dsh-swarm-flow-node report"
                style={{ left: decorationX, top: layout.reportY, width: NODE_W, height: REPORT_H, zIndex: 1 }}
              >
                <div className="dsh-swarm-flow-node-title">{t('flow.report')}</div>
                <div className="dsh-swarm-flow-node-sub">{run.status === 'completed' ? t('flow.generated') : run.status === 'failed' ? t('phase.failed') : t('flow.onCompletion')}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
