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

    // The deployment default runs glm-5.3-flash WITH effort max — known-good.
    expect(support.supported.has('glm-5.3-flash')).toBe(true)
    expect(checkEffortSupport('glm-5.3-flash', 'max', support).incompatible).toBe(false)

    // 0.1.6 declares no per-model maps: glm-5.3 can no longer be judged, so the
    // preflight must NOT flag it (J18's drop-effort retry remains the safety net).
    expect(checkEffortSupport('glm-5.3', 'max', support).incompatible).toBe(false)

    // DeepSeek models declare no maps and are not judged.
    expect(checkEffortSupport('deepseek-flash', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('deepseek-v4-flash', 'high', support).incompatible).toBe(false)
  })
})
