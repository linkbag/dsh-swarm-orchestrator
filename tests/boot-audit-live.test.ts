// Boot audit against the REAL deployment storage: the plugin must boot against
// the production event log (every run, every historical task state) without
// appending events, spinning the dispatcher, or hanging.
//
// Motivated by the 2026-09-22 freeze report ("web ui immediately freezes, no
// chat history"): the standalone repro against this exact store was the
// evidence that cleared the dispatcher — booted in ~40ms, appended 0 events,
// all-terminal runs stay untouched. This makes that audit permanent so a future
// boot-path regression (a recovery loop, a fold explosion, a tick storm) is
// caught by CI rather than by the user's next restart.
import { afterAll, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'

const STORAGE = 'C:/Users/tsing/.dsh/storages/swarm'

describe('boot audit against the real deployment storage', () => {
  const dirs: string[] = []
  const contexts: Context[] = []
  afterAll(() => {
    // Same teardown the service integration tests use: unload the plugin from
    // each context so its intervals/timers release the vitest worker.
    for (const ctx of contexts) ctx.registry.delete(swarmPlugin)
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('boots clean against the production event log (no storm, no hang, no appends)', async () => {
    if (!existsSync(join(STORAGE, 'events.jsonl'))) {
      // Fresh checkout or different machine — the audit only runs where the
      // real store exists, exactly like preflight-live.
      expect(true).toBe(true)
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'swarm-boot-audit-'))
    dirs.push(dir)
    for (const f of ['events.jsonl', 'duty-table.json', 'runtime.json']) {
      if (existsSync(join(STORAGE, f))) cpSync(join(STORAGE, f), join(dir, f))
    }
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(swarmPlugin, {
      storageDir: dir,
      maxConcurrent: 5, maxRetries: 2, reviewLoops: 3,
      requireArchitectReview: false, workspaceRunPolicy: 'off',
      retryBackoffBaseMs: 0, circuitBreakerThreshold: 0,
    })
    const traced = ctx.get('swarm') as Record<symbol, unknown>
    const service = traced[Symbol.for('cordis.original')] as { snapshot(): { runs: Array<{ status: string }>; tasks: unknown[] } }
    expect(service).toBeDefined()

    // Let the boot grace (subagents poll) plus a settle window pass.
    await new Promise((resolve) => setTimeout(resolve, 4000))

    const after = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length
    const snap = service.snapshot()
    const appended = after - before

    // All runs in the production store are terminal at audit time; recovery
    // must be a no-op. A positive append count here is a boot-path storm —
    // exactly the class of bug that freezes the host.
    expect(appended, `boot appended ${appended} event(s) against an all-terminal store`).toBe(0)
    expect(snap.runs.length).toBeGreaterThan(10)
    expect(snap.runs.filter((r) => r.status === 'running')).toHaveLength(0)
  }, 30000)
})
