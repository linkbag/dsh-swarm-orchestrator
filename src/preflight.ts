/**
 * J21 preflight: does this deployment declare that a model supports a pinned
 * reasoning effort?
 *
 * Motivation: a role pinned `reasoningEffort: "max"` with a `zai/glm-5.3` fallback
 * killed every task in a run — `UNSUPPORTED_REASONING_EFFORT` — because the
 * deployment's settings declare effort mappings only for `glm-5.3-flash`. The
 * mismatch is knowable at DISPATCH time from the same settings file the operator
 * edits, so it should be a warning then, not a six-task outage later.
 *
 * This is deliberately a *declarative* check against settings.yaml, not a probe of
 * the LLM service: the base adapter's `resolveModel` returns no reasoning metadata,
 * and provider-specific overrides are not reachable from here. Consequences:
 *   - a model declared WITH the effort in its map  -> certainly fine
 *   - a model declared WITHOUT a map / without it  -> warn (this caught the real case)
 *   - a model not mentioned in settings at all     -> no warning (cannot know;
 *     e.g. deepseek models declare no efforts but accept them)
 *
 * Pure so the policy is directly testable.
 */

export interface EffortSupport {
  /** Models declared with a reasoningEfforts map containing the effort. */
  readonly supported: ReadonlySet<string>
  /** Models explicitly declared WITHOUT any reasoningEfforts map. */
  readonly declaredWithoutMap: ReadonlySet<string>
}

/**
 * Extract `provider/model -> supported efforts` declarations from DSH settings.yaml.
 * Kept tolerant: the file is the operator's, not ours, and a parse failure must
 * never break a dispatch. Only declarations under llm-pi-ai style provider blocks
 * carry effort maps today; deepseek models declare none and accept efforts anyway.
 */
export function parseEffortSupport(settingsYaml: string): EffortSupport {
  const supported = new Set<string>()
  const declaredWithoutMap = new Set<string>()
  try {
    const lines = settingsYaml.split(/\r?\n/)
    // Only models under a provider whose family VALIDATES reasoning efforts are
    // judged. Today that is the pi-ai family (`llm-pi-ai:` in settings.yaml, with
    // nested providers such as `zai:`). DeepSeek-family models declare no effort
    // maps and accept them anyway, so they must not be flagged for their absence.
    const EFFORT_VALIDATING_ROOTS = new Set(['llm-pi-ai'])
    let insideValidatingRoot = false
    let currentModel: string | null = null
    let sawEffortsForCurrent = false
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (/^\S/.test(line)) {
        // Leaving the validating root: flush the last seen model that had no map.
        if (insideValidatingRoot && currentModel !== null && !sawEffortsForCurrent) {
          declaredWithoutMap.add(currentModel)
        }
        insideValidatingRoot = [...EFFORT_VALIDATING_ROOTS].some((r) => line.startsWith(r + ':'))
        currentModel = null
        sawEffortsForCurrent = false
        continue
      }
      if (!insideValidatingRoot) continue
      const model = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
      if (model) {
        if (currentModel !== null && !sawEffortsForCurrent) declaredWithoutMap.add(currentModel)
        currentModel = model[1]
        sawEffortsForCurrent = false
        continue
      }
      if (/^reasoningEfforts:\s*$/.test(line.trim())) {
        sawEffortsForCurrent = true
        if (currentModel !== null) supported.add(currentModel)
      }
    }
    if (currentModel !== null && !sawEffortsForCurrent) declaredWithoutMap.add(currentModel)
  } catch {
    // tolerant: an unreadable file simply yields no declarations
  }
  return { supported, declaredWithoutMap }
}

export interface EffortCheck {
  /** Human-readable warning, when the pair is known-incompatible. */
  readonly warning?: string
  /** true when the check is confident the pair is unsupported. */
  readonly incompatible: boolean
}

/**
 * Whether a pinned effort on this model is declared unsupported. `incompatible` is
 * only true when the model is DECLARED and the effort is ABSENT from its map — a
 * model we have no declaration for cannot be judged.
 */
export function checkEffortSupport(model: string, effort: string, support: EffortSupport | undefined): EffortCheck {
  if (support === undefined) return { incompatible: false }
  // deepseek-family models declare no maps but accept efforts: absence alone is not proof.
  if (!support.supported.has(model) && !support.declaredWithoutMap.has(model)) return { incompatible: false }
  if (support.supported.has(model)) return { incompatible: false }
  return {
    incompatible: true,
    warning: `model "${model}" declares no reasoningEfforts map in settings.yaml, so effort "${effort}" is not known to be supported — the dispatcher will drop the effort pin rather than fail the task (this exact mismatch killed 6 tasks in one run)`,
  }
}
