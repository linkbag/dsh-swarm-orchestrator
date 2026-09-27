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
 * This is deliberately a *declarative* check against the deployment's settings, not a
 * probe of the LLM service. Consequences:
 *   - model under an effort-validating root, WITH map -> only its declared levels
 *   - model under an effort-validating root, NO map   -> NOT judged: the pin is kept
 *   - model outside those roots (deepseek, …)         -> not judged
 *   - the deployment's default model with a declared
 *     reasoningEffort                                 -> that LEVEL is proven-good, and
 *     the pair may only widen a declared map: proof of one level is not evidence
 *     against another, so it can never create an exclusion set
 *
 * POLICY (2026-09-26): strip only on POSITIVE evidence — a declared map that excludes
 * the pin. The mere ABSENCE of a map is unknown, not a rejection, so the pin stays:
 *   - The over-approximation above is real and was decisive. pi-ai resolves a
 *     hand-declared entry that matches an installed catalog id through the catalog's
 *     own reasoning metadata (`base?.reasoning ?? false`), so such a model does accept
 *     levels this check cannot see. Judging absence as rejection therefore condemned
 *     all 51 of the deployment's map-less pi-ai models and silently dropped every pin.
 *   - The live evidence contradicts the old reading: on 2026-09-26 a task ran
 *     `xiaomi/mimo-v2.6-pro` with `max` pinned and did real work, and across 4,566
 *     events there are ZERO recorded unsupported-effort refusals (8 of the 15 pinned
 *     attempts in the upgrade era completed).
 * A pin that is genuinely refused must stay a loud, fast, recoverable failure — the
 * effort ladder / internal rung retry is the escape — never a silent downgrade. How
 * many models rest on that uncertainty is reported in the preflight's once-only log
 * line, so it is visible rather than invisible.
 *
 * The default pair is read the same way, and this was the last carve-out: its declared
 * level is proof FOR that level (so it may widen a declared map), never proof AGAINST
 * the others. Treating it as a level set invented `{max}` for the deployment's own
 * `zai/glm-5.3` — which declares no map at all — so a legitimate `high` pin on the
 * default model was stripped, with a warning that claimed a map existed.
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
  /**
   * Models whose levels are known: those with a declared map, plus the default pair's
   * model (its own level is proven first-hand). Feeds the once-only log's counts.
   */
  readonly supported: ReadonlySet<string>
  /**
   * Models declared WITHOUT any reasoningEfforts map. Absence is NOT evidence of
   * rejection (see the policy note above): their pins are left in place. The set is
   * still collected because it is what makes the uncertainty reportable, and it counts
   * toward "this source declared something" — so a map-less deployment keeps an ACTIVE
   * preflight that says so, instead of one that goes quiet.
   */
  readonly declaredWithoutMap: ReadonlySet<string>
  /**
   * Model id -> the levels its DECLARED MAP accepts, and nothing else. Presence here is
   * what licenses exclusion: a map enumerates a model's levels, so a pin outside it is
   * positively unsupported. The default-model pair is deliberately never merged in —
   * proof of one level cannot exclude another, and merging it invented `{max}` for a
   * map-less model (the live default) and stripped its other pins.
   */
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
    // The deployment's default model runs with its declared effort: first-hand proof
    // that this LEVEL is accepted for this model. Proof for one level is never proof
    // against another, so the pair may only WIDEN a declared map (adding a level the map
    // omits but the deployment demonstrably runs). It must never CREATE a level set: a
    // set excludes, and for a map-less model — the live `zai/glm-5.3` — that turned the
    // pair's own `max` into an invented `{max}` that stripped a legitimate `high`.
    if (defaultModelId !== null && defaultEffort !== null) {
      supported.add(defaultModelId)
      declaredLevels.get(defaultModelId)?.add(defaultEffort)
    }
  } catch {
    // tolerant: an unreadable file simply yields no declarations
  }
  return { supported, declaredWithoutMap, declaredLevels }
}

/**
 * The profile entry whose models pi-ai validates. Matched as a suffix so both the
 * entry id (`llm-pi-ai`) and the package name (`@deepseek-ai/dsh-llm-pi-ai`) count,
 * while `llm-deepseek` — which accepts efforts without declaring maps — does not.
 */
const PI_AI_ENTRY = /llm-pi-ai$/i

/** The entry that names the deployment's default model and its effort. */
const DEFAULT_MODEL_ENTRY = /agent-default-model$/i

/**
 * J21 live source: one settings entry as the settings service reports it — the
 * profile entry id and its live Config value (an object, not YAML text).
 */
export interface SettingsEntryValue {
  readonly ns: string
  readonly value: unknown
}

/** Model-ish object: a declared `id` plus any of the fields a model entry carries. */
function isModelEntry(record: Record<string, unknown>): boolean {
  if (typeof record.id !== 'string') return false
  return record.name !== undefined || record.contextWindow !== undefined
    || record.maxTokens !== undefined || record.input !== undefined
}

/**
 * Walk a live llm-pi-ai Config value and record what it declares per model.
 *
 * Mirrors the adapter's rule (`resolveModelReasoning`): a model whose
 * `reasoningEfforts` is absent keeps the installed catalog's capability, and for a
 * hand-declared model the catalog has no entry of that id — so it is reported as
 * `off`-only. `false` is the schema's explicit "not a reasoning model", which is
 * also `off`-only. Either way the model is UNJUDGED here: it lands in
 * `declaredWithoutMap`, which is counted and logged but never used to strip a pin —
 * the installed catalog may still resolve that model's reasoning capability.
 */
function collectPiAiModels(
  value: unknown,
  out: { supported: Set<string>; declaredWithoutMap: Set<string>; declaredLevels: Map<string, Set<string>> },
  seen: Set<object>,
): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectPiAiModels(item, out, seen)
    return
  }
  const record = value as Record<string, unknown>
  if (isModelEntry(record)) {
    const id = record.id as string
    const efforts = record.reasoningEfforts
    if (efforts !== null && typeof efforts === 'object' && !Array.isArray(efforts)) {
      const levels = new Set<string>()
      for (const key of Object.keys(efforts as Record<string, unknown>)) {
        if (KNOWN_THINKING_LEVELS.has(key)) levels.add(key)
      }
      // A map with no recognizable level is a config error the adapter rejects at
      // load; reading it as off-only strips rather than invents capability.
      if (levels.size > 0) {
        out.supported.add(id)
        out.declaredLevels.set(id, levels)
      } else {
        out.declaredWithoutMap.add(id)
      }
    } else {
      out.declaredWithoutMap.add(id)
    }
  }
  for (const nested of Object.values(record)) collectPiAiModels(nested, out, seen)
}

/**
 * The `{ model, reasoningEffort }` pair the default-model entry carries, at any depth.
 * The level lands in `proven`, NOT in `declaredLevels`: `declaredLevels` is the
 * exclusion set (a real map's keys) while this evidence only ever widens — see the
 * merge in `parseEffortSupportFromEntries`.
 */
function collectDefaultPairs(
  value: unknown,
  out: { supported: Set<string>; proven: Map<string, Set<string>> },
  seen: Set<object>,
): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectDefaultPairs(item, out, seen)
    return
  }
  const record = value as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model : undefined
  const effort = typeof record.reasoningEffort === 'string' ? record.reasoningEffort : undefined
  if (model !== undefined && effort !== undefined) {
    out.supported.add(model)
    const levels = out.proven.get(model) ?? new Set<string>()
    levels.add(effort)
    out.proven.set(model, levels)
  }
  for (const nested of Object.values(record)) collectDefaultPairs(nested, out, seen)
}

/**
 * The same declarations, read from the LIVE settings service instead of YAML text.
 *
 * The deployment's `settings.yaml` is gone: DSH imported it into the active profile
 * and renamed the document, so the service's `describe()` values are the only
 * current truth. Kept tolerant for the same reason as the file parser — a shape we
 * do not recognize must yield NOTHING judged, never a verdict we cannot justify.
 */
export function parseEffortSupportFromEntries(entries: readonly SettingsEntryValue[]): EffortSupport {
  const supported = new Set<string>()
  const declaredWithoutMap = new Set<string>()
  const declaredLevels = new Map<string, Set<string>>()
  const proven = new Map<string, Set<string>>()
  try {
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const ns = typeof entry.ns === 'string' ? entry.ns : ''
      if (PI_AI_ENTRY.test(ns)) {
        collectPiAiModels(entry.value, { supported, declaredWithoutMap, declaredLevels }, new Set())
      } else if (DEFAULT_MODEL_ENTRY.test(ns)) {
        collectDefaultPairs(entry.value, { supported, proven }, new Set())
      }
    }
    // Applied AFTER both entry kinds are read, so entry order cannot decide the outcome.
    // The pair proves its own level for its model: that may WIDEN a declared map (the
    // running pair is proof the map is incomplete), but it never creates one — a set
    // excludes, and a map-less model's levels are unknown rather than `{default}`.
    for (const [id, levels] of proven) {
      const declared = declaredLevels.get(id)
      if (declared === undefined) continue
      for (const level of levels) declared.add(level)
    }
  } catch {
    // tolerant: an unrecognized shape yields no declarations
  }
  return { supported, declaredWithoutMap, declaredLevels }
}

/** Whether a parse actually declared anything — an empty result judges no model. */
export function isUsableEffortSupport(support: EffortSupport): boolean {
  return support.supported.size + support.declaredWithoutMap.size + support.declaredLevels.size > 0
}

/** A legacy settings document read from disk, with the path for the log line. */
export interface EffortSourceFile {
  readonly path: string
  readonly text: string
}

export interface EffortResolution {
  /** undefined means "nothing judged" — never "everything supported". */
  readonly support?: EffortSupport
  /** Which source produced the verdict, for the log line. */
  readonly source?: string
  /** Every source consulted, in order, whether or not it produced anything. */
  readonly consulted: readonly string[]
}

/**
 * Pick the effort declarations from the first source that actually declares
 * something: the live settings service first (authoritative since DSH moved the
 * document), the legacy `settings.yaml` after it (installs that predate the
 * service). An unparseable or empty source is skipped, not trusted — the failure
 * this guards: a stale document yielding a verdict the deployment no longer holds.
 */
export function resolveEffortSupport(sources: {
  service?: { label: string; entries?: readonly SettingsEntryValue[] }
  files?: readonly EffortSourceFile[]
}): EffortResolution {
  const consulted: string[] = []
  const service = sources.service
  if (service !== undefined) {
    consulted.push(service.label)
    if (service.entries !== undefined && service.entries.length > 0) {
      const support = parseEffortSupportFromEntries(service.entries)
      if (isUsableEffortSupport(support)) return { support, source: service.label, consulted }
    }
  }
  for (const file of sources.files ?? []) {
    consulted.push(file.path)
    const support = parseEffortSupport(file.text)
    if (isUsableEffortSupport(support)) return { support, source: file.path, consulted }
  }
  return { consulted }
}

export interface EffortCheck {
  /** Human-readable warning, when the pair is known-incompatible. */
  readonly warning?: string
  /** true when the check is confident the pair is unsupported. */
  readonly incompatible: boolean
}

/**
 * Whether a pinned effort on this model is DECLARED unsupported. `incompatible` is
 * true only on POSITIVE evidence: the model declares levels, and the pinned one is not
 * among them. Everything else is unknown, and unknown keeps the pin —
 *   - a model outside the effort-validating roots (deepseek, …) is not judged;
 *   - a model with no map at all is not judged either. The pre-2026-09-26 rule flagged
 *     those on the adapter's documented `off`-only reading; the live evidence
 *     contradicted it and the cost was a blanket silent downgrade.
 * A pin that is genuinely refused therefore surfaces as the loud ~41 ms death, which
 * the effort ladder recovers — fast, visible, recoverable.
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
  // No map: UNKNOWN, not unsupported. `declaredWithoutMap` is deliberately NOT
  // consulted here — the adapter may resolve the model through the installed catalog,
  // and a pin dropped on a guess is a silent behaviour change (the operator's standing
  // preference: a loud, recoverable failure beats a quiet downgrade). The bucket is
  // still collected, and `effortSupport()`'s once-only log line reports its size, so
  // the uncertainty stays visible.
  return { incompatible: false }
}
