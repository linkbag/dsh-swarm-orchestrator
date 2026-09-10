// Flow view: the run's task DAG as a top-down flow chart — scheduler node,
// parallel waves (same rank = runs in parallel), dependency arrows, reviewer
// chips, live status colors. Pure client-side layout over the board snapshot.
//
// Layout is deterministic: every node gets a FIXED height (content truncated
// to fit), so boxes never overlap and arrows always anchor correctly
// (bottom-center → top-center). The canvas scales to fit the pane.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardRun, BoardTask } from './board-store'

const NODE_W = 200
const NODE_H = 68        // uniform — deterministic layout
const SCHEDULER_H = 48
const REPORT_H = 48
const GAP_X = 40         // horizontal gap between parallel nodes
const GAP_Y = 64         // vertical gap between ranks (space for edge + wave label)
const CANVAS_PAD = 16    // left/right padding inside the canvas

function statusColor(status: string): string {
  if (status === 'completed') return 'rgb(46, 160, 67)'
  if (status === 'running' || status === 'dispatching') return 'rgb(56, 139, 253)'
  if (status === 'reviewing') return 'rgb(210, 153, 34)'
  if (status === 'paused') return 'rgb(227, 148, 36)'
  if (status === 'failed' || status === 'blocked') return 'rgb(219, 88, 96)'
  return 'rgba(125, 125, 125, 0.7)'
}

function phaseLabel(task: BoardTask): string {
  switch (task.status) {
    case 'completed': return task.reviewed === true ? 'done · reviewed' : 'done'
    case 'reviewing': return task.humanReview === true ? 'human review' : `review · ${task.reviewBy ?? ''}`
    case 'running': return 'running'
    case 'dispatching': return 'dispatching'
    case 'retrying': return `retrying (attempt ${task.attempts + 1})`
    case 'failed': return 'failed'
    case 'blocked': return 'blocked'
    default: return (task.blockedBy ?? []).length > 0 ? 'waiting' : 'queued'
  }
}

export function FlowChart({ run, tasks }: { run: BoardRun; tasks: BoardTask[] }): JSX.Element {
  const layout = useMemo(() => {
    // Longest-path ranking: tasks with no blockers sit in wave 0.
    const rankOf = new Map<string, number>()
    const rank = (id: string, seen: string[] = []): number => {
      const cached = rankOf.get(id)
      if (cached !== undefined) return cached
      if (seen.includes(id)) return 0
      const t = tasks.find((x) => x.id === id)
      if (t === undefined) return 0
      const blockers = t.blockedBy ?? []
      const r = blockers.length === 0 ? 0 : Math.max(...blockers.map((b) => rank(b, [...seen, id]) + 1))
      rankOf.set(id, r)
      return r
    }
    for (const t of tasks) rank(t.id)

    const byRank = new Map<number, BoardTask[]>()
    for (const t of tasks) {
      const r = rankOf.get(t.id) ?? 0
      if (!byRank.has(r)) byRank.set(r, [])
      byRank.get(r)!.push(t)
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b)

    // Uniform heights — deterministic, boxes never overlap
    const positions = new Map<string, { x: number; y: number; rank: number; lane: number }>()
    const rowStride = NODE_H + GAP_Y
    const schedBottom = SCHEDULER_H + GAP_Y
    for (const r of ranks) {
      const row = byRank.get(r)!
      row.forEach((task, lane) => {
        positions.set(task.id, {
          x: CANVAS_PAD + lane * (NODE_W + GAP_X),
          y: schedBottom + r * rowStride,
          rank: r,
          lane,
        })
      })
    }

    const maxLanes = Math.max(1, ...ranks.map((r) => byRank.get(r)?.length ?? 1))
    const width = CANVAS_PAD * 2 + maxLanes * NODE_W + (maxLanes - 1) * GAP_X
    const reportY = schedBottom + ranks.length * rowStride
    const height = reportY + REPORT_H + CANVAS_PAD
    return { positions, ranks, byRank, width, height, reportY, rowStride, schedBottom }
  }, [tasks])

  // Fit-to-pane scaling
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const update = (): void => {
      setScale(Math.min(1, Math.max(0.3, el.clientWidth / layout.width)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [layout.width])

  const sinks = tasks.filter((t) => !tasks.some((other) => (other.blockedBy ?? []).includes(t.id)))
  const schedulerX = layout.width / 2 - NODE_W / 2

  // S-curve edge: from bottom-center of source to top-center of target
  const edgePath = (sx: number, sy: number, tx: number, ty: number): string => {
    const c1y = sy + (ty - sy) * 0.4
    const c2y = sy + (ty - sy) * 0.6
    return `M ${sx} ${sy} C ${sx} ${c1y}, ${tx} ${c2y}, ${tx} ${ty}`
  }

  // Anchor helpers: bottom-center and top-center of a node
  const bottomCx = (x: number): number => x + NODE_W / 2
  const topCx = (x: number): number => x + NODE_W / 2

  const schedulerStatus = run.status === 'planning' ? 'awaiting endorsement' : run.status

  return (
    <div className="dsh-swarm-flow">
      <div className="dsh-swarm-flow-legend">
        <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('completed') }} /> done</span>
        <span><span className="dsh-swarm-tvc-dot live" style={{ background: statusColor('running') }} /> running</span>
        <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('reviewing') }} /> review</span>
        <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('failed') }} /> failed</span>
        <span><span className="dsh-swarm-tvc-dot" style={{ background: 'rgba(125, 125, 125, 0.6)' }} /> queued</span>
      </div>
      <div ref={wrapRef} className="dsh-swarm-flow-fit" style={{ height: Math.round(layout.height * scale) }}>
        <div
          className="dsh-swarm-flow-canvas"
          style={{
            width: layout.width,
            height: layout.height,
            margin: '0 auto',
            transform: `scale(${scale})`,
            transformOrigin: 'top center',
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
                    layout.width / 2, SCHEDULER_H,
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
                    layout.width / 2, layout.reportY,
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
            style={{ left: schedulerX, top: 0, width: NODE_W, height: SCHEDULER_H, zIndex: 1 }}
          >
            <div className="dsh-swarm-flow-node-title">⌘ scheduler</div>
            <div className="dsh-swarm-flow-node-sub">{schedulerStatus}</div>
          </div>

          {/* wave labels (between rows, in the gap) */}
          {layout.ranks.map((r) => {
            const row = layout.byRank.get(r) ?? []
            const parallel = row.length > 1
            const labelY = layout.schedBottom + r * layout.rowStride - GAP_Y / 2 - 8
            return (
              <div
                key={`wave-${r}`}
                className="dsh-swarm-flow-wave"
                style={{ left: layout.width / 2, top: labelY, transform: 'translateX(-50%)', zIndex: 1 }}
              >
                wave {r + 1}{parallel ? ` · ${row.length} parallel` : ''}
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
            return (
              <div
                key={task.id}
                className="dsh-swarm-flow-node"
                style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H, borderColor: color, zIndex: 1 }}
                title={`${task.subject}${(task.writes ?? []).length > 0 ? `\nwrites: ${(task.writes ?? []).join(', ')}` : ''}`}
              >
                <div className="dsh-swarm-flow-node-title">
                  <span className="dsh-swarm-flow-dot" style={{ background: color }} />
                  <code>{task.id}</code>
                  <span className="dsh-swarm-flow-role">{task.role}</span>
                </div>
                <div className="dsh-swarm-flow-node-sub">{phaseLabel(task)}</div>
                {writeHint !== '' && <div className="dsh-swarm-flow-node-writes">{writeHint}</div>}
              </div>
            )
          })}

          {/* report node */}
          <div
            className="dsh-swarm-flow-node report"
            style={{ left: layout.width / 2 - NODE_W / 2, top: layout.reportY, width: NODE_W, height: REPORT_H, zIndex: 1 }}
          >
            <div className="dsh-swarm-flow-node-title">📄 run report</div>
            <div className="dsh-swarm-flow-node-sub">{run.status === 'completed' ? 'generated' : run.status === 'failed' ? 'failed' : 'on completion'}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
