import type { Board, BoardRole, BoardRuntime } from './board-store'
import { RUNTIME_LIMITS, validateRuntimeInteger, type RuntimeKey } from './runtime-limits'

/** Config comparisons ignore object key order and omitted/undefined fields. */
export function configKey(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]))
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

export interface DraftState<T> {
  value: T
  baseline: T
  latest: T
  revision: number
  conflict: boolean
}

export function createDraft<T>(live: T): DraftState<T> {
  return { value: structuredClone(live), baseline: structuredClone(live), latest: structuredClone(live), revision: 0, conflict: false }
}

export function isDirty<T>(state: DraftState<T>): boolean {
  return configKey(state.value) !== configKey(state.baseline)
}

export function editDraft<T>(state: DraftState<T>, value: T): DraftState<T> {
  return { ...state, value, revision: state.revision + 1 }
}

export function receiveLive<T>(state: DraftState<T>, live: T): DraftState<T> {
  const key = configKey(live)
  // BoardStore fences pre-ACK snapshots. Never ignore a real later live value
  // just because its config happens to match the pre-save fingerprint.
  // Once observed, a conflict requires an explicit Keep/Reload decision.
  if (state.conflict) return { ...state, latest: structuredClone(live) }
  if (!isDirty(state) || key === configKey(state.value)) {
    return { ...createDraft(live), revision: state.revision }
  }
  return { ...state, latest: structuredClone(live), conflict: key !== configKey(state.baseline) }
}

/** Keep later edits and observed live changes; this is not server-side CAS. */
export function acceptSaved<T>(state: DraftState<T>, revision: number, saved: T, submittedLive: T = state.latest): DraftState<T> {
  const savedKey = configKey(saved)
  const submittedKey = configKey(submittedLive)
  const latestKey = configKey(state.latest)
  const conflict = latestKey !== savedKey && (state.conflict || latestKey !== submittedKey)
  return {
    ...state,
    value: state.revision === revision && !conflict ? structuredClone(saved) : state.value,
    baseline: structuredClone(saved),
    latest: conflict ? state.latest : structuredClone(saved),
    conflict,
  }
}

export function reloadDraft<T>(state: DraftState<T>): DraftState<T> {
  return { ...createDraft(state.latest), revision: state.revision + 1 }
}

export function keepDraft<T>(state: DraftState<T>): DraftState<T> {
  return { ...state, baseline: structuredClone(state.latest), revision: state.revision + 1, conflict: false }
}

export interface DutyDraft {
  roles: Record<string, BoardRole>
  locked: boolean
  lockNote: string
}

export function dutyDraft(board: Pick<Board, 'roles' | 'override'> | null): DutyDraft {
  const roles: Record<string, BoardRole> = {}
  for (const [id, role] of Object.entries(board?.roles ?? {})) {
    roles[id] = {
      ...role,
      fallbacks: (role.fallbacks ?? []).map((fallback) => ({ ...fallback })),
      ...(role.effortFallbacks !== undefined ? { effortFallbacks: [...role.effortFallbacks] } : {}),
      ...(role.toolFilter !== undefined ? {
        toolFilter: {
          ...(role.toolFilter.allow !== undefined ? { allow: [...role.toolFilter.allow] } : {}),
          ...(role.toolFilter.deny !== undefined ? { deny: [...role.toolFilter.deny] } : {}),
        },
      } : {}),
    }
  }
  return { roles, locked: board?.override?.enabled === true, lockNote: board?.override?.note ?? '' }
}

const RUNTIME_STEPS: Partial<Record<RuntimeKey, number>> = {
  spawnStaggerMs: 250, retryBackoffBaseMs: 1000, circuitBreakerCooldownMs: 5000,
  nudgeAfterMinutes: 5, staleTimeoutSeconds: 600, spawnTimeoutSeconds: 300, evidenceTimeoutMs: 1000,
}
export const RUNTIME_FIELDS = (Object.keys(RUNTIME_LIMITS) as RuntimeKey[]).map((key) => ({
  key, labelKey: `rt.${key}.label`, hintKey: `rt.${key}.hint`,
  min: RUNTIME_LIMITS[key].min, max: RUNTIME_LIMITS[key].max, default: RUNTIME_LIMITS[key].default, step: RUNTIME_STEPS[key] ?? 1,
}))

export function runtimeDraft(runtime?: BoardRuntime): Record<string, string> {
  return Object.fromEntries(RUNTIME_FIELDS.map(({ key }) => [key, runtime?.[key] === undefined ? '' : String(runtime[key])]))
}

/** Never silently drop an invalid entry and report the rest as saved. */
export function parseRuntimeDraft(draft: Record<string, string>): BoardRuntime {
  const runtime: BoardRuntime = {}
  for (const field of RUNTIME_FIELDS) {
    const raw = draft[field.key]?.trim() ?? ''
    if (raw === '') continue
    runtime[field.key] = validateRuntimeInteger(field.key, Number(raw))
  }
  return runtime
}
