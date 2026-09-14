// The bottom-right 🐝 pill is the one status surface a user sees without opening
// anything, so a wrong label there is a false alarm about their own work.
//
// It shipped wrong: the badge announced the newest run whose status was 'failed',
// not the newest run. The user reported "it says the last swarm run failed but it
// actually succeeded" while the board's newest run was `completed` and the failure
// it named was two runs old — permanently, until that run aged out of the 50-run
// window. These tests pin the corrected rule, starting with the exact board that
// produced the report.
import { describe, expect, it } from 'vitest'
import { badgeView } from '../client/badge.js'

/** The real live board at the time of the report: newest run completed, older ones failed. */
const REPORTED_BOARD = [
  { status: 'completed', createdAt: 1757841008000 }, // run-mu1razg5-4aps  (newest)
  { status: 'completed', createdAt: 1757836699000 }, // run-mu1o0wzc-mac1
  { status: 'failed', createdAt: 1757799696000 }, // run-mu0vkbou-391u  ← the badge named this
  { status: 'failed', createdAt: 1757794932000 }, // run-mu0sq7nm-tt1r
]

describe('global swarm badge label', () => {
  it('reports the newest run as completed even when older runs failed (the reported bug)', () => {
    const view = badgeView(REPORTED_BOARD)
    expect(view.text).toBe('🐝 last swarm run: completed')
    expect(view.text).not.toContain('failed')
    expect(view.alert).toBe(false)
  })

  it('is independent of array order', () => {
    // The board happens to be newest-first; the label must not depend on that.
    const shuffled = [REPORTED_BOARD[2], REPORTED_BOARD[0], REPORTED_BOARD[3], REPORTED_BOARD[1]]
    expect(badgeView(shuffled).text).toBe('🐝 last swarm run: completed')
  })

  it('flags the newest run as failed when the newest run really did fail', () => {
    const view = badgeView([
      { status: 'failed', createdAt: 300 },
      { status: 'completed', createdAt: 200 },
    ])
    expect(view.text).toBe('🐝 last swarm run: failed')
    expect(view.alert).toBe(true)
  })

  it('flags aborted as needing attention', () => {
    expect(badgeView([{ status: 'aborted', createdAt: 1 }])).toEqual({
      text: '🐝 last swarm run: aborted',
      alert: true,
    })
  })

  it('counts runs still in flight and takes precedence over past outcomes', () => {
    const view = badgeView([
      { status: 'completed', createdAt: 300 },
      { status: 'running', createdAt: 200 },
      { status: 'planning', createdAt: 100 },
    ])
    expect(view.text).toBe('🐝 2 swarm runs active')
    expect(view.alert).toBe(false)
  })

  it('describes a lone paused run as paused, not active', () => {
    expect(badgeView([{ status: 'paused', createdAt: 5 }])).toEqual({
      text: '🐝 1 swarm run paused',
      alert: true,
    })
  })

  it('prefers in-flight work over a paused run', () => {
    const view = badgeView([
      { status: 'paused', createdAt: 300 },
      { status: 'running', createdAt: 200 },
    ])
    expect(view.text).toBe('🐝 1 swarm run active')
    expect(view.alert).toBe(false)
  })

  it('reports a run waiting on a human instead of claiming the swarm is idle', () => {
    const view = badgeView([{ status: 'awaiting-endorsement', createdAt: 42 }])
    expect(view.text).toBe('🐝 1 swarm run awaiting endorsement')
    expect(view.alert).toBe(false)
  })

  it('hides the badge when there are no runs or no usable payload', () => {
    expect(badgeView([])).toEqual({ text: '', alert: false })
    expect(badgeView(undefined)).toEqual({ text: '', alert: false })
  })

  it('does not freeze on stale text when the board payload is malformed', () => {
    // An error payload ({error: …}) used to throw inside .then, so the rejection
    // left the previous label on screen indefinitely.
    expect(badgeView(null as never)).toEqual({ text: '', alert: false })
    expect(badgeView({} as never)).toEqual({ text: '', alert: false })
  })

  it('still labels runs whose createdAt is missing', () => {
    expect(badgeView([{ status: 'completed' }]).text).toBe('🐝 last swarm run: completed')
  })
})
