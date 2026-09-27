// Structural interaction tests for the Flow view. There is NO DOM harness in this
// repo and jsdom is not an installed dependency anywhere in the resolution graph,
// so a real dispatched click cannot be observed here — installing one to test this
// would be the tail wagging the dog. Instead the flow is rendered with
// react-dom/server and the markup is asserted: the task box must carry the click
// handler's button semantics, and decoration must not.
//
// What this catches: removing the wiring (no role/tabIndex/onClick semantics on
// task nodes), making decoration selectable, or losing the active state.
// What it CANNOT catch, stated plainly: that React actually invokes the handler on
// a real click — that needs a DOM and the operator's eye (or a future harness).
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlowChart } from '../client/FlowChart.js'
import type { BoardRun, BoardTask } from '../client/board-store.js'

const run = { id: 'run-1', status: 'running', title: 'R' } as unknown as BoardRun
const tasks = [
  { id: 't1', runId: 'run-1', subject: 'First', role: 'builder', status: 'running', attempts: 0, blockedBy: [] },
  { id: 't2', runId: 'run-1', subject: 'Second', role: 'reviewer', status: 'completed', attempts: 1, blockedBy: ['t1'] },
] as unknown as BoardTask[]

const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(FlowChart, { run, tasks, ...props } as never))

/**
 * The markup of exactly one node: from its class attribute up to the NEXT top-level
 * node's class attribute. Two traps this avoids, both of which produced a false
 * result while writing this file: a fixed-width window silently swallows the
 * following node, and a plain substring search for the node class stops at the
 * node's OWN children (`dsh-swarm-flow-node-title`), truncating the body before its
 * content. The sibling match therefore requires a quote or space after the class.
 */
function nodeBody(markup: string, marker: string): string {
  const at = markup.indexOf(marker)
  expect(at, `node ${marker} not found in markup`).toBeGreaterThan(-1)
  const rest = markup.slice(at + marker.length)
  const next = /class="dsh-swarm-flow-node[ "]/.exec(rest)
  return next === null ? markup.slice(at) : markup.slice(at, at + marker.length + next.index)
}

/** Just the opening tag of a node — every attribute lives there. */
function openingTag(markup: string, marker: string): string {
  const at = markup.indexOf(marker)
  expect(at, `node ${marker} not found in markup`).toBeGreaterThan(-1)
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1)
}

describe('flow view: task nodes are interactive, decoration is not', () => {
  it('task boxes carry button semantics when a selection handler is supplied', () => {
    const markup = render({ onSelectTask: () => {} })
    expect(markup.match(/role="button"/g) ?? []).toHaveLength(tasks.length)
    expect(openingTag(markup, 'dsh-swarm-flow-node clickable')).toContain('tabindex="0"')
    // each task node renders its own id, so a click can only resolve to that task
    expect(nodeBody(markup, 'dsh-swarm-flow-node clickable')).toContain('<code>t1</code>')
  })

  it('the scheduler node stays inert', () => {
    const markup = render({ onSelectTask: () => {} })
    const scheduler = nodeBody(markup, 'dsh-swarm-flow-node scheduler')
    expect(scheduler).toContain('scheduler')
    expect(scheduler).not.toContain('role="button"')
    expect(scheduler).not.toContain('tabindex')
    expect(scheduler).not.toContain('clickable')
  })

  it('the report node stays inert', () => {
    const markup = render({ onSelectTask: () => {} })
    const report = nodeBody(markup, 'dsh-swarm-flow-node report')
    expect(report).not.toContain('role="button"')
    expect(report).not.toContain('tabindex')
    expect(report).not.toContain('clickable')
  })

  it('with no handler the whole flow is inert (read-only rendering)', () => {
    const markup = render({})
    expect(markup).not.toContain('role="button"')
    expect(markup).not.toContain('clickable')
    expect(markup).not.toContain('tabindex')
  })

  it('the selected task is marked active and pressed, and only that one', () => {
    const markup = render({ onSelectTask: () => {}, selectedTaskId: 't2' })
    expect(markup.match(/aria-pressed="true"/g) ?? []).toHaveLength(1)
    expect(markup.match(/clickable active/g) ?? []).toHaveLength(1)
    expect(nodeBody(markup, 'dsh-swarm-flow-node clickable active')).toContain('<code>t2</code>')
    expect(markup).toContain('aria-pressed="false"')
  })
})
