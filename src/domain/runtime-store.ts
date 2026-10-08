import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertAllowedKeys, isPlainRecord, RUNTIME_LIMITS, validateRuntimeInteger, type RuntimeKey } from './limits.js'

/** User-tunable runtime parameters, persisted alongside the duty table. */
export type RuntimeOverrides = Partial<Record<RuntimeKey, number>>

/** Strict on both save and load: a bad override must never turn into a wider policy. */
export function validateRuntimeOverrides(value: unknown): RuntimeOverrides {
  if (!isPlainRecord(value)) throw new Error('runtime overrides must be a plain object')
  assertAllowedKeys(value, Object.keys(RUNTIME_LIMITS), 'runtime overrides')
  const clean: RuntimeOverrides = {}
  for (const key of Object.keys(value) as RuntimeKey[]) {
    clean[key] = validateRuntimeInteger(key, value[key])
  }
  return clean
}

/**
 * Write a validated settings snapshot via a same-directory temporary file.
 * fsync makes file contents durable before rename; directory-entry durability
 * after sudden power loss remains filesystem/platform dependent. Single writer.
 */
function persist(file: string, value: RuntimeOverrides): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8')
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
 * Persisted runtime overrides win over YAML. Invalid legacy settings visibly
 * disable loading rather than silently dropping a restrictive value and falling
 * back to a potentially wider deployment default. No repair is performed here.
 */
export class RuntimeStore {
  private overrides: RuntimeOverrides = {}

  constructor(readonly file: string) {
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`cannot read runtime overrides ${this.file}: ${String(error)}`, { cause: error })
    }
    try {
      this.overrides = validateRuntimeOverrides(JSON.parse(raw))
    } catch (error) {
      throw new Error(`invalid runtime overrides ${this.file}: ${String(error)}`, { cause: error })
    }
  }

  get(): RuntimeOverrides {
    return { ...this.overrides }
  }

  save(next: RuntimeOverrides): RuntimeOverrides {
    const clean = validateRuntimeOverrides(next)
    persist(this.file, clean)
    this.overrides = clean
    return this.get()
  }
}
