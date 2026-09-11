import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** User-tunable runtime parameters, persisted alongside the duty table. */
export interface RuntimeOverrides {
  maxConcurrent?: number
  spawnStaggerMs?: number
  retryBackoffBaseMs?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  nudgeAfterMinutes?: number
  staleTimeoutSeconds?: number
}

const NUMERIC_KEYS = [
  'maxConcurrent', 'spawnStaggerMs', 'retryBackoffBaseMs',
  'circuitBreakerThreshold', 'circuitBreakerCooldownMs',
  'nudgeAfterMinutes', 'staleTimeoutSeconds',
] as const

/**
 * Persisted runtime parameter overrides. Values here win over the profile's
 * YAML config, so users can tune hardening parameters from the dashboard
 * without editing cordis.patch.yml.
 */
export class RuntimeStore {
  private overrides: RuntimeOverrides = {}

  constructor(readonly file: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as RuntimeOverrides
      if (parsed !== null && typeof parsed === 'object') {
        const clean: RuntimeOverrides = {}
        for (const key of NUMERIC_KEYS) {
          const value = parsed[key]
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            clean[key] = value
          }
        }
        this.overrides = clean
      }
    } catch {
      // corruption → fall through to defaults
    }
  }

  get(): RuntimeOverrides {
    return { ...this.overrides }
  }

  save(next: RuntimeOverrides): RuntimeOverrides {
    const clean: RuntimeOverrides = {}
    for (const key of NUMERIC_KEYS) {
      const value = next[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        clean[key] = Math.round(value)
      }
    }
    this.overrides = clean
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(clean, null, 2), 'utf8')
    return { ...clean }
  }
}
