// Flow view: the run's task DAG as a top-down flow chart — scheduler node,
// parallel waves (same rank = runs in parallel), dependency arrows, reviewer
// chips, live status colors. Pure client-side layout over the board snapshot;
// no graph libraries, no host changes.
import { useMemo } from 'react'
import type { BoardRun, BoardTask } from './board-store'

const NODE_W = 210
const NODE_H = 64
const GAP_X = 28
const GAP_Y = 46

interface LaidOut {
  id: string
  x: number
  y: number
  rank: number
  lane: number
}

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
    case 'reviewing': return task.humanReview === true ? 'awaiting human review' : `review · ${task.reviewBy ?? ''}`
    case 'running': return 'running'
    case 'dispatching': return 'dispatching'
    case 'retrying': return `retrying (attempt ${task.attempts + 1})`
    case 'failed': return 'failed'
    case 'blocked': return task.blockedReason ?? 'blocked'
    default: return (task.blockedBy ?? []).length > 0 ? 'waiting on blockers' : 'queued'
  }
}

export function FlowChart({ run, tasks }: { run: BoardRun; tasks: BoardTask[] }): JSX.Element {
  const layout = useMemo(() => {
    // Longest-path ranking: tasks with no blockers sit in wave 0, a task's wave
    // is one past its deepest blocker. Same wave = runs in parallel.
    const rankOf = new Map<string, number>()
    const rank = (id: string, seen: string[] = []): number => {
      const cached = rankOf.get(id)
      if (cached !== undefined) return cached
      if (seen.includes(id)) return 0 // cycle guard (validated at dispatch anyway)
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
    const positioned: Array<{ task: BoardTask; x: number; y: number; rank: number; lane: number }> = []
    for (const r of ranks) {
      const row = byRank.get(r)!
      row.forEach((task, lane) => {
        positioned.push({ task, x: lane * (NODE_W + GAP_X), y: (r + 1) * (NODE_H + GAP_Y), rank: r, lane })
      })
    }
    const maxLane = Math.max(0, ...ranks.map((r) => (byRank.get(r)?.length ?? 1) - 1))
    const width = (maxLane + 1) * (NODE_W + GAP_X)
    const height = (ranks.length + 1) * (NODE_H + GAP_Y) + 40
    return { positioned, ranks, byRank, width, height }
  }, [tasks])

  const centerY = (rank: number): number => rank * (NODE_H + GAP_Y) + (NODE_H + GAP_Y) / 2
  const schedulerY = centerY(0) - (NODE_H + GAP_Y) / 2
  const schedulerX = layout.width / 2 - NODE_W / 2
  const reportY = layout.height - 46
  const sinks = tasks.filter((t) => !tasks.some((other) => (other.blockedBy ?? []).includes(t.id)))

  const edgePath = (fromX: number, fromY: number, toX: number, toY: number): string => {
    const midY = (fromY + toY) / 2
    return `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`
  }

  const schedulerStatus = run.status === 'planning' ? 'awaiting endorsement' : run.status

  return (
    <div className="dsh-swarm-flow">
      <div className="dsh-swarm-flow-legend">
        <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('completed') }} /> done</span>
        <span><span className="dsh-swarm-tvc-dot live" style={{ background: statusColor('running') }} /> running (parallel within a wave)</span>
        <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('reviewing') }} /> review</span>
        <span><span className="dsh-swarm-tvc-dot" style={{ background: statusColor('failed') }} /> failed / blocked</span>
        <span><span className="dsh-swarm-tvc-dot" style={{ background: 'rgba(125, 125, 125, 0.6)' }} /> queued</span>
      </div>
      <div className="dsh-swarm-flow-canvas" style={{ width: layout.width + 32, height: layout.height + 20 }}>
        {/* scheduler node */}
        <div
          className="dsh-swarm-flow-node scheduler"
          style={{ left: schedulerX + 16, top: schedulerY }}
        >
          <div className="dsh-swarm-flow-node-title">⌘ scheduler</div>
          <div className="dsh-swarm-flow-node-sub">{schedulerStatus}</div>
        </div>
        {/* waves + task nodes */}
        {layout.ranks.map((r) => {
          const row = layout.byRank.get(r) ?? []
          const parallel = row.length > 1
          return (
            <div
              key={`wave-${r}`}
              className="dsh-swarm-flow-wave"
              style={{ left: 0, top: centerY(r + 1) - 12, width: layout.width + 32 }}
            >
              wave {r + 1}{parallel ? ` — ${row.length} in parallel` : ''}
            </div>
          )
        })}
        {layout.positioned.map(({ task, x, y }) => {
          const color = statusColor(task.status)
          return (
            <div
              key={task.id}
              className="dsh-swarm-flow-node"
              style={{ left: x + 16, top: y, borderColor: color }}
              title={task.description}
            >
              <div className="dsh-swarm-flow-node-title">
                <span className="dsh-swarm-flow-dot" style={{ background: color }} />
                <code>{task.id}</code>
                <span className="dsh-swarm-flow-role">{task.role}</span>
              </div>
              <div className="dsh-swarm-flow-node-sub">{phaseLabel(task)}</div>
              {(task.writes ?? []).length > 0 && (
                <div className="dsh-swarm-flow-node-writes">✎ {(task.writes ?? []).join(', ')}</div>
              )}
            </div>
          )
        })}
        {/* report node */}
        <div className="dsh-swarm-flow-node report" style={{ left: layout.width / 2 - NODE_W / 2 + 16, top: reportY }}>
          <div className="dsh-swarm-flow-node-title">📄 run report</div>
          <div className="dsh-swarm-flow-node-sub">{run.status === 'completed' ? 'generated' : run.status === 'failed' ? 'failed run' : 'on completion'}</div>
        </div>
        {/* edges */}
        <svg className="dsh-swarm-flow-edges" width={layout.width + 32} height={layout.height + 20}>
          <defs>
            <marker id="dsh-swarm-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(125, 125, 125, 0.8)" />
            </marker>
          </defs>
          {/* scheduler → wave-0 tasks */}
          {(layout.byRank.get(0) ?? []).map((t) => {
            const node = layout.positioned.find((p) => p.task.id === t.id)!
            return (
              <path
                key={`s-${t.id}`}
                d={edgePath(layout.width / 2 + 16, schedulerY + NODE_H, node.x + 16 + NODE_W / 2, node.y)}
                className="dsh-swarm-flow-edge"
                markerEnd="url(#dsh-swarm-arrow)"
              />
            )
          })}
          {/* dependency edges */}
          {tasks.map((t) => (t.blockedBy ?? []).map((b) => {
            const from = layout.positioned.find((p) => p.task.id === b)
            const to = layout.positioned.find((p) => p.task.id === t.id)
            if (from === undefined || to === undefined) return null
            const done = tasks.find((x) => x.id === b)?.status === 'completed'
            return (
              <path
                key={`${b}-${t.id}`}
                d={edgePath(from.x + 16 + NODE_W / 2, from.y + NODE_H, to.x + 16 + NODE_W / 2, to.y)}
                className={done ? 'dsh-swarm-flow-edge done' : 'dsh-swarm-flow-edge'}
                markerEnd="url(#dsh-swarm-arrow)"
              />
            )
          }))}
          {/* sinks → report */}
          {sinks.map((t) => {
            const node = layout.positioned.find((p) => p.task.id === t.id)
            if (node === undefined) return null
            return (
              <path
                key={`r-${t.id}`}
                d={edgePath(node.x + 16 + NODE_W / 2, node.y + NODE_H, layout.width / 2 + 16, reportY)}
                className={t.status === 'completed' ? 'dsh-swarm-flow-edge done' : 'dsh-swarm-flow-edge'}
                markerEnd="url(#dsh-swarm-arrow)"
              />
            )
          })}
        </svg>
      </div>
    </div>
  )
}
