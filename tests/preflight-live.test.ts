// Verify the preflight parser against the REAL deployment settings.yaml.
//
// History: on 0.1.5 this file declared per-model `reasoningEfforts:` maps (only
// glm-5.3-flash had one — the exact J21 mismatch). The 0.1.6 rewrite dropped the
// maps, and the old parser concluded "without per-model maps the file judges no
// model". That conclusion was WRONG for pi-ai: `resolveModelReasoning` returns
// `{ reasoning: false }` for a model with no `reasoningEfforts`, and
// `resolveReasoningLevel` then throws UNSUPPORTED_REASONING_EFFORT for any explicit
// level — the adapter documents a hand-declared model as supporting only `off`.
// Observed live on 2026-09-23: xiaomi/mimo-v2.6-pro died 41 ms after agent-started
// with `max`, and 94 ms with `high`.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseEffortSupport, checkEffortSupport } from '../src/preflight.js'

describe('J21 preflight against the real deployment', () => {
  it('matches the actual settings.yaml declarations', () => {
    const settings = readFileSync('C:/Users/tsing/.dsh/settings.yaml', 'utf8')
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

    // The corrected rule, held against the live file: a model hand-declared under
    // llm-pi-ai with NO reasoningEfforts map supports only `off`, so EVERY explicit
    // level is refused at request time. These are the children that died in 41/94 ms.
    for (const model of [...support.declaredWithoutMap]) {
      expect(checkEffortSupport(model, 'max', support).incompatible).toBe(true)
    }
    // Live confirmation for the model behind the incident, when it is one of them.
    if (support.declaredWithoutMap.has('mimo-v2.6-pro')) {
      expect(checkEffortSupport('mimo-v2.6-pro', 'high', support).incompatible).toBe(true)
      expect(checkEffortSupport('mimo-v2.6-pro', 'max', support).incompatible).toBe(true)
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
})
