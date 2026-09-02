import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

/**
 * Persisted duty table store. Roles are user-editable from the dashboard;
 * model assignment resolves here (primary pin + ordered fallback chain).
 */
export class DutyTableStore {
  private table: DutyTable

  constructor(readonly file: string) {
    this.table = this.load()
  }

  private load(): DutyTable {
    if (!existsSync(this.file)) return defaultDutyTable()
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as DutyTable
      if (parsed.version === 1 && parsed.roles !== undefined && typeof parsed.roles === 'object') {
        return parsed
      }
    } catch {
      // fall through to defaults on corruption
    }
    return defaultDutyTable()
  }

  get(): DutyTable {
    return this.table
  }

  role(id: RoleId): RoleConfig | undefined {
    return this.table.roles[id]
  }

  save(next: DutyTable): DutyTable {
    if (this.table.override?.enabled === true) {
      const clearsLock = next.override?.enabled === false
      if (!clearsLock) {
        throw new Error('duty table is locked by a manual override; a save must explicitly set override.enabled=false to clear it')
      }
    }
    const saved: DutyTable = { ...next, version: 1, updatedAt: Date.now() }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(saved, null, 2), 'utf8')
    this.table = saved
    return saved
  }

  /**
   * Ordered model candidate chain for a role: the pinned primary (when both
   * provider and model are set) followed by the fallback chain. An empty chain
   * means "inherit the deployment default" — the caller then omits agentOptions.
   */
  resolveChain(id: RoleId): ModelRef[] {
    const role = this.table.roles[id]
    if (role === undefined) return []
    const chain: ModelRef[] = []
    if (role.provider !== undefined && role.model !== undefined && role.provider.length > 0 && role.model.length > 0) {
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
