import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertAllowedKeys, isPlainRecord, validateRuntimeInteger } from './limits.js'
import type { DutyTable, ModelRef, RoleConfig, RoleId } from './types.js'

export const BUILTIN_ROLE_IDS = ['architect', 'builder', 'reviewer', 'integrator'] as const

/** Shipped duty table: four roles, no pinned models (inherit the deployment default until edited). */
export function defaultDutyTable(): DutyTable {
  const role = (
    id: RoleId, label: string, description: string, persona: string,
  ): RoleConfig => ({ id, label, description, fallbacks: [], persona })
  return {
    version: 1,
    updatedAt: Date.now(),
    roles: {
      architect: role(
        'architect', 'Architect', 'Decomposes work into a parallel task DAG with clear scopes.',
        'You are the Architect of an agent swarm. You decompose requirements into independent, well-scoped tasks with explicit dependencies. You never implement code yourself; you define task boundaries, acceptance criteria, and the integration order.',
      ),
      builder: role(
        'builder', 'Builder', 'Implements exactly one task to completion with its own verification.',
        'You are a Builder agent in a swarm. You implement exactly the one task you are given, completely and verifiably: read the workspace, write the code, run the checks, and finish with a concise summary of what changed and how it was verified. Stay strictly inside your task scope; other agents own everything else.',
      ),
      reviewer: role(
        'reviewer', 'Reviewer', 'Reviews completed work against acceptance criteria and reports findings.',
        'You are a Reviewer agent in a swarm. You examine the work produced for one task against its stated scope and quality bar, verify claims by reading the actual code (never trust the summary alone), and report concrete findings: what is correct, what is missing, what must change.',
      ),
      integrator: role(
        'integrator', 'Integrator', 'Merges completed parallel work into a coherent whole and verifies the result.',
        'You are the Integrator agent of a swarm. After parallel builders finish, you reconcile their combined changes into one coherent result: resolve overlaps, fix seams between tasks, run the full verification, and report the final state.',
      ),
    },
  }
}

const ROLE_KEYS = [
  'id', 'label', 'description', 'provider', 'model', 'maxTokens', 'reasoningEffort',
  'effortFallbacks', 'toolFilter', 'maxConcurrent', 'spawnTimeoutSeconds', 'fallbacks', 'persona',
]
const SAFE_ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])

function text(value: unknown, label: string, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (nonempty && value.trim().length === 0)) {
    throw new Error(`${label} must be ${nonempty ? 'non-empty and ' : ''}at most ${max} characters without NUL`)
  }
  return value
}

function strings(value: unknown, label: string, count: number, chars: number, nonemptyList = false): string[] {
  if (!Array.isArray(value) || value.length > count || (nonemptyList && value.length === 0)) {
    throw new Error(`${label} must contain ${nonemptyList ? '1' : '0'}..${count} strings`)
  }
  const clean = value.map((entry) => text(entry, label, chars, true))
  if (new Set(clean).size !== clean.length) throw new Error(`${label} must not contain duplicate entries`)
  return clean
}

function modelRef(value: unknown, label: string): ModelRef {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`)
  assertAllowedKeys(value, ['provider', 'model', 'reasoningEffort'], label)
  const model: ModelRef = {
    provider: text(value.provider, `${label}.provider`, 256, true),
    model: text(value.model, `${label}.model`, 256, true),
  }
  if (value.reasoningEffort !== undefined) model.reasoningEffort = text(value.reasoningEffort, `${label}.reasoningEffort`, 64)
  return model
}

/** The same strict validator is used for incoming writes and legacy disk data. */
export function validateDutyTable(value: unknown): DutyTable {
  if (!isPlainRecord(value)) throw new Error('duty table must be a plain object')
  assertAllowedKeys(value, ['version', 'updatedAt', 'override', 'roles'], 'duty table')
  if (value.version !== 1) throw new Error('duty table version must be 1')
  if (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0) throw new Error('duty table updatedAt must be a non-negative integer')
  if (!isPlainRecord(value.roles)) throw new Error('duty table roles must be a plain object')
  const entries = Object.entries(value.roles)
  if (entries.length === 0 || entries.length > 64) throw new Error('duty table must have 1..64 roles')
  const roles: Record<string, RoleConfig> = Object.create(null)
  for (const [id, input] of entries) {
    if (!SAFE_ROLE_ID.test(id) || RESERVED_IDS.has(id)) throw new Error(`unsafe role id ${JSON.stringify(id)}`)
    if (!isPlainRecord(input)) throw new Error(`role ${id} must be a plain object`)
    assertAllowedKeys(input, ROLE_KEYS, `role ${id}`)
    if (input.id !== id) throw new Error(`role ${id} has mismatched id`)
    if (!Array.isArray(input.fallbacks) || input.fallbacks.length > 16) throw new Error(`role ${id} needs at most 16 fallbacks`)
    const role: RoleConfig = {
      id,
      label: text(input.label, `role ${id} label`, 256, true),
      description: text(input.description, `role ${id} description`, 4096),
      fallbacks: input.fallbacks.map((entry) => modelRef(entry, `role ${id} fallback`)),
    }
    for (const key of ['provider', 'model', 'reasoningEffort', 'persona'] as const) {
      if (input[key] !== undefined) role[key] = text(input[key], `role ${id} ${key}`, key === 'persona' ? 32768 : key === 'reasoningEffort' ? 64 : 256)
    }
    if ((role.provider?.trim().length ?? 0) > 0 !== ((role.model?.trim().length ?? 0) > 0)) {
      throw new Error(`role ${id} provider and model must both be pinned or both inherit`)
    }
    if (input.maxTokens !== undefined) {
      if (typeof input.maxTokens !== 'number' || !Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 262144) {
        throw new Error(`role ${id} maxTokens must be an integer from 1 to 262144`)
      }
      role.maxTokens = input.maxTokens
    }
    for (const key of ['maxConcurrent', 'spawnTimeoutSeconds'] as const) {
      if (input[key] !== undefined) role[key] = validateRuntimeInteger(key, input[key])
    }
    if (input.effortFallbacks !== undefined) role.effortFallbacks = strings(input.effortFallbacks, `role ${id} effortFallbacks`, 16, 64)
    if (input.toolFilter !== undefined) {
      if (!isPlainRecord(input.toolFilter)) throw new Error(`role ${id} toolFilter must be a plain object`)
      assertAllowedKeys(input.toolFilter, ['deny', 'allow'], `role ${id} toolFilter`)
      if (input.toolFilter.deny === undefined && input.toolFilter.allow === undefined) throw new Error(`role ${id} toolFilter must explicitly restrict tools; omit it to inherit`)
      const filter: NonNullable<RoleConfig['toolFilter']> = {}
      for (const key of ['deny', 'allow'] as const) {
        if (input.toolFilter[key] !== undefined) filter[key] = strings(input.toolFilter[key], `role ${id} toolFilter.${key}`, 256, 128, true)
      }
      role.toolFilter = filter
    }
    roles[id] = role
  }
  const table: DutyTable = { version: 1, updatedAt: value.updatedAt as number, roles }
  if (value.override !== undefined) {
    if (!isPlainRecord(value.override)) throw new Error('duty table override must be a plain object')
    assertAllowedKeys(value.override, ['enabled', 'note', 'setBy', 'at'], 'duty table override')
    if (typeof value.override.enabled !== 'boolean' || !Number.isSafeInteger(value.override.at) || (value.override.at as number) < 0) {
      throw new Error('duty table override needs a boolean enabled and non-negative integer at')
    }
    table.override = { enabled: value.override.enabled, at: value.override.at as number }
    for (const key of ['note', 'setBy'] as const) {
      if (value.override[key] !== undefined) table.override[key] = text(value.override[key], `duty table override ${key}`, key === 'note' ? 4096 : 256)
    }
  }
  return table
}

/** File-content fsync before same-directory atomic rename; one settings writer. */
function persist(file: string, table: DutyTable): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(table, null, 2) + '\n', 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/**
 * Persisted duty table store. Invalid legacy policy is surfaced, not replaced
 * by permissive default roles. Returned snapshots cannot mutate active policy.
 */
export class DutyTableStore {
  private table: DutyTable

  constructor(readonly file: string) {
    this.table = this.load()
  }

  private load(): DutyTable {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultDutyTable()
      throw new Error(`cannot read duty table ${this.file}: ${String(error)}`, { cause: error })
    }
    try {
      return validateDutyTable(JSON.parse(raw))
    } catch (error) {
      throw new Error(`invalid duty table ${this.file}: ${String(error)}`, { cause: error })
    }
  }

  get(): DutyTable {
    return structuredClone(this.table)
  }

  role(id: RoleId): RoleConfig | undefined {
    if (!Object.hasOwn(this.table.roles, id)) return undefined
    return structuredClone(this.table.roles[id])
  }

  save(next: DutyTable): DutyTable {
    const saved = validateDutyTable(next)
    if (this.table.override?.enabled === true && saved.override?.enabled !== false) {
      throw new Error('duty table is locked by a manual override; a save must explicitly set override.enabled=false to clear it')
    }
    saved.updatedAt = Date.now()
    persist(this.file, saved)
    this.table = saved
    return this.get()
  }

  /**
   * Ordered model candidate chain for a role: the pinned primary (when both
   * provider and model are set) followed by the fallback chain. An empty chain
   * means "inherit the deployment default" — the caller then omits agentOptions.
   */
  resolveChain(id: RoleId): ModelRef[] {
    const role = this.role(id)
    if (role === undefined) return []
    const chain: ModelRef[] = []
    if (role.provider !== undefined && role.model !== undefined && role.provider.trim().length > 0 && role.model.trim().length > 0) {
      const primary: ModelRef = { provider: role.provider, model: role.model }
      if (role.reasoningEffort !== undefined) primary.reasoningEffort = role.reasoningEffort
      chain.push(primary)
    }
    for (const fallback of role.fallbacks ?? []) {
      if (fallback.provider.length > 0 && fallback.model.length > 0) chain.push(fallback)
    }
    return chain
  }
}
