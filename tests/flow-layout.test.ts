// The defects these pin, both reported from the live UI after 0.6.28:
//   1. The Flow canvas collapsed to a sliver — tiny, overlapping nodes at the far left.
//      Cause: 0.6.28 wrapped the canvas in `.dsh-swarm-main`, whose rule has no
//      flex-grow, so nothing gave that column a definite width; FlowChart's fit-to-pane
//      (ResizeObserver) measured the sliver and clamped the scale to its 0.3 floor.
//   2. An empty run drew a legend with no nodes — indistinguishable from a broken canvas.
//
// A DOM-less render cannot measure layout, so these tests pin the two things that
// actually decide it — the width-bearing class on the Flow arm, and the CSS rule that
// gives it flex — plus the empty state that makes a blank canvas impossible to misread.
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { createFlowLayout, flowFitScale, FLOW_METRICS } from '../client/flow-layout.js'
import { FlowChart } from '../client/FlowChart.js'
import type { BoardRun, BoardTask } from '../client/board-store.js'

// vi.hoisted so the fixtures exist before the (hoisted) module mock can reference them.
const F = vi.hoisted(() => {
  const run = {
    id: 'run-1', title: 'Flow layout run', status: 'running',
    createdAt: 1700000000000, cwd: 'D:/ws', spec: 's',
  }
  const task = {
    id: 't1', runId: 'run-1', subject: 'T1', status: 'completed', role: 'builder',
    description: 'd', attempts: 1, updatedAt: 1700000000000, writes: [], blockedBy: [], reviews: 0,
  }
  return {
    run, task,
    board: { version: '0.6.29', seq: 1, runs: [run], tasks: [task], removedRuns: [] },
    emptyBoard: { version: '0.6.29', seq: 1, runs: [run], tasks: [], removedRuns: [] },
  }
})

vi.mock('../client/board-store.js', () => ({
  boardStore: () => ({
    get: () => F.board,
    retain: () => () => {},
    subscribe: () => () => {},
    action: async () => ({ ok: true }),
  }),
}))

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} } as never

const { SwarmTab } = await import('../client/SwarmTab.js')
const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(SwarmTab as never, props as never))

describe('the flow arm is a real column and never draws a blank canvas', () => {
  it('Flow: <main> carries the width-bearing flow class alongside the shared one', () => {
    const html = render({ initialBoard: F.board, initialView: 'flow' })
    // What it catches: dropping dsh-swarm-flow-main (the 0.6.28 collapse) or renaming
    // either class. The board legitimately shares dsh-swarm-main, so both must be there.
    expect(html).toContain('dsh-swarm-main dsh-swarm-flow-main')
  })

  it('the stylesheet still gives that class a flex rule', () => {
    // What it catches: deleting or renaming the CSS the fix depends on. The class test
    // above would still pass with the rule gone, and the canvas would silently collapse
    // again — so CSS a fix depends on is worth pinning by reading the file.
    const css = readFileSync(new URL('../client/swarm.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.dsh-swarm-body\.dsh-swarm-flow-body\s*\{[^}]*grid-template-columns:\s*1fr auto/)
    expect(css).toMatch(/\.dsh-swarm-drawer\s*\{[^}]*width:\s*320px/)
  })

  it('Flow with no tasks explains itself instead of drawing an empty canvas', () => {
    const html = render({ initialBoard: F.emptyBoard, initialView: 'flow' })
    // What it catches: an empty run rendering the legend with no nodes — the reported
    // "blank flow tab", which reads as a broken canvas rather than an empty run.
    expect(html).toContain('dsh-swarm-placeholder')
    expect(html).not.toContain('dsh-swarm-flow-legend')
  })

  it('Flow with tasks draws the canvas and no empty state', () => {
    const html = render({ initialBoard: F.board, initialView: 'flow' })
    // What it catches: an over-eager empty state hiding a run that does have tasks.
    expect(html).toContain('dsh-swarm-flow-legend')
    expect(html).not.toContain('dsh-swarm-placeholder')
  })
})

const task = (id: string, blockedBy: string[] = []): BoardTask => ({
  id, runId: 'run-1', subject: id, description: id, blockedBy,
  role: 'builder', status: 'running', attempts: 0, updatedAt: 1,
})
const wideTasks = (): BoardTask[] => {
  const roots = Array.from({ length: 17 }, (_, index) => task(`audit-${index + 1}`))
  return [
    ...roots,
    task('select-product', roots.map((candidate) => candidate.id)),
    task('build-prototype', ['select-product']),
    task('product-plan', ['select-product']),
    task('verify-prototype', ['build-prototype']),
    task('verify-benchmarks', ['build-prototype', 'product-plan']),
    task('integrate-delivery', ['verify-prototype', 'verify-benchmarks']),
  ]
}

describe('wide Flow charts stay readable and left-aligned', () => {
  it('starts every wave at the same left padding, including narrow downstream waves', () => {
    const layout = createFlowLayout(wideTasks())
    expect(layout.width).toBe(4072)
    for (const row of layout.byRank.values()) {
      const left = layout.positions.get(row[0]!.id)!.x
      const right = layout.positions.get(row[row.length - 1]!.id)!.x + FLOW_METRICS.nodeWidth
      expect(left).toBe(FLOW_METRICS.padding)
      expect(right).toBeLessThanOrEqual(layout.width - FLOW_METRICS.padding)
    }
    expect(layout.positions.get('select-product')!.x).toBe(16)
    expect(layout.positions.get('integrate-delivery')!.x).toBe(16)
  })

  it('keeps native-size nodes separate and dependency waves below their blockers', () => {
    const tasks = wideTasks()
    const layout = createFlowLayout(tasks)
    for (const row of layout.byRank.values()) {
      for (let index = 1; index < row.length; index++) {
        const previous = layout.positions.get(row[index - 1]!.id)!
        const current = layout.positions.get(row[index]!.id)!
        expect(current.x - previous.x).toBe(FLOW_METRICS.nodeWidth + FLOW_METRICS.gapX)
      }
    }
    for (const candidate of tasks) {
      const position = layout.positions.get(candidate.id)!
      for (const blocker of candidate.blockedBy ?? []) {
        expect(position.y).toBeGreaterThan(layout.positions.get(blocker)!.y + FLOW_METRICS.nodeHeight)
      }
      expect(layout.reportY).toBeGreaterThan(position.y + FLOW_METRICS.nodeHeight)
    }
  })

  it('puts the report below a task even if an incomplete snapshot omits its blocker', () => {
    const layout = createFlowLayout([task('dependent', ['missing'])])
    expect(layout.reportY).toBeGreaterThan(layout.positions.get('dependent')!.y + FLOW_METRICS.nodeHeight)
  })

  it('does not mutate the board snapshot', () => {
    const tasks = wideTasks()
    const before = JSON.stringify(tasks)
    createFlowLayout(tasks)
    expect(JSON.stringify(tasks)).toBe(before)
  })

  it('Fit measures both axes and never upscales a small chart', () => {
    expect(flowFitScale({ width: 4072, height: 644 }, { width: 2100, height: 875 })).toBeCloseTo(2100 / 4072)
    expect(flowFitScale({ width: 232, height: 1644 }, { width: 900, height: 500 })).toBeCloseTo(500 / 1644)
    expect(flowFitScale({ width: 232, height: 244 }, { width: 2100, height: 875 })).toBe(1)
  })

  it.each([{ width: 0, height: 500 }, { width: 900, height: 0 }])('does not shrink a hidden or unmeasured pane: %j', (viewport) => {
    expect(flowFitScale({ width: 4072, height: 644 }, viewport)).toBe(1)
  })

  it('starts a 17-wide run at readable 100%, with explicit zoom and Fit controls', () => {
    const tasks = wideTasks()
    const run: BoardRun = { id: 'run-1', title: 'Wide run', spec: '', status: 'running', createdAt: 1, updatedAt: 1, taskIds: tasks.map((candidate) => candidate.id) }
    const html = renderToStaticMarkup(createElement(FlowChart, { run, tasks }))
    expect(html).toContain('transform:scale(1);transform-origin:top left')
    expect(html).toContain('class="dsh-swarm-flow-scaled" style="width:4072px;height:644px"')
    expect(html).toContain('aria-label="Zoom in"')
    expect(html).toContain('aria-label="Zoom out"')
    expect(html).toContain('>100%</button>')
    expect(html).toContain('>Fit</button>')
    expect(html).not.toContain('transform-origin:top center')
  })

  it('left-aligns the scheduler, wave labels and report, with edges attached to their centers', () => {
    const tasks = wideTasks()
    const layout = createFlowLayout(tasks)
    const run: BoardRun = { ...F.run, updatedAt: F.run.createdAt, taskIds: tasks.map((task) => task.id) }
    const html = renderToStaticMarkup(createElement(FlowChart, { run, tasks }))
    const axis = FLOW_METRICS.padding + FLOW_METRICS.nodeWidth / 2
    expect(html).toContain(`class="dsh-swarm-flow-node scheduler" style="left:${FLOW_METRICS.padding}px;top:0;`)
    expect(html).toContain(`class="dsh-swarm-flow-node report" style="left:${FLOW_METRICS.padding}px;top:${layout.reportY}px;`)
    expect(html.match(/class="dsh-swarm-flow-wave" style="left:16px;/g)).toHaveLength(layout.ranks.length)
    expect(html).toContain(`d="M ${axis} ${FLOW_METRICS.schedulerHeight} C`)
    expect(html).toContain(`, ${axis} ${layout.reportY}"`)
  })

  it('left-aligns and clips only the scaled footprint; controls do not scroll with the canvas', () => {
    const css = readFileSync(new URL('../client/swarm.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.dsh-swarm-flow-viewport\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/)
    expect(css).toMatch(/\.dsh-swarm-flow-fit\s*\{[^}]*justify-content:\s*flex-start[^}]*align-items:\s*center[^}]*min-width:\s*100%[^}]*min-height:\s*100%/)
    expect(css).toMatch(/\.dsh-swarm-flow-scaled\s*\{[^}]*overflow:\s*hidden/)
    expect(css).toMatch(/\.dsh-swarm-flow-canvas\s*\{[^}]*position:\s*absolute/)
    expect(css).toMatch(/\.dsh-swarm-flow-toolbar\s*\{[^}]*flex:\s*none/)
    const source = readFileSync(new URL('../client/FlowChart.tsx', import.meta.url), 'utf8')
    expect(source).toContain('if (el !== null) el.scrollLeft = 0')
    expect(source).not.toContain('(el.scrollWidth - el.clientWidth) / 2')
  })
})
