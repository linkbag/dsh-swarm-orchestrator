import { assertAllowedKeys, isPlainRecord } from './domain/limits.js'

export interface TaskPolicy {
  version: 1
  evidence: 'advisory' | 'required'
  review: 'off' | 'warn' | 'strict'
  isolation: 'advisory' | 'strict'
}

export type TaskPolicyOverride = Partial<Omit<TaskPolicy, 'version'>>
export const DEFAULT_POLICY: Readonly<TaskPolicy> = Object.freeze({ version: 1, evidence: 'advisory', review: 'warn', isolation: 'advisory' })

export function validatePolicy(value: unknown, override = false): void {
  if (!isPlainRecord(value)) throw new Error('policy must be a plain object')
  assertAllowedKeys(value, override ? ['evidence', 'review', 'isolation'] : ['version', 'evidence', 'review', 'isolation'], 'policy')
  if (!override && value.version !== 1) throw new Error('unsupported policy version')
  for (const [key, allowed] of Object.entries({ evidence: ['advisory', 'required'], review: ['off', 'warn', 'strict'], isolation: ['advisory', 'strict'] })) {
    if (value[key] !== undefined && !allowed.includes(value[key] as string)) throw new Error('invalid policy.' + key)
  }
}

export function taskPolicy(run: { policy?: TaskPolicy }, task?: { policy?: TaskPolicyOverride }): TaskPolicy {
  const base = { ...DEFAULT_POLICY, ...run.policy }
  const merged = { ...base, ...task?.policy }
  // New run policy is a floor, not a suggestion that a task may downgrade.
  if (run.policy !== undefined) {
    if (base.evidence === 'required') merged.evidence = 'required'
    if (base.isolation === 'strict') merged.isolation = 'strict'
    if (base.review === 'strict' || base.review === 'warn' && merged.review === 'off') merged.review = base.review
  }
  return merged
}
