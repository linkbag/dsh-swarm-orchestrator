// lib/ is gitignored and built by `npm run build`, but nothing verified that the
// built bundle actually reflects the current client source.
//
// That gap shipped a real bug: a theme change was committed to client/swarm.css at
// 09:34 while lib/client.js was still the 20:01 build from the previous evening, so
// the browser kept loading the OLD styles. The fix was "done, pushed and served" and
// still invisible — the classic stale-artifact trap, where every individual claim
// (committed, pushed, served) was true and the user still saw the old UI.
//
// This test fails loudly in that situation. It skips when the bundle is absent
// (a fresh checkout, where `npm run build` has not run yet).
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const CLIENT_DIR = join(ROOT, 'client')

function newestSourceMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath ?? dir, entry.name)
    const t = statSync(full).mtimeMs
    if (t > newest) newest = t
  }
  return newest
}

describe('built client artifact', () => {
  it('lib/client.js is newer than everything under client/ (or absent)', () => {
    if (!existsSync(BUNDLE)) {
      // Fresh checkout: the bundle is gitignored and built on demand.
      expect(true).toBe(true)
      return
    }
    const bundleTime = statSync(BUNDLE).mtimeMs
    const sourceTime = newestSourceMtime(CLIENT_DIR)
    const staleMs = sourceTime - bundleTime
    expect(
      staleMs <= 0,
      `lib/client.js is STALE by ${Math.round(staleMs / 1000)}s — the browser is served the `
      + 'previous build, so client changes are invisible no matter how many times it is refreshed. '
      + 'Run `npm run build` and commit nothing else.',
    ).toBe(true)
  })

  it('the served bundle contains no leftover hardcoded dark fills', () => {
    if (!existsSync(BUNDLE)) return
    const text = require('node:fs').readFileSync(BUNDLE, 'utf8') as string
    // rgba(20, 22, 26, …) was the pre-theme node/card fill; it is invisible on a
    // light theme. Guard the regression directly.
    expect(text.includes('rgba(20, 22, 26')).toBe(false)
  })
})
