// Verify the preflight parser against the REAL deployment settings.yaml.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseEffortSupport, checkEffortSupport } from '../src/preflight.js'

describe('J21 preflight against the real deployment', () => {
  it('matches the actual settings.yaml declarations', () => {
    const settings = readFileSync('C:/Users/tsing/.dsh/settings.yaml', 'utf8')
    const support = parseEffortSupport(settings)
    console.log('supported:', [...support.supported])
    console.log('declaredWithoutMap:', [...support.declaredWithoutMap].slice(0, 12))

    // The production mismatch: max pinned on glm-5.3 (no map declared).
    expect(checkEffortSupport('glm-5.3', 'max', support).incompatible).toBe(true)
    // The supported flash model passes.
    expect(checkEffortSupport('glm-5.3-flash', 'max', support).incompatible).toBe(false)
    // DeepSeek models declare no maps and are not judged.
    expect(checkEffortSupport('deepseek-flash', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('deepseek-v4-flash', 'high', support).incompatible).toBe(false)
  })
})
