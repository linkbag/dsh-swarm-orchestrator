/**
 * Repro: the "host restarted mid-flight" zombie loop.
 *
 * Production evidence (C:\Users\tsing\.dsh\storages\swarm\events.jsonl):
 *   run-mtvrocbe-tns8 was ABORTED at 2026-09-10T18:43:11Z.
 *   Its task `vhp-cryo-embed` still received 13 `task/failed`
 *   {retry:true, reason:"host restarted mid-flight"} events, the last at
 *   2026-09-11T16:53:39Z — 21 hours after the run was aborted.
 *
 * Mechanism under test: `SwarmService.recoverOrphans()` (src/service.ts)
 * iterates `fold(...)` and re-fails every task in state
 * running|dispatching|reviewing, WITHOUT the terminal-run guard that the
 * projection itself applies (projection.ts J5). So:
 *   - fold() refuses to move the task (run is aborted) => status stays running
 *   - recoverOrphans() sees `running` on the next host boot => fails it again
 * Every restart appends one more ghost failure; the task never reaches a
 * terminal state and is never actually retried.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fold, newState } from '../src/domain/projection.js'
import type { SwarmEventRecord } from '../src/domain/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function ev(seq: number, at: number, kind: string, runId: string, taskId?: string, data?: Record<string, unknown>): SwarmEventRecord {
  return { seq, at, kind, runId, ...(taskId !== undefined ? { taskId } : {}), ...(data !== undefined ? { data } : {}) } as SwarmEventRecord
}

/** The real event shape for run-mtvrocbe-tns8 / vhp-cryo-embed, timestamps in ms. */
function zombieLog(failures: number, aborted: boolean): SwarmEventRecord[] {
  const t0 = Date.parse('2026-09-10T16:53:54Z')
  const events: SwarmEventRecord[] = [
    ev(1, t0, 'run/created', 'run-z', undefined, {
      title: 'NeuroAxis v4b',
      spec: 's',
      tasks: [{ id: 'vhp-cryo-embed', subject: 'E', description: 'd', role: 'builder' }],
    }),
    ev(2, t0, 'run/endorsed', 'run-z'),
    ev(3, t0 + 1, 'task/started', 'run-z', 'vhp-cryo-embed', { label: 'swarm:vhp-cryo-embed' }),
    ev(4, t0 + 1, 'task/agent-started', 'run-z', 'vhp-cryo-embed', { sessionId: 'sess-1' }),
    ev(5, t0 + 90000, 'task/heartbeat', 'run-z', 'vhp-cryo-embed', { note: 'progress' }),
  ]
  if (aborted) events.push(ev(6, Date.parse('2026-09-10T18:43:11Z'), 'run/aborted', 'run-z'))
  // The 13 restart-induced failures, all AFTER the abort in production.
  for (let i = 0; i < failures; i++) {
    events.push(ev(10 + i, Date.parse('2026-09-10T19:25:28Z') + i * 3600_000, 'task/failed', 'run-z', 'vhp-cryo-embed', {
      retry: true, reason: 'host restarted mid-flight',
    }))
  }
  return events
}

describe('repro: host-restart zombie loop', () => {
  it('the projection REFUSES to move a task whose run is terminal (J5 guard)', () => {
    const state = fold(zombieLog(13, true))
    // The guard held: the append site lost the race with the projection.
    expect(state.runs.get('run-z')?.status).toBe('aborted')
    expect(state.tasks.get('run-z/vhp-cryo-embed')?.status).toBe('running')
    expect(state.tasks.get('run-z/vhp-cryo-embed')?.attempts).toBe(1)
  })

  it('without the abort, the same 13 failures DO move the task', () => {
    // Control: proves the difference is the terminal-run guard, not the payload shape.
    const state = fold(zombieLog(1, false))
    expect(state.runs.get('run-z')?.status).toBe('running')
    expect(state.tasks.get('run-z/vhp-cryo-embed')?.status).toBe('retrying')
  })

  it('the task is stuck in `running` forever — recoverOrphans re-fails it on every boot', () => {
    const state = fold(zombieLog(13, true))
    const task = state.tasks.get('run-z/vhp-cryo-embed')
    // This is the predicate recoverOrphans() tests. If it stays true across
    // restarts, each boot appends another ghost failure. QED.
    const matchesRecoverOrphansPredicate =
      task !== undefined && ['running', 'dispatching', 'reviewing'].includes(task.status)
    expect(matchesRecoverOrphansPredicate).toBe(true)
    // And the retry cap can never engage, because attempts never advances.
    expect(task?.attempts).toBeLessThan(2)
  })

  it('recoverOrphans() carries the same terminal-run guard as the projection (J6)', () => {
    // Read the real source to pin the invariant by its actual text.
    const svc = readFileSync(join(HERE, '..', 'src', 'service.ts'), 'utf8')
    const proj = readFileSync(join(HERE, '..', 'src', 'domain', 'projection.ts'), 'utf8')

    const at = svc.indexOf('private recoverOrphans()')
    expect(at).toBeGreaterThan(-1)
    const recoverBody = svc.slice(at, at + 1400)
    // Still selects the orphan candidates…
    expect(recoverBody).toContain("task.status !== 'running'")
    // …but must now skip any task whose owning run is not running.
    expect(recoverBody).toMatch(/const\s+run\s*=\s*state\.runs\.get\(task\.runId\)/)
    expect(recoverBody).toMatch(/run\?\.status\s*!==\s*'running'/)

    // The projection guard is what makes the unguarded version loop forever.
    expect(proj).toMatch(/ownerRun\.status === 'aborted' \|\| ownerRun\.status === 'completed' \|\| ownerRun\.status === 'failed' \|\| ownerRun\.status === 'paused'/)
  })
})
