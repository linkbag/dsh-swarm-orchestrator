import { describe, expect, it } from 'vitest'
import { fold, isReady, newState, runningCount } from '../src/domain/projection.js'
import type { TaskSpec } from '../src/domain/types.js'

function created(tasks: TaskSpec[], at = 1): ReturnType<typeof newState> {
  const state = newState()
  const push = (kind: string, fields: Record<string, unknown>): void => {
    // minimal event application through the public fold: build events inline
    state as unknown as { events: unknown }
    void kind
    void fields
  }
  void push
  return state
}

describe('projection + dag', () => {
  it('folds run/created into pending tasks', async () => {
    const { fold: f } = await import('../src/domain/projection.js')
    const state = f([{ seq: 1, at: 1, kind: 'run/created', runId: 'r1', data: { title: 'demo', spec: 's', tasks: [
      { id: 'a', subject: 'A', description: '', role: 'builder' },
      { id: 'b', subject: 'B', description: '', role: 'builder', blockedBy: ['a'] },
    ] } }], newState())
    expect(state.runs.get('r1')?.status).toBe('planning')
    expect(state.tasks.get('r1/a')?.status).toBe('pending')
    expect(state.tasks.get('r1/b')?.status).toBe('pending')
    expect(isReady(state, state.tasks.get('r1/a')!)).toBe(true)
    expect(isReady(state, state.tasks.get('r1/b')!)).toBe(false)
  })

  it('completion unblocks dependents and completes the run', async () => {
    const { fold: f } = await import('../src/domain/projection.js')
    const base = [{ seq: 1, at: 1, kind: 'run/created', runId: 'r1', data: { title: 't', spec: 's', tasks: [
      { id: 'a', subject: 'A', description: '', role: 'builder' },
      { id: 'b', subject: 'B', description: '', role: 'builder', blockedBy: ['a'] },
    ] } }]
    let state = f([...base, { seq: 2, at: 2, kind: 'run/endorsed', runId: 'r1' }], newState())
    expect(state.runs.get('r1')?.status).toBe('running')
    state = f([...base,
      { seq: 2, at: 2, kind: 'run/endorsed', runId: 'r1' },
      { seq: 3, at: 3, kind: 'task/started', runId: 'r1', taskId: 'a', data: { label: 'swarm:a' } },
    ], newState())
    expect(state.tasks.get('r1/a')?.status).toBe('running')
    expect(state.tasks.get('r1/a')?.attempts).toBe(1)
    expect(runningCount(state, 'r1')).toBe(1)
    state = f([...base,
      { seq: 2, at: 2, kind: 'run/endorsed', runId: 'r1' },
      { seq: 3, at: 3, kind: 'task/started', runId: 'r1', taskId: 'a' },
      { seq: 4, at: 4, kind: 'task/completed', runId: 'r1', taskId: 'a', data: { summary: 'done' } },
    ], newState())
    expect(state.tasks.get('r1/a')?.status).toBe('completed')
    expect(isReady(state, state.tasks.get('r1/b')!)).toBe(true)
  })

  it('failed with retry=true requeues as retrying; retry=false is terminal', async () => {
    const { fold: f } = await import('../src/domain/projection.js')
    const base = [
      { seq: 1, at: 1, kind: 'run/created', runId: 'r1', data: { title: 't', spec: 's', tasks: [{ id: 'a', subject: 'A', description: '', role: 'builder' }] } },
      { seq: 2, at: 2, kind: 'run/endorsed', runId: 'r1' },
    ]
    const retried = f([...base, { seq: 3, at: 3, kind: 'task/failed', runId: 'r1', taskId: 'a', data: { retry: true, reason: 'boom' } }], newState())
    expect(retried.tasks.get('r1/a')?.status).toBe('retrying')
    expect(isReady(retried, retried.tasks.get('r1/a')!)).toBe(true)
    const terminal = f([...base, { seq: 3, at: 3, kind: 'task/failed', runId: 'r1', taskId: 'a', data: { retry: false, reason: 'boom' } }], newState())
    expect(terminal.tasks.get('r1/a')?.status).toBe('failed')
    expect(isReady(terminal, terminal.tasks.get('r1/a')!)).toBe(false)
  })

  it('heartbeat and model-fallback update notes and agent model', async () => {
    const { fold: f } = await import('../src/domain/projection.js')
    const state = f([
      { seq: 1, at: 1, kind: 'run/created', runId: 'r1', data: { title: 't', spec: 's', tasks: [{ id: 'a', subject: 'A', description: '', role: 'builder' }] } },
      { seq: 2, at: 2, kind: 'task/started', runId: 'r1', taskId: 'a', data: { label: 'swarm:a', provider: 'zai', model: 'glm-5.3' } },
      { seq: 3, at: 3, kind: 'task/heartbeat', runId: 'r1', taskId: 'a', data: { note: 'writing tests' } },
      { seq: 4, at: 4, kind: 'task/model-fallback', runId: 'r1', taskId: 'a', data: { provider: 'zai', model: 'glm-5.2' } },
    ], newState())
    expect(state.tasks.get('r1/a')?.lastNote).toBe('writing tests')
    expect(state.tasks.get('r1/a')?.agent?.model).toBe('glm-5.2')
    expect(state.runs.get('r1')?.stats?.fallbacks).toBe(1)
  })

  it('review loop: reject requeues with feedback, approve completes, exhaust caps', async () => {
    const { fold: f, isReady } = await import('../src/domain/projection.js')
    const base = [
      { seq: 1, at: 1, kind: 'run/created', runId: 'r1', data: { title: 't', spec: 's', tasks: [
        { id: 'a', subject: 'A', description: '', role: 'builder', reviewBy: 'reviewer' },
      ] } },
      { seq: 2, at: 2, kind: 'run/endorsed', runId: 'r1' },
      { seq: 3, at: 3, kind: 'task/started', runId: 'r1', taskId: 'a' },
      { seq: 4, at: 4, kind: 'task/completed', runId: 'r1', taskId: 'a', data: { summary: 'v1 done' } },
    ]
    // reject round 1 → back to pending with feedback
    let state = f([...base, { seq: 5, at: 5, kind: 'task/review-started', runId: 'r1', taskId: 'a' }], newState())
    expect(state.tasks.get('r1/a')?.status).toBe('reviewing')
    state = f([...base,
      { seq: 5, at: 5, kind: 'task/review-started', runId: 'r1', taskId: 'a' },
      { seq: 6, at: 6, kind: 'task/reviewed', runId: 'r1', taskId: 'a', data: { verdict: 'reject', reviews: 1, feedback: 'missing tests' } },
    ], newState())
    const rejected = state.tasks.get('r1/a')!
    expect(rejected.status).toBe('pending')
    expect(rejected.reviewFeedback).toBe('missing tests')
    expect(rejected.reviews).toBe(1)
    expect(isReady(state, rejected)).toBe(true)
    expect(state.runs.get('r1')?.stats?.reviewsRejected).toBe(1)
    // approve after rework → completed + reviewed
    state = f([...base,
      { seq: 5, at: 5, kind: 'task/review-started', runId: 'r1', taskId: 'a' },
      { seq: 6, at: 6, kind: 'task/reviewed', runId: 'r1', taskId: 'a', data: { verdict: 'reject', reviews: 1, feedback: 'missing tests' } },
      { seq: 7, at: 7, kind: 'task/started', runId: 'r1', taskId: 'a' },
      { seq: 8, at: 8, kind: 'task/completed', runId: 'r1', taskId: 'a', data: { summary: 'v2 with tests' } },
      { seq: 9, at: 9, kind: 'task/review-started', runId: 'r1', taskId: 'a' },
      { seq: 10, at: 10, kind: 'task/reviewed', runId: 'r1', taskId: 'a', data: { verdict: 'approve', feedback: 'good' } },
    ], newState())
    const approved = state.tasks.get('r1/a')!
    expect(approved.status).toBe('completed')
    expect(approved.reviewed).toBe(true)
    expect(approved.summary).toBe('v2 with tests')
    expect(state.runs.get('r1')?.stats?.reviewsPassed).toBe(1)
    // exhausted reject → completed with flag
    state = f([...base,
      { seq: 5, at: 5, kind: 'task/review-started', runId: 'r1', taskId: 'a' },
      { seq: 6, at: 6, kind: 'task/reviewed', runId: 'r1', taskId: 'a', data: { verdict: 'reject', reviews: 3, exhausted: true, feedback: 'still bad' } },
    ], newState())
    const exhausted = state.tasks.get('r1/a')!
    expect(exhausted.status).toBe('completed')
    expect(exhausted.reviewExhausted).toBe(true)
  })

  it('run/completed carries the report', async () => {
    const { fold: f } = await import('../src/domain/projection.js')
    const state = f([
      { seq: 1, at: 1, kind: 'run/created', runId: 'r1', data: { title: 't', spec: 's', tasks: [{ id: 'a', subject: 'A', description: '', role: 'builder' }] } },
      { seq: 2, at: 2, kind: 'run/endorsed', runId: 'r1' },
      { seq: 3, at: 3, kind: 'task/started', runId: 'r1', taskId: 'a' },
      { seq: 4, at: 4, kind: 'task/completed', runId: 'r1', taskId: 'a', data: { summary: 'shipped' } },
      { seq: 5, at: 5, kind: 'run/completed', runId: 'r1', data: { report: { completedAt: 5, durationMs: 4, taskCount: 1, byStatus: { completed: 1 }, stats: { fallbacks: 0, retries: 0, reviewsPassed: 0, reviewsRejected: 0 }, tasks: [{ id: 'a', role: 'builder', status: 'completed', summary: 'shipped' }] } } },
    ], newState())
    expect(state.runs.get('r1')?.status).toBe('completed')
    expect(state.runs.get('r1')?.report?.taskCount).toBe(1)
    expect(state.runs.get('r1')?.report?.tasks[0]?.summary).toBe('shipped')
  })
})

describe('dag validation', () => {
  it('rejects unknown blockers and cycles', async () => {
    const { validateDag } = await import('../src/domain/dag.js')
    const cyclic: TaskSpec[] = [
      { id: 'a', subject: 'A', description: '', role: 'builder', blockedBy: ['b'] },
      { id: 'b', subject: 'B', description: '', role: 'builder', blockedBy: ['a'] },
    ]
    const result = validateDag(cyclic)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/cycle/)
    const unknown = validateDag([{ id: 'a', subject: 'A', description: '', role: 'builder', blockedBy: ['ghost'] }])
    expect(unknown.valid).toBe(false)
    expect(unknown.errors.join(' ')).toMatch(/ghost/)
    const good = validateDag([
      { id: 'a', subject: 'A', description: '', role: 'builder' },
      { id: 'b', subject: 'B', description: '', role: 'reviewer', blockedBy: ['a'] },
    ])
    expect(good.valid).toBe(true)
  })
})

void created
