// Hardening pins for the client plugin entry.
//
// Incident (2026-09-22 22:04): an auto-updated DSH 0.1.7-alpha.2 landed in the
// global root WITHOUT its companion packages; the restarted UI froze outright
// ("web ui freezes, no chat history") and the swarm plugin was blamed and
// removed. The plugin's own artifacts proved clean (host import OK, client
// bundle evaluation OK, boot against the real 3.7MB event store appended zero
// events) — but the audit exposed a real fragility: the client entry
// hard-injected version-specific faces (`remote.llm`, `locale`, …). A hard
// inject blocks activation until the service exists, so ONE renamed face on
// ANY future host would have made the swarm plugin stall the client tree for
// real. These tests pin the corrected design so it cannot quietly regress.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../client/index.ts', import.meta.url)), 'utf8')

describe('client plugin hardening (freeze incident follow-up)', () => {
  it('declares only the stable core service in inject', () => {
    expect(source).toMatch(/export const inject = \['slots'\]/)
  })

  it('never hard-injects a version-specific service face again', () => {
    // A hard inject list mentioning any optional face is the regression.
    const injectLine = source.match(/export const inject = \[([^\]]*)\]/)
    expect(injectLine).not.toBeNull()
    const names = injectLine![1]
    for (const face of ['remote', 'locale', 'connection']) {
      expect(names, `inject must not hard-require "${face}"`).not.toContain(face)
    }
  })

  it('wires the optional faces through a dynamically scoped inject', () => {
    // The upgrade path: a callback that fires only when the host actually
    // provides every face — missing one degrades instead of blocking.
    expect(source).toMatch(/\.inject\?\.\(\s*\['connection', 'remote', 'remote\.llm', 'remote\.session', 'locale'\]/)
  })

  it('guards every direct service property access on the context', () => {
    // Unguarded `ctx.remote` / `ctx.locale` property reads throw on cordis
    // when the service is not injected — an escaping throw from the catalog
    // getter is how a degraded host turns into a broken UI. Line-based check:
    // every line that reads a service property off the raw context must sit
    // directly inside a try block (its preceding non-empty line opens one).
    const lines = source.split('\n')
    const reads: number[] = []
    lines.forEach((line, i) => {
      if (line.includes('(ctx as unknown as') && (line.includes(').locale') || line.includes(').remote'))) reads.push(i)
    })
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const i of reads) {
      let j = i - 1
      while (j >= 0 && lines[j].trim() === '') j--
      expect(lines[j].trim().startsWith('try {'), `line ${i + 1} reads a service property outside a try block`).toBe(true)
    }
  })
})
