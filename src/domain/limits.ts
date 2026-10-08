/** Integer-only runtime bounds, shared by persisted settings and config validation. */
export const RUNTIME_LIMITS = {
  maxConcurrent: { min: 1, max: 64, default: 50 },
  maxTotalConcurrentAgents: { min: 1, max: 128, default: 100 },
  spawnStaggerMs: { min: 0, max: 60000, default: 750 },
  retryBackoffBaseMs: { min: 0, max: 120000, default: 5000 },
  circuitBreakerThreshold: { min: 0, max: 10, default: 3 },
  circuitBreakerCooldownMs: { min: 1000, max: 600000, default: 60000 },
  nudgeAfterMinutes: { min: 0, max: 240, default: 20 },
  staleTimeoutSeconds: { min: 60, max: 86400, default: 14400 },
  spawnTimeoutSeconds: { min: 0, max: 86400, default: 3600 },
  maxRetries: { min: 0, max: 5, default: 2 },
  reviewLoops: { min: 0, max: 5, default: 3 },
  evidenceTimeoutMs: { min: 1000, max: 600000, default: 120000 },
} as const

export type RuntimeKey = keyof typeof RUNTIME_LIMITS

export function validateRuntimeInteger(key: RuntimeKey, value: unknown): number {
  const { min, max } = RUNTIME_LIMITS[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`)
  }
  return value
}

/** JSON objects only: no arrays, class instances, inherited policy or accessors. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
    'value' in descriptor && descriptor.enumerable === true,
  ) && Object.getOwnPropertySymbols(value).length === 0
}

export function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${JSON.stringify(key)}`)
  }
}

/** Bounds are checked before any graph construction, traversal or service scope checks. */
export const DAG_LIMITS = {
  tasks: 256,
  edges: 4096,
  blockersPerTask: 64,
  idChars: 128,
  subjectChars: 512,
  descriptionChars: 32768,
  totalChars: 1024 * 1024,
  pathsPerTask: 64,
  pathChars: 4096,
  evidenceFiles: 64,
  evidenceCommands: 16,
  commandChars: 8192,
  modelChars: 256,
  errors: 20,
} as const
