// The Flow view's click/keyboard semantics, pinned as a pure module.
//
// What each test would catch if the wiring regressed:
//  - "selects the clicked task": a node that stops resolving to its task (the
//    feature silently dying — boxes look clickable and do nothing).
//  - "never selects decoration": a refactor that gives the scheduler/report/wave
//    nodes a taskId, making decoration open a sidebar for the wrong thing.
//  - "refuses a foreign run": the sidebar mixing one run's task with another
//    run's context when the workspace/All scope shows a different run.
//  - the attribute tests: losing role/tabIndex/aria-pressed (kills keyboard
//    operability and screen-reader semantics) or marking inert nodes as buttons.
import { describe, expect, it } from 'vitest'
import { flowNodeAttributes, isActivationKey, resolveFlowSelection } from '../client/flow-select.js'
import type { BoardTask } from '../client/board-store.js'

const task = (id: string, runId = 'run-1'): BoardTask => ({ id, runId, subject: 'S' } as unknown as BoardTask)
const TASKS = [task('t1'), task('t2')]

describe('flow node selection', () => {
  it('selects the clicked task, carrying its run', () => {
    const got = resolveFlowSelection({ taskId: 't1' }, 'run-1', TASKS)
    expect(got).not.toBeNull()
    expect(got!.runId).toBe('run-1')
    expect(got!.taskId).toBe('t1')
    expect(got!.task.id).toBe('t1')
  })

  it('selects the second task independently (no id confusion)', () => {
    expect(resolveFlowSelection({ taskId: 't2' }, 'run-1', TASKS)!.taskId).toBe('t2')
  })

  it('never selects decoration — the scheduler, report and wave nodes carry no taskId', () => {
    for (const node of [{}, { taskId: null }, { taskId: undefined }, null, undefined]) {
      expect(resolveFlowSelection(node, 'run-1', TASKS)).toBeNull()
    }
  })

  it('never selects on a malformed taskId', () => {
    expect(resolveFlowSelection({ taskId: 42 as never }, 'run-1', TASKS)).toBeNull()
    expect(resolveFlowSelection({ taskId: '' }, 'run-1', TASKS)).toBeNull()
    expect(resolveFlowSelection({ taskId: '   ' }, 'run-1', TASKS)).toBeNull()
  })

  it('refuses a task that is not in the rendered run', () => {
    expect(resolveFlowSelection({ taskId: 'nope' }, 'run-1', TASKS)).toBeNull()
  })

  it('refuses when the task belongs to a different run (sidebar must not mix contexts)', () => {
    const foreign = [task('t1', 'run-2')]
    expect(resolveFlowSelection({ taskId: 't1' }, 'run-1', foreign)).toBeNull()
  })

  it('falls back to the rendered run when the task carries no runId', () => {
    const bare = [{ id: 't1' } as unknown as BoardTask]
    expect(resolveFlowSelection({ taskId: 't1' }, 'run-1', bare)!.runId).toBe('run-1')
  })

  it('degrades to no selection on a malformed board, never throws', () => {
    expect(resolveFlowSelection({ taskId: 't1' }, 'run-1', null)).toBeNull()
    expect(resolveFlowSelection({ taskId: 't1' }, 'run-1', undefined)).toBeNull()
    expect(resolveFlowSelection({ taskId: 't1' }, 'run-1', {} as never)).toBeNull()
    expect(resolveFlowSelection({ taskId: 't1' }, null, TASKS)).toBeNull()
    expect(resolveFlowSelection({ taskId: 't1' }, '', TASKS)).toBeNull()
    expect(resolveFlowSelection({ taskId: 't1' }, undefined, TASKS)).toBeNull()
    expect(resolveFlowSelection({ taskId: 't1' }, 'run-1', [null as never])).toBeNull()
  })
})

describe('flow node attributes', () => {
  it('interactive task node: button role, tab stop, unpressed', () => {
    expect(flowNodeAttributes(true, false)).toEqual({
      className: 'dsh-swarm-flow-node clickable',
      role: 'button',
      tabIndex: 0,
      'aria-pressed': false,
    })
  })

  it('selected task node: active class and pressed state', () => {
    expect(flowNodeAttributes(true, true)).toEqual({
      className: 'dsh-swarm-flow-node clickable active',
      role: 'button',
      tabIndex: 0,
      'aria-pressed': true,
    })
  })

  it('inert node: no role, no tab stop, no ARIA state — never announced as a button', () => {
    expect(flowNodeAttributes(false, true)).toEqual({
      className: 'dsh-swarm-flow-node',
      role: undefined,
      tabIndex: undefined,
      'aria-pressed': undefined,
    })
  })

  it('honours a custom base class (scheduler/report reuse it inertly)', () => {
    expect(flowNodeAttributes(false, false, 'dsh-swarm-flow-node scheduler').className).toBe('dsh-swarm-flow-node scheduler')
  })
})

describe('keyboard activation', () => {
  it('Enter and Space activate; other keys do not', () => {
    expect(isActivationKey('Enter')).toBe(true)
    expect(isActivationKey(' ')).toBe(true)
    expect(isActivationKey('Spacebar')).toBe(true)
    for (const key of ['Escape', 'Tab', 'a', 'ArrowDown', 'Shift']) expect(isActivationKey(key)).toBe(false)
  })
})
