// The defect this pins: clicking a flow-chart box highlighted the task (so the wiring
// worked) but NO drawer appeared, because the drawer was rendered inside the board
// branch of the tab ternary. The 0.6.27 tests rendered `FlowChart` in isolation, which
// by construction could not catch that — the missing assertion was "the DRAWER is in
// the markup when the Flow tab is showing".
//
// A DOM-less render answers exactly that question, so no jsdom is needed: the drawer's
// presence and its position relative to the flow canvas are both visible in the markup.
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// vi.hoisted so the fixture exists before the (hoisted) module mock can reference it.
const F = vi.hoisted(() => {
  const run = {
    id: 'run-1', title: 'Flow drawer run', status: 'running',
    createdAt: 1700000000000, cwd: 'D:/ws', spec: 's',
  }
  const task = {
    id: 'w3-verify', runId: 'run-1', subject: 'W3-verify: re-review the completed W3 state',
    status: 'completed', role: 'reviewer', description: 'brief text',
    attempts: 1, updatedAt: 1700000000000, writes: [], blockedBy: [], reviews: 0,
  }
  return { run, task, board: { version: '0.6.28', seq: 1, runs: [run], tasks: [task], removedRuns: [] } }
})

vi.mock('../client/board-store.js', () => ({
  boardStore: () => ({
    get: () => F.board,
    retain: () => () => {},
    subscribe: () => () => {},
    action: async () => ({ ok: true }),
  }),
}))

// SwarmTab reads this during its first render (workspace-scope default).
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} } as never

const { SwarmTab } = await import('../client/SwarmTab.js')
const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(SwarmTab as never, props as never))

describe('the task drawer opens from every tab', () => {
  it('Flow: a selected task renders the drawer, in the body, after the canvas', () => {
    const html = render({ initialBoard: F.board, initialView: 'flow', initialSelectedTask: F.task })
    // What it catches: re-nesting the drawer under the board branch (the 0.6.27 defect).
    expect(html).toContain('dsh-swarm-drawer')
    expect(html).toContain('W3-verify')
    // What it catches: the canvas losing the two-column body, so the drawer has no column.
    expect(html).toContain('dsh-swarm-body')
    const main = html.indexOf('dsh-swarm-main')
    const drawer = html.indexOf('dsh-swarm-drawer')
    expect(main).toBeGreaterThanOrEqual(0)
    expect(drawer).toBeGreaterThan(main)
  })

  it('Flow: with nothing selected there is no drawer', () => {
    const html = render({ initialBoard: F.board, initialView: 'flow' })
    expect(html).not.toContain('dsh-swarm-drawer')
    expect(html).toContain('dsh-swarm-body')
  })

  it('Board: a selected task still renders the drawer (guards the extraction)', () => {
    const html = render({ initialBoard: F.board, initialView: 'board', initialSelectedTask: F.task })
    expect(html).toContain('dsh-swarm-drawer')
    expect(html).toContain('dsh-swarm-runs')
  })
})
