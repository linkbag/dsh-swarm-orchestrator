// Version handshake between the two halves of this plugin.
//
// The browser re-reads `lib/client.js` from disk on EVERY page load, but the host
// loads its modules into memory ONCE at boot. So after an upgrade the page can
// offer actions the running host has never heard of, and clicking them returns a
// bare `unknown action "…"` while nothing happens. Observed in production on
// 0.6.20: a refreshed page showed the new run-curation menu against a host still
// running 0.6.17, and Rename / Remove both failed that way.
//
// The rule, in order:
//   1. trust what the host ADVERTISES (capabilities) — immune to version schemes;
//   2. fall back to version math against the release that added the actions;
//   3. when the version is missing or unparseable, stay ENABLED.
// Step 3 is deliberate: disabling working UI because a version string could not be
// read would be a worse failure than the one this guards against.
//
// Pure and DOM-free so it can be unit-tested directly.

/** The version this bundle was built from, injected by scripts/build-client.mjs. */
export const CLIENT_VERSION: string = typeof __CLIENT_VERSION__ === 'string' ? __CLIENT_VERSION__ : '0.0.0'

/** Capability a host advertises once it serves the run-curation actions. */
export const RUN_CURATION_CAPABILITY = 'run-curation'

/** The release that introduced rename / remove / permanent-remove. */
export const RUN_CURATION_FLOOR = '0.6.20'

/** Actions that only exist on hosts advertising RUN_CURATION_CAPABILITY. */
const CURATION_ACTIONS = new Set(['rename-run', 'set-run-board-state'])

/** Does this dashboard action need a host new enough for run curation? */
export function isCurationAction(action: string): boolean {
  return CURATION_ACTIONS.has(action)
}

/**
 * Parse a dotted version, tolerating a leading `v` and prerelease/build suffixes
 * (`0.6.20-alpha.1`, `0.6.20+build.7`). Short versions pad with zeros, so `0.6` is
 * 0.6.0. A core field that is not a plain number makes the whole thing
 * unparseable — the caller then declines to judge rather than guessing.
 */
function parseVersion(input: string | undefined): number[] | undefined {
  if (typeof input !== 'string') return undefined
  const core = input.trim().replace(/^v/i, '').split(/[-+]/, 1)[0]
  if (core === undefined || core.length === 0) return undefined
  const parts: number[] = []
  for (const field of core.split('.')) {
    if (!/^\d+$/.test(field)) return undefined
    parts.push(Number(field))
  }
  return parts.length > 0 ? parts : undefined
}

/** Numeric, field-by-field comparison with zero padding — never lexical. */
function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length, 3)
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Is the running host too old to serve the run-curation actions — i.e. should the
 * board disable them instead of letting the operator click into a rejection?
 */
export function isHostStale(hostVersion: string | undefined, capabilities?: readonly string[]): boolean {
  // 1. An advertised capability settles it, whatever the version says.
  if (Array.isArray(capabilities) && capabilities.includes(RUN_CURATION_CAPABILITY)) return false
  // 2/3. Version math, failing OPEN.
  const host = parseVersion(hostVersion)
  const floor = parseVersion(RUN_CURATION_FLOOR)
  if (host === undefined || floor === undefined) return false
  return compareVersions(host, floor) < 0
}

/**
 * Does this error mean the host never registered the action? Used as the
 * last-resort net so a *future* action addition degrades with an explanation
 * rather than echoing `unknown action "…"` at the operator.
 */
export function isUnknownActionError(message: string): boolean {
  return /unknown action/i.test(message)
}
