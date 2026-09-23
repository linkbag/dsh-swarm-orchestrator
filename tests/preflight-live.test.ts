// Verify the preflight parser against the REAL deployment settings.yaml.
//
// History: on 0.1.5 this file declared per-model `reasoningEfforts:` maps (only
// glm-5.3-flash had one — the exact J21 mismatch). The 0.1.6 rewrite dropped the
// maps entirely; the only effort fact left is `agent-default-model` (the
// deployment's default model with its reasoningEffort), so nothing else is judged.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseEffortSupport, checkEffortSupport } from '../src/preflight.js'

describe('J21 preflight against the real deployment', () => {
  it('matches the actual settings.yaml declarations', () => {
    const settings = readFileSync('C:/Users/tsing/.dsh/settings.yaml', 'utf8')
    const support = parseEffortSupport(settings)
    console.log('supported:', [...support.supported])
    console.log('declaredWithoutMap:', [...support.declaredWithoutMap].slice(0, 12))

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

    // The 0.1.6 format declares no per-model reasoningEfforts maps, so nothing
    // else is judged incompatible — J18's drop-effort retry is the safety net.
    expect(checkEffortSupport('glm-5.3', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('glm-5.3-flash', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('deepseek-v4-flash', 'high', support).incompatible).toBe(false)
  })
})
