/**
 * J21 preflight: can the deployment's chosen model accept the pinned reasoning
 * effort at all?
 *
 * The adapter rule (dsh-llm-pi-ai, `resolveModelReasoning` + `resolveReasoningLevel`):
 * a model with no `reasoningEfforts` declaration carries no reasoning metadata —
 * the adapter's own doc says "a model that carries no reasoning metadata — every
 * hand-declared one … is reported by pi-ai as supporting the single level `off`" —
 * and an explicit level other than that is refused at REQUEST time:
 *
 *   throw new LlmError(`pi-ai provider "..." model "..." does not support
 *   reasoning effort "..."`, "UNSUPPORTED_REASONING_EFFORT")
 *
 * A declared map, by contrast, names the levels the model accepts (each level maps
 * to the wire spelling the provider is sent).
 *
 * Production evidence (2026-09-23): `xiaomi/mimo-v2.6-pro` is hand-declared under
 * `llm-pi-ai` with no map, and children pinned to it died 41 ms after
 * `task/agent-started` with `max`, then 94 ms with `high` — the *presence* of the
 * field is the rejection, not its value. The same pin survived on
 * `deepseek-official/deepseek-flash`, which is the `llm-deepseek` adapter, not pi-ai.
 *
 * This is deliberately a *declarative* check against settings.yaml, not a probe of
 * the LLM service. Consequences:
 *   - model under an effort-validating root, NO map   -> pin must be stripped
 *   - model under an effort-validating root, WITH map -> only its declared levels
 *   - model outside those roots (deepseek, …)         -> not judged
 *   - the deployment's default model with a declared
 *     reasoningEffort                                 -> that pair is proven-good
 *
 * Known over-approximation: pi-ai falls back to the *installed catalog's* reasoning
 * metadata when a hand-declared entry matches a catalog id (`base?.reasoning ?? false`),
 * so such a model could in principle accept levels this file cannot see. The adapter
 * documents hand-declared entries as carrying no reasoning metadata, and stripping a
 * pin is always safe — the pin is a preference — so the check errs that way.
 *
 * Pure so the policy is directly testable.
 */

/**
 * The reasoning levels the pi-ai schema recognizes (its `THINKING_LEVELS`).
 * Only these keys are collected from a `reasoningEfforts:` map: an unknown key is
 * some other nested field, and treating it as a level would *widen* what may be
 * pinned. Under-collecting only ever strips a pin, which is the safe direction.
 */
const KNOWN_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface EffortSupport {
  /** Models declared with a reasoningEfforts map containing the effort. */
  readonly supported: ReadonlySet<string>
  /** Models declared WITHOUT any reasoningEfforts map: pi-ai reports them as `off`-only. */
  readonly declaredWithoutMap: ReadonlySet<string>
  /** Model id -> the reasoning levels it may be pinned to (its map's keys, plus a proven default pair). */
  readonly declaredLevels: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Extract `model -> accepted reasoning levels` declarations from DSH settings.yaml.
 * Kept tolerant: the file is the operator's, not ours, and a parse failure must
 * never break a dispatch. Only declarations under llm-pi-ai style provider blocks
 * are judged — deepseek models declare no maps and accept efforts anyway.
 */
export function parseEffortSupport(settingsYaml: string): EffortSupport {
  const supported = new Set<string>()
  const declaredWithoutMap = new Set<string>()
  const declaredLevels = new Map<string, Set<string>>()
  try {
    const lines = settingsYaml.split(/\r?\n/)
    // Only models under a provider whose family VALIDATES reasoning efforts are
    // judged. Today that is the pi-ai family (`llm-pi-ai:` in settings.yaml, with
    // nested providers such as `zai:` and `xiaomi:`). DeepSeek-family models live
    // under `llm-deepseek:` and accept efforts without declaring maps, so they must
    // not be flagged for their absence.
    const EFFORT_VALIDATING_ROOTS = new Set(['llm-pi-ai'])
    let insideValidatingRoot = false
    let currentModel: string | null = null
    let sawEffortsForCurrent = false
    let currentLevels: Set<string> | null = null
    let effortsIndent = -1
    let insideDefaultModel = false
    let defaultModelId: string | null = null
    let defaultEffort: string | null = null
    const flushCurrent = (): void => {
      if (currentModel !== null && !sawEffortsForCurrent) declaredWithoutMap.add(currentModel)
    }
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (/^\S/.test(line)) {
        // Leaving the validating root: flush the last seen model that had no map.
        flushCurrent()
        insideValidatingRoot = [...EFFORT_VALIDATING_ROOTS].some((r) => line.startsWith(r + ':'))
        insideDefaultModel = line.startsWith('agent-default-model:')
        currentModel = null
        sawEffortsForCurrent = false
        currentLevels = null
        effortsIndent = -1
        continue
      }
      if (insideDefaultModel) {
        const id = line.match(/^\s*model:\s*(\S+)\s*$/)
        if (id) defaultModelId = id[1]
        const effort = line.match(/^\s*reasoningEffort:\s*(\S+)\s*$/)
        if (effort) defaultEffort = effort[1]
        continue
      }
      if (!insideValidatingRoot) continue
      const model = line.match(/^\s*-\s*id:\s*(\S+)\s*$/)
      if (model) {
        flushCurrent()
        currentModel = model[1]
        sawEffortsForCurrent = false
        currentLevels = null
        effortsIndent = -1
        continue
      }
      const effortsLine = line.match(/^(\s*)reasoningEfforts:\s*$/)
      if (effortsLine) {
        sawEffortsForCurrent = true
        if (currentModel !== null) {
          supported.add(currentModel)
          const levels = new Set<string>()
          declaredLevels.set(currentModel, levels)
          currentLevels = levels
          effortsIndent = effortsLine[1].length
        }
        continue
      }
      // Inside a `reasoningEfforts:` block: the more-indented `<level>:` keys that
      // follow are the levels this model accepts. The block ends at the first line
      // whose indentation is not deeper than the `reasoningEfforts:` key itself.
      if (currentLevels !== null) {
        const indent = raw.length - raw.trimStart().length
        if (indent <= effortsIndent) {
          currentLevels = null
          effortsIndent = -1
          continue
        }
        const level = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*):/)
        if (level !== null && KNOWN_THINKING_LEVELS.has(level[1])) currentLevels.add(level[1])
        continue
      }
    }
    flushCurrent()
    // The deployment's default model runs with its declared effort: first-hand
    // evidence that this exact pair is accepted, so that level — and only it — is
    // allowed for the model. It must NOT mark a map-less model capable of any
    // other level (that is the mismatch that killed the run).
    if (defaultModelId !== null && defaultEffort !== null) {
      supported.add(defaultModelId)
      const levels = declaredLevels.get(defaultModelId) ?? new Set<string>()
      levels.add(defaultEffort)
      declaredLevels.set(defaultModelId, levels)
    }
  } catch {
    // tolerant: an unreadable file simply yields no declarations
  }
  return { supported, declaredWithoutMap, declaredLevels }
}

export interface EffortCheck {
  /** Human-readable warning, when the pair is known-incompatible. */
  readonly warning?: string
  /** true when the check is confident the pair is unsupported. */
  readonly incompatible: boolean
}

/**
 * Whether a pinned effort on this model is declared unsupported. `incompatible` is
 * true only for a model we have a DECLARATION about:
 *   - it declares levels, and the pinned one is not among them; or
 *   - it is hand-declared under an effort-validating root with no map, which pi-ai
 *     reports as supporting only `off` — so any explicit level is refused.
 * A model we have no declaration for (deepseek, anything outside those roots) cannot
 * be judged and is never flagged.
 */
export function checkEffortSupport(model: string, effort: string, support: EffortSupport | undefined): EffortCheck {
  if (support === undefined) return { incompatible: false }
  const levels = support.declaredLevels.get(model)
  if (levels !== undefined) {
    if (levels.has(effort)) return { incompatible: false }
    const declared = levels.size > 0 ? [...levels].sort().join(', ') : 'no parseable level'
    return {
      incompatible: true,
      warning: `model "${model}" declares reasoningEfforts (${declared}) in settings.yaml, so effort "${effort}" is not one of its levels — the dispatcher will strip the pin rather than let the request die with UNSUPPORTED_REASONING_EFFORT`,
    }
  }
  // No declaration at all: absence is not proof for models outside the validating
  // roots (deepseek models declare no maps and accept efforts).
  if (!support.declaredWithoutMap.has(model)) return { incompatible: false }
  return {
    incompatible: true,
    warning: `model "${model}" is hand-declared under llm-pi-ai with no reasoningEfforts map, and pi-ai reports such a model as supporting only "off": any explicit level — including "${effort}" — is refused at request time with UNSUPPORTED_REASONING_EFFORT (observed live: xiaomi/mimo-v2.6-pro died 41 ms after agent-started with "max" and 94 ms with "high"). Declare reasoningEfforts for this model, or leave the effort unset`,
  }
}
