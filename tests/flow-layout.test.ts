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
    expect(css).toMatch(/\.dsh-swarm-flow-main\s*\{[^}]*flex\s*:/)
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
