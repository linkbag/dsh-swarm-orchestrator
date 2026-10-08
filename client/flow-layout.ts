import type { BoardTask } from './board-store'

export const FLOW_METRICS = {
  nodeWidth: 200,
  nodeHeight: 68,
  schedulerHeight: 48,
  reportHeight: 48,
  gapX: 40,
  gapY: 32,
  padding: 16,
} as const

export interface FlowLayout {
  positions: Map<string, { x: number; y: number; rank: number; lane: number }>
  ranks: number[]
  byRank: Map<number, BoardTask[]>
  width: number
  height: number
  reportY: number
  rowStride: number
  schedBottom: number
}

/** Every parallel wave starts at the same left padding. */
export function createFlowLayout(tasks: BoardTask[]): FlowLayout {
  const { nodeWidth, nodeHeight, schedulerHeight, reportHeight, gapX, gapY, padding } = FLOW_METRICS
  const rankOf = new Map<string, number>()
  const rank = (id: string, seen: string[] = []): number => {
    const cached = rankOf.get(id)
    if (cached !== undefined) return cached
    if (seen.includes(id)) return 0
    const task = tasks.find((candidate) => candidate.id === id)
    if (task === undefined) return 0
    const blockers = task.blockedBy ?? []
    const value = blockers.length === 0 ? 0 : Math.max(...blockers.map((blocker) => rank(blocker, [...seen, id]) + 1))
    rankOf.set(id, value)
    return value
  }
  for (const task of tasks) rank(task.id)

  const byRank = new Map<number, BoardTask[]>()
  for (const task of tasks) {
    const value = rankOf.get(task.id) ?? 0
    if (!byRank.has(value)) byRank.set(value, [])
    byRank.get(value)!.push(task)
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  const rowWidth = (lanes: number): number => lanes * nodeWidth + (lanes - 1) * gapX
  const maxLanes = Math.max(1, ...ranks.map((value) => byRank.get(value)?.length ?? 1))
  const width = padding * 2 + rowWidth(maxLanes)
  const positions: FlowLayout['positions'] = new Map()
  const rowStride = nodeHeight + gapY
  const schedBottom = schedulerHeight + gapY
  for (const value of ranks) {
    const row = byRank.get(value)!
    row.forEach((task, lane) => {
      positions.set(task.id, {
        x: padding + lane * (nodeWidth + gapX),
        y: schedBottom + value * rowStride,
        rank: value,
        lane,
      })
    })
  }
  const reportY = schedBottom + (ranks.length === 0 ? 0 : ranks[ranks.length - 1]! + 1) * rowStride
  const height = reportY + reportHeight + padding
  return { positions, ranks, byRank, width, height, reportY, rowStride, schedBottom }
}

/** Fit is an explicit overview; a hidden/unmeasured pane must not collapse it. */
export function flowFitScale(canvas: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(1, viewport.width / canvas.width, viewport.height / canvas.height)
}
