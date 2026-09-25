// The version-skew guard: the page can be newer than the running host (the client
// bundle is re-read from disk on every load, the host only reloads at boot), and
// the symptom is a bare `unknown action "…"` with nothing happening.
import { describe, expect, it } from 'vitest'
import {
  CLIENT_VERSION,
  RUN_CURATION_CAPABILITY,
  RUN_CURATION_FLOOR,
  isCurationAction,
  isHostStale,
  isUnknownActionError,
} from '../client/version.js'
import { BOARD_CAPABILITIES, buildBoardSnapshot } from '../src/board.js'

describe('version-skew guard (host older than the page)', () => {
  it('trusts an advertised capability over version math', () => {
    // A future host that changed its numbering entirely still settles the question.
    expect(isHostStale('0.1.0', [RUN_CURATION_CAPABILITY])).toBe(false)
    expect(isHostStale(undefined, [RUN_CURATION_CAPABILITY])).toBe(false)
  })

  it('flags a host older than the floor that introduced the actions', () => {
    for (const version of ['0.6.19', '0.6.9', 'v0.6.19', '0.6', '0.5.99']) {
      expect(isHostStale(version), version).toBe(true)
    }
  })

  it('accepts the floor and anything above it, with suffixes tolerated', () => {
    for (const version of ['0.6.20', 'v0.6.20', '0.6.20-alpha.1', '0.6.20+build.7', '0.6.21', '0.7.0', '1.0.0']) {
      expect(isHostStale(version), version).toBe(false)
    }
  })

  it('fails OPEN: a missing or unparseable version never disables the UI', () => {
    // Disabling working UI because a version string could not be read would be a
    // worse failure than the mismatch this guards against.
    for (const version of [undefined, '', '   ', 'unknown', '0.6.x', 'v', 'dev', '0.6.20.1-beta']) {
      expect(isHostStale(version), String(version)).toBe(false)
    }
  })

  it('compares numerically, not lexically', () => {
    // '0.6.9' sorts ABOVE '0.6.20' as a string; numerically it is below the floor.
    expect(isHostStale('0.6.9')).toBe(true)
    expect(isHostStale('0.6.100')).toBe(false)
  })

  it('knows which actions need the newer host', () => {
    expect(isCurationAction('rename-run')).toBe(true)
    expect(isCurationAction('set-run-board-state')).toBe(true)
    // Everything else exists on every host and must never be blocked by the guard.
    for (const action of ['endorse', 'resume', 'abort', 'review', 'retry-task', 'set-duty-table', 'set-runtime']) {
      expect(isCurationAction(action), action).toBe(false)
    }
  })

  it('recognises the raw unknown-action rejection it exists to replace', () => {
    expect(isUnknownActionError('unknown action "rename-run"')).toBe(true)
    expect(isUnknownActionError('Unknown action "set-run-board-state"')).toBe(true)
    // Real failures must pass through untouched.
    for (const message of ['HTTP 500', 'title required', 'unknown run run-x', 'state must be visible, removed or purged']) {
      expect(isUnknownActionError(message), message).toBe(false)
    }
  })

  it('the host advertises run curation in the board payload', () => {
    const snapshot = buildBoardSnapshot(
      { runs: new Map(), tasks: new Map() } as never,
      { roles: {} } as never,
      7,
      '0.6.21',
    )
    expect(BOARD_CAPABILITIES).toContain(RUN_CURATION_CAPABILITY)
    expect(snapshot.capabilities).toContain(RUN_CURATION_CAPABILITY)
    expect(snapshot.version).toBe('0.6.21')
    // The guard agrees with the payload the host sends.
    expect(isHostStale(snapshot.version, snapshot.capabilities)).toBe(false)
  })

  it('the built bundle carries a real client version (0.0.0 only in the test host)', () => {
    // esbuild's `define` replaces the symbol in lib/client.js; under vitest there is
    // no define, so the fallback applies — the shape is what matters here, and the
    // injected value is asserted against the built bundle in the release check.
    expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(RUN_CURATION_FLOOR).toBe('0.6.20')
  })
})
