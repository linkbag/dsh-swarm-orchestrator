// Connection-budget pins for the client plugin.
//
// Incident (2026-09-23): enabling the plugin froze the entire web UI — no chat
// history, no plugin-market catalog, no swarm board — while the host process
// stayed healthy and a second client (the phone) could still act. The
// `swarm_dispatch` toolview renders once per historical dispatch call, and each
// card opened its own persistent `EventSource('/swarm/events')`. A browser
// allows ~6 concurrent connections per origin and an SSE stream never ends, so
// the cards consumed the whole budget and every other request on the page
// queued forever. The badge opened a second stream of its own.
//
// Fix pinned here: exactly ONE stream for the plugin, owned by the shared board
// store, reference-counted so one component unmounting cannot kill the stream
// another consumer is still riding, and every live widget renders from that
// shared snapshot instead of polling the board itself.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientDir = fileURLToPath(new URL('../client/', import.meta.url))

function readClient(name: string): string {
  return readFileSync(clientDir + name, 'utf8')
}

function clientSources(): string[] {
  return readdirSync(clientDir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
}

describe('client connection budget (freeze incident follow-up)', () => {
  it('constructs exactly one EventSource in the whole client, and only in board-store', () => {
    const offenders: string[] = []
    let total = 0
    for (const name of clientSources()) {
      const hits = readClient(name).match(/new EventSource\(/g)?.length ?? 0
      if (hits === 0) continue
      total += hits
      if (name !== 'board-store.ts') offenders.push(`${name} (${hits})`)
    }
    expect(offenders, 'only the shared board store may own the /swarm/events stream').toEqual([])
    expect(total, 'the plugin must hold exactly one SSE connection').toBe(1)
  })

  it('keeps every live widget on the shared snapshot instead of polling the board', () => {
    // A per-widget `fetch('/swarm/board')` multiplied with history length: one
    // request per rendered dispatch card, per event, per widget.
    for (const name of ['index.ts', 'SwarmHeaderButton.tsx', 'ToolDispatchCard.tsx']) {
      expect(readClient(name), `${name} must not fetch the board directly`).not.toMatch(/fetch\('\/swarm\/board'\)/)
    }
  })

  it('reference-counts the shared stream so one unmount cannot kill another consumer', () => {
    expect(readClient('board-store.ts')).toMatch(/retain\(\): \(\) => void/)
    for (const name of ['SwarmTab.tsx', 'SwarmSettingsSection.tsx', 'SwarmHeaderButton.tsx', 'ToolDispatchCard.tsx']) {
      const source = readClient(name)
      expect(source, `${name} must retain the shared store`).toMatch(/\.retain\(\)/)
      expect(source, `${name} must not stop the shared store directly`).not.toMatch(/store\.stop\(\)/)
    }
  })
})
