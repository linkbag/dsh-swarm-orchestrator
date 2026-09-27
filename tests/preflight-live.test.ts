// Verify the preflight against the REAL deployment.
//
// The live source moved (2026-09-26): DSH 0.1.7-rc.2 imported `settings.yaml` into
// the active profile and renamed the document, so the preflight now reads the
// settings SERVICE (`ctx.settings.describe()`) and keeps the file as a fallback for
// older installs. This file therefore asserts two real-deployment facts: the legacy
// file path still parses when one exists, and a home that has ONLY the renamed
// `.imported` copy must leave the check inactive — a stale document must never be
// read as if it were live. The service-sourced parsing is covered unit-wise in
// `preflight-source.test.ts`; the live document was additionally verified by hand
// (51 models under llm-pi-ai, none declaring a `reasoningEfforts` map).
//
// History: on 0.1.5 this file declared per-model `reasoningEfforts:` maps (only
// glm-5.3-flash had one — the exact J21 mismatch). The 0.1.6 rewrite dropped the
// maps, and the old parser concluded "without per-model maps the file judges no
// model". That conclusion was WRONG for pi-ai: `resolveModelReasoning` returns
// `{ reasoning: base?.reasoning ?? false }` for a model with no `reasoningEfforts`
// (the adapter rule is unchanged in 0.1.7-rc.2 — verified at
// dsh-llm-pi-ai/lib/index.js:563-565), and `resolveReasoningLevel` then throws
// UNSUPPORTED_REASONING_EFFORT for any explicit level. Observed live on 2026-09-23:
// xiaomi/mimo-v2.6-pro died 41 ms after agent-started with `max`, 94 ms with `high`.
//
// 2026-09-26 — that reading is no longer ACTED on. Absence of a map is UNKNOWN, not a
// rejection: `base?.reasoning` is the *installed catalog's* metadata for a matching id,
// so a catalog-matched model accepts levels the settings document cannot express. The
// deployment is 51 map-less pi-ai models, so the old rule stripped every pin silently
// while the live events recorded zero unsupported-effort refusals. Only a declared map
// that excludes the pin strips now (see the policy note in src/preflight.ts), and the
// verdicts below were updated to match.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'
import { SwarmService } from '../src/service.js'
import { parseEffortSupport, checkEffortSupport } from '../src/preflight.js'

describe('J21 preflight against the real deployment', () => {
  it('matches the actual settings.yaml declarations', () => {
    // DSH 0.1.7-rc.2 imports the deployment file (`settings.yaml.imported`) and keeps
    // live settings elsewhere, so the old absolute path can legitimately be absent.
    // Resolve whatever exists; when nothing does, say so rather than failing red —
    // the parser itself stays covered by the unit tests. Asserting against the stale
    // `.imported` copy would be worse: it would silently validate an outdated file.
    const candidates = [
      process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0 ? `${process.env.DSH_HOME}/settings.yaml` : '',
      'C:/Users/tsing/.dsh/settings.yaml',
    ].filter((p) => p.length > 0)
    const found = candidates.find((p) => existsSync(p))
    if (found === undefined) {
      console.log('no live settings.yaml at ' + candidates.join(' | ') + ' — skipping the deployment assertion')
      return
    }
    const settings = readFileSync(found, 'utf8')
    const support = parseEffortSupport(settings)
    console.log('supported:', [...support.supported])
    console.log('declaredWithoutMap:', [...support.declaredWithoutMap].slice(0, 12))
    console.log('declaredLevels:', [...support.declaredLevels].map(([model, levels]) => `${model}=${[...levels].join('|')}`))

    // The deployment's default model with a declared reasoningEffort is the one
    // known-supported pair — whatever it currently is (it was zai/glm-5.3-flash,
    // now deepseek-official/deepseek-flash; the test derives it from the file so
    // changing the default model does not break this test).
    const defaultBlock = settings.match(
      /agent-default-model:\s*\n\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)\s*\n\s*reasoningEffort:\s*(\S+)/,
    )
    if (defaultBlock !== null) {
      expect(support.supported.has(defaultBlock[2])).toBe(true)
      expect(checkEffortSupport(defaultBlock[2], defaultBlock[3], support).incompatible).toBe(false)
    }

    // The corrected rule (2026-09-26), held against the live document: a model
    // hand-declared under llm-pi-ai with NO reasoningEfforts map is UNKNOWN, and its pin
    // is left in place. The old rule read that absence as "off-only" and refused it,
    // which condemned every map-less model in the deployment (51 of them) and silently
    // dropped every pin — the degradation the live evidence overturned (a pinned
    // `xiaomi/mimo-v2.6-pro` task did real work; zero unsupported-effort refusals across
    // 4,566 events).
    for (const model of [...support.declaredWithoutMap]) {
      // A model that ALSO carries a proven level (the default-model pair, which the
      // parser writes into declaredLevels) is judged by that set in the loop below.
      if (support.declaredLevels.has(model)) continue
      expect(checkEffortSupport(model, 'max', support).incompatible).toBe(false)
      expect(checkEffortSupport(model, 'high', support).incompatible).toBe(false)
    }
    // The two verdicts the incident turns on, when the document has them: both keep
    // their `max` pin — mimo through the absence of any map, glm-5.3 through the
    // default-model pair.
    for (const named of ['mimo-v2.6-pro', 'glm-5.3']) {
      if (support.declaredWithoutMap.has(named) || support.declaredLevels.has(named)) {
        const verdict = checkEffortSupport(named, 'max', support).incompatible ? 'STRIPPED' : 'KEPT'
        console.log(`live verdict ${named}@max: ` + verdict)
        expect(checkEffortSupport(named, 'max', support).incompatible).toBe(false)
      }
    }
    // A level a model DECLARES is never flagged: that is the pin the deployment can use.
    for (const [model, levels] of [...support.declaredLevels]) {
      for (const level of [...levels]) {
        expect(checkEffortSupport(model, level, support).incompatible).toBe(false)
      }
    }
    // Outside the validating roots (the llm-deepseek adapter) nothing is judged —
    // which is exactly why the same pin survived on deepseek-flash.
    expect(checkEffortSupport('deepseek-v4-flash', 'high', support).incompatible).toBe(false)
  })

  it('never reads the renamed legacy document as the live source', async () => {
    // The real home: `settings.yaml` was imported away, leaving only the renamed
    // copy. That copy still DECLARES models, so if the preflight read it the check
    // would come back active — the assertion below is therefore a real test of the
    // stale-document rule, not a tautology. Booting with no settings service is what
    // makes the file path the only candidate that could activate it.
    const home = 'C:/Users/tsing/.dsh'
    const live = join(home, 'settings.yaml')
    const renamed = join(home, 'settings.yaml.imported')
    if (existsSync(live)) {
      console.log('this deployment still has settings.yaml — the stale-copy rule is not exercised')
      return
    }
    if (!existsSync(renamed)) {
      console.log('no renamed legacy document at ' + renamed + ' — nothing to assert')
      return
    }

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    // The service's own storage lives in a temp dir: pointing DSH_HOME at the real
    // home is what this test needs, but it must not write anything there.
    const storageDir = mkdtempSync(join(tmpdir(), 'swarm-preflight-live-'))
    try {
      const ctx = new Context()
      ctx.reflect.provide('subagents', { start: () => new Promise(() => {}) } as never)
      await ctx.plugin(swarmPlugin, {
        storageDir,
        maxConcurrent: 5,
        maxRetries: 2,
        reviewLoops: 3,
        requireArchitectReview: false,
        workspaceRunPolicy: 'off',
        retryBackoffBaseMs: 0,
        circuitBreakerThreshold: 0,
      })
      const service = (ctx.get('swarm') as Record<symbol, unknown>)[Symbol.for('cordis.original')] as SwarmService
      const support = (service as unknown as { effortSupport(): unknown }).effortSupport()
      expect(support).toBeUndefined()
    } finally {
      rmSync(storageDir, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})
