import { describe, expect, it } from 'vitest'
import { fold, isAccepted, isReady } from '../src/domain/projection.js'
import { DEFAULT_POLICY } from '../src/policy.js'
import type { SwarmEventRecord } from '../src/domain/types.js'

function history(modern: boolean): SwarmEventRecord[] {
  return [
    { seq: 1, at: 1000, kind: 'run/created', runId: 'r', data: { title: 'replay', spec: 'synthetic', tasks: [{ id: 'a', subject: 'A', description: '', role: 'builder', reviewGate: 'human' }, { id: 'b', subject: 'B', description: '', role: 'builder', blockedBy: ['a'] }], ...(modern ? { policy: { ...DEFAULT_POLICY, review: 'strict' } } : {}) } },
    { seq: 4, at: 1003, kind: 'run/endorsed', runId: 'r', data: {} },
    { seq: 5, at: 1004, kind: 'task/started', runId: 'r', taskId: 'a', data: { attemptId: 'att', attemptProtocol: 2 } },
    { seq: 6, at: 1005, kind: 'task/completed', runId: 'r', taskId: 'a', data: { attemptId: 'att', artifactState: 'valid', artifactDigest: 'a'.repeat(64) } },
  ]
}

describe('versioned policy replay', () => {
  it('preserves old advisory completion while new completion is pending even if its later review-start append is absent', () => {
    const old = fold(history(false)); const modern = fold(history(true))
    expect(old.tasks.get('r/a')?.acceptanceState).toBeUndefined()
    expect(isAccepted(old.tasks.get('r/a')!)).toBe(true)
    expect(isReady(old, old.tasks.get('r/b')!)).toBe(true)
    expect(modern.tasks.get('r/a')?.acceptanceState).toBe('pending')
    expect(isReady(modern, modern.tasks.get('r/b')!)).toBe(false)
  })

  it('consumes a human decision once; conflicting duplicate replay cannot change statistics, timestamps or rejection', () => {
    const events = history(true)
    events.push({ seq: 7, at: 1006, kind: 'task/review-started', runId: 'r', taskId: 'a', data: { attemptId: 'att', human: true } })
    const observed = { attemptId: 'att', reviewEpisode: 'review-7', artifactDigest: 'a'.repeat(64) }
    const decision: SwarmEventRecord = { seq: 8, at: 1007, kind: 'task/reviewed', runId: 'r', taskId: 'a', data: { source: 'operator', attemptId: 'att', observed, verdict: 'reject', reviews: 1 } }
    const once = fold([...events, decision])
    const duplicates = fold([...events, decision, { ...decision, seq: 9, at: 1008 }, { ...decision, seq: 10, at: 1009, data: { ...decision.data, verdict: 'approve' } }])
    expect(duplicates.tasks.get('r/a')).toEqual(once.tasks.get('r/a'))
    expect(duplicates.runs.get('r')?.stats).toEqual(once.runs.get('r')?.stats)
    expect(isReady(duplicates, duplicates.tasks.get('r/b')!)).toBe(false)
  })

  it('rejects stale same-attempt review episodes without changing task timestamps', () => {
    const events = history(true)
    events.push({ seq: 7, at: 1006, kind: 'task/review-started', runId: 'r', taskId: 'a', data: { attemptId: 'att', human: true } })
    const before = fold(events)
    const after = fold([...events, { seq: 8, at: 1007, kind: 'task/reviewed', runId: 'r', taskId: 'a', data: { source: 'operator', attemptId: 'att', observed: { attemptId: 'att', reviewEpisode: 'review-older', artifactDigest: 'a'.repeat(64) }, verdict: 'approve' } }])
    expect(after.tasks.get('r/a')).toEqual(before.tasks.get('r/a'))
  })
})
