import type { SwarmEventRecord } from './domain/types.js'

/** This is an observation seam, NOT certification of every physical SDK/wire retry. */
export const REQUEST_LEDGER_COVERAGE = 'observed-llm-stream' as const
/** Admission stops rather than discarding old reservations or their audit identities. */
export const REQUEST_LEDGER_MAX_ENTRIES = 100_000

export interface RequestAttribution {
  runId: string
  taskId: string
  attemptId: string
  sessionId: string
  phase: 'build' | 'review' | 'compaction' | 'descendant'
}

export interface RequestBudget {
  mode: 'advisory' | 'hard'
  maxRequests?: number
  maxTokens?: number
  maxCostUsd?: number
}

export interface RequestRoute {
  provider: string
  model: string
  purpose?: string
}

export interface RequestUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface RequestSettlement {
  usage?: RequestUsage
  failure?: { code: string; status?: number; requestId?: string }
  cancelled?: boolean
}

export type RequestLedgerAppend = (kind: string, fields: {
  runId?: string
  taskId?: string
  data: Record<string, unknown>
}) => unknown

type ErrorCode =
  | 'INVALID_BUDGET' | 'INVALID_METADATA' | 'INVALID_USAGE'
  | 'UNSUPPORTED_HARD_BUDGET' | 'OBSERVED_REQUEST_LIMIT' | 'LEDGER_CAPACITY'
  | 'LEDGER_CONFLICT' | 'UNKNOWN_REQUEST' | 'APPEND_UNCERTAIN' | 'LEDGER_POISONED'

const errors: Record<ErrorCode, string> = {
  INVALID_BUDGET: 'invalid request budget',
  INVALID_METADATA: 'request metadata must contain bounded opaque identifiers, not content or credentials',
  INVALID_USAGE: 'invalid reported request usage',
  UNSUPPORTED_HARD_BUDGET: 'hard request/token/cost coverage is not certified; host admission must refuse it',
  OBSERVED_REQUEST_LIMIT: 'observed request reservation limit reached',
  LEDGER_CAPACITY: 'request ledger capacity exhausted; admission requires an explicit archival policy',
  LEDGER_CONFLICT: 'conflicting or stale request ledger transition',
  UNKNOWN_REQUEST: 'unknown request ledger identity',
  APPEND_UNCERTAIN: 'request append outcome uncertain; replay durable events before further admission',
  LEDGER_POISONED: 'request ledger is poisoned; replay durable events before further admission',
}

/** Stable, content-free errors: never includes a provider error, prompt or append exception. */
export class RequestLedgerError extends Error {
  constructor(readonly code: ErrorCode) {
    super(errors[code])
    this.name = 'RequestLedgerError'
  }
}

const fail = (code: ErrorCode): never => { throw new RequestLedgerError(code) }
const budgetKeys = ['mode', 'maxRequests', 'maxTokens', 'maxCostUsd'] as const
const attributionKeys = ['runId', 'taskId', 'attemptId', 'sessionId', 'phase'] as const
const routeKeys = ['provider', 'model', 'purpose'] as const
const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
const settlementKeys = ['usage', 'failure', 'cancelled'] as const
const failureKeys = ['code', 'status', 'requestId'] as const

/** Copy own data properties only; getters, prototypes, symbols and oversized shapes are refused. */
function record(value: unknown, code: ErrorCode, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(code)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return fail(code)
  const keys = Reflect.ownKeys(value)
  if (keys.length > 32) return fail(code)
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key))) return fail(code)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor)) return fail(code)
    result[key] = descriptor.value
  }
  return result
}

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Schema validation only. A valid mode:'hard' is NOT an enforcement capability. */
export function validateRequestBudget(value: unknown): void {
  copyBudget(value)
}

function copyBudget(value: unknown): RequestBudget {
  const item = record(value, 'INVALID_BUDGET', budgetKeys)
  if (item.mode !== 'advisory' && item.mode !== 'hard') return fail('INVALID_BUDGET')
  const result: RequestBudget = { mode: item.mode }
  for (const key of ['maxRequests', 'maxTokens'] as const) {
    if (Object.hasOwn(item, key)) {
      if (!integer(item[key])) return fail('INVALID_BUDGET')
      result[key] = item[key]
    }
  }
  if (Object.hasOwn(item, 'maxCostUsd')) {
    if (typeof item.maxCostUsd !== 'number' || !Number.isFinite(item.maxCostUsd) || item.maxCostUsd < 0 || item.maxCostUsd > Number.MAX_SAFE_INTEGER) return fail('INVALID_BUDGET')
    result.maxCostUsd = item.maxCostUsd
  }
  return result
}

// Labels are metadata atoms, never free text or URLs. Do not truncate identity fields:
// truncation could join two different attempts. Callers must pass trusted opaque IDs.
function metadataToken(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value) && !value.includes('://')
    && !/^(?:sk[-_]|gh[pousr]_|github_pat_|AIza|xox[baprs]-)/i.test(value)
}

function token(value: unknown, max = 128): string {
  return metadataToken(value, max) ? value : fail('INVALID_METADATA')
}

function copyAttribution(value: unknown, strict = false): RequestAttribution {
  const item = record(value, 'INVALID_METADATA', strict ? attributionKeys : undefined)
  const { phase } = item
  if (phase !== 'build' && phase !== 'review' && phase !== 'compaction' && phase !== 'descendant') return fail('INVALID_METADATA')
  return { runId: token(item.runId), taskId: token(item.taskId), attemptId: token(item.attemptId), sessionId: token(item.sessionId), phase }
}

function copyRoute(value: unknown, strict = false): RequestRoute {
  const item = record(value, 'INVALID_METADATA', strict ? routeKeys : undefined)
  return { provider: token(item.provider), model: token(item.model, 256), ...(item.purpose === undefined ? {} : { purpose: token(item.purpose, 64) }) }
}

function copySettlement(value: unknown, strict = false): RequestSettlement {
  const item = record(value, 'INVALID_METADATA', strict ? settlementKeys : undefined)
  const result: RequestSettlement = {}
  if (item.usage !== undefined) {
    const usage = record(item.usage, 'INVALID_USAGE', strict ? usageKeys : undefined)
    if (!integer(usage.inputTokens) || !integer(usage.outputTokens)) return fail('INVALID_USAGE')
    result.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
      if (usage[key] !== undefined) {
        if (!integer(usage[key])) return fail('INVALID_USAGE')
        result.usage[key] = usage[key]
      }
    }
  }
  if (item.failure !== undefined) {
    const failure = record(item.failure, 'INVALID_METADATA', strict ? failureKeys : undefined)
    if (typeof failure.code !== 'string') return fail('INVALID_METADATA')
    const code = metadataToken(failure.code, 64) && /^[A-Za-z][A-Za-z0-9._-]*$/.test(failure.code) ? failure.code : 'unknown'
    result.failure = { code }
    if (failure.status !== undefined) {
      if (!integer(failure.status) || failure.status < 100 || failure.status > 599) return fail('INVALID_METADATA')
      result.failure.status = failure.status
    }
    if (metadataToken(failure.requestId, 128)) result.failure.requestId = failure.requestId
  }
  if (item.cancelled !== undefined && typeof item.cancelled !== 'boolean') return fail('INVALID_METADATA')
  if (item.cancelled === true) result.cancelled = true
  return result
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child)
  return Object.freeze(value)
}

interface Entry {
  id: string
  attribution: RequestAttribution
  route: RequestRoute
  budget: RequestBudget
  state: 'reserved' | 'sent' | 'settled'
  wasSent: boolean
  settlement?: RequestSettlement
}

export interface RequestLedgerSummary {
  runId: string
  coverage: typeof REQUEST_LEDGER_COVERAGE
  physicalWireCoverage: 'not-certified'
  hardBudgetsSupported: false
  persistence: 'consistent' | 'uncertain'
  budget?: RequestBudget
  counts: { total: number; reserved: number; sent: number; settled: number; failed: number; cancelled: number }
  usage: {
    /** Sums of reported buckets only; null if never reported. Cache/reasoning may overlap input/output. */
    known: Record<keyof RequestUsage, number | null>
    reportedRequests: number
    /** Missing optional buckets are not reported zeroes. Overflow is null, never rounded. */
    bucketReports: Record<keyof RequestUsage, number>
    overflowed: boolean
  }
  unresolved: { reservedWithoutUsage: number; sentWithoutUsage: number; settledWithoutUsage: number; requestsWithoutUsage: number }
  /** No prices or provider bills are supplied to this ledger. Even known usage has unknown cost. */
  cost: { usd: null; unknownRequests: number }
}

/**
 * One host-owned, single-writer ledger over the COMPLETE event history supplied by its owner.
 * append must synchronously commit durably or throw, and must not re-enter admission. Returning
 * a Promise/thenable or throwing is ambiguous and poisons this instance. No filesystem, host
 * services, retry engine or tokenMeter is consulted. Reconstruct from authoritative replay after
 * uncertainty; never retry adapter I/O under the same ID. Hidden wire retries are not certified.
 *
 * A run's budget is fixed by its first reservation; omission subsequently inherits it. Advisory
 * maxRequests gates cumulative observed reservations (including cancelled/unknown ones), not
 * physical wire requests. Tokens/cost are advisory only; all hard budgets are refused here and
 * must also be refused by host admission until complete coverage and conservative bounds exist.
 */
export class RequestLedger {
  private readonly entries = new Map<string, Entry>()
  private readonly runs = new Map<string, { budget: RequestBudget; total: number }>()
  private nextOrdinal = 1
  private poisoned = false
  private appending = false

  constructor(events: readonly SwarmEventRecord[], private readonly append: RequestLedgerAppend) {
    if (typeof append !== 'function') fail('INVALID_METADATA')
    let seq = 0
    for (const event of events) {
      if (!event.kind.startsWith('request/')) continue
      if (!integer(event.seq) || event.seq <= seq) fail('LEDGER_CONFLICT')
      seq = event.seq
      this.replay(event)
    }
  }

  reserve(attribution: RequestAttribution, route: RequestRoute, budget?: RequestBudget): string {
    this.assertUsable()
    const owner = copyAttribution(attribution)
    const target = copyRoute(route)
    const limits = this.budgetFor(owner.runId, budget === undefined ? undefined : copyBudget(budget))
    this.checkAdmission(owner.runId, limits)
    const id = `request-${this.nextOrdinal}`
    const entry: Entry = { id, attribution: owner, route: target, budget: limits, state: 'reserved', wasSent: false }
    this.persist('request/reserved', entry, { attribution: owner, route: target, budget: limits })
    this.add(entry)
    this.nextOrdinal++
    return id
  }

  /** Exactly one send authorization per ID. Duplicate sends throw instead of authorizing retry I/O. */
  sent(id: string): void {
    this.assertUsable()
    const entry = this.get(id)
    if (entry.state !== 'reserved') fail('LEDGER_CONFLICT')
    this.persist('request/sent', entry, {})
    entry.state = 'sent'
    entry.wasSent = true
  }

  /** Exact duplicate settlements are no-ops; changed usage/outcomes require audited reconciliation. */
  settle(id: string, settlement: RequestSettlement): void {
    this.assertUsable()
    const entry = this.get(id)
    const result = copySettlement(settlement)
    if (!this.canSettle(entry, result)) return
    this.persist('request/settled', entry, { settlement: result })
    entry.state = 'settled'
    entry.settlement = result
  }

  /** Constant-size, content-free summary; pending replayed reservations are never refunded. */
  summary(runId: string): RequestLedgerSummary {
    token(runId)
    const counts = { total: 0, reserved: 0, sent: 0, settled: 0, failed: 0, cancelled: 0 }
    const sums = { inputTokens: 0n, outputTokens: 0n, cacheReadTokens: 0n, cacheWriteTokens: 0n, reasoningTokens: 0n }
    const bucketReports = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const unresolved = { reservedWithoutUsage: 0, sentWithoutUsage: 0, settledWithoutUsage: 0, requestsWithoutUsage: 0 }
    let reportedRequests = 0
    for (const entry of this.entries.values()) {
      if (entry.attribution.runId !== runId) continue
      counts.total++
      counts[entry.state]++
      if (entry.settlement?.failure) counts.failed++
      if (entry.settlement?.cancelled) counts.cancelled++
      const usage = entry.settlement?.usage
      if (usage) {
        reportedRequests++
        for (const key of usageKeys) if (usage[key] !== undefined) {
          sums[key] += BigInt(usage[key])
          bucketReports[key]++
        }
      } else {
        unresolved.requestsWithoutUsage++
        if (entry.state === 'reserved') unresolved.reservedWithoutUsage++
        else if (entry.state === 'sent') unresolved.sentWithoutUsage++
        else unresolved.settledWithoutUsage++
      }
    }
    const known: Record<keyof RequestUsage, number | null> = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null }
    let overflowed = false
    for (const key of usageKeys) {
      if (sums[key] > BigInt(Number.MAX_SAFE_INTEGER)) { known[key] = null; overflowed = true }
      else if (bucketReports[key] > 0) known[key] = Number(sums[key])
    }
    const run = this.runs.get(runId)
    return {
      runId, coverage: REQUEST_LEDGER_COVERAGE, physicalWireCoverage: 'not-certified', hardBudgetsSupported: false,
      persistence: this.poisoned ? 'uncertain' : 'consistent', ...(run ? { budget: { ...run.budget } } : {}),
      counts, usage: { known, reportedRequests, bucketReports, overflowed }, unresolved,
      cost: { usd: null, unknownRequests: counts.total },
    }
  }

  private assertUsable(): void {
    if (this.appending) { this.poisoned = true; fail('APPEND_UNCERTAIN') }
    if (this.poisoned) fail('LEDGER_POISONED')
  }

  private get(id: string): Entry {
    token(id)
    return this.entries.get(id) ?? fail('UNKNOWN_REQUEST')
  }

  private budgetFor(runId: string, proposed?: RequestBudget): RequestBudget {
    if (proposed?.mode === 'hard') fail('UNSUPPORTED_HARD_BUDGET')
    const current = this.runs.get(runId)?.budget
    if (current && proposed && !equal(current, proposed)) fail('LEDGER_CONFLICT')
    return current ?? proposed ?? { mode: 'advisory' }
  }

  private checkAdmission(runId: string, budget: RequestBudget): void {
    if (this.entries.size >= REQUEST_LEDGER_MAX_ENTRIES || !Number.isSafeInteger(this.nextOrdinal)) fail('LEDGER_CAPACITY')
    if (budget.maxRequests !== undefined && (this.runs.get(runId)?.total ?? 0) >= budget.maxRequests) fail('OBSERVED_REQUEST_LIMIT')
  }

  private add(entry: Entry): void {
    this.entries.set(entry.id, entry)
    const current = this.runs.get(entry.attribution.runId)
    this.runs.set(entry.attribution.runId, { budget: entry.budget, total: (current?.total ?? 0) + 1 })
  }

  private canSettle(entry: Entry, result: RequestSettlement): boolean {
    if (entry.state === 'settled') {
      if (!equal(entry.settlement, result)) fail('LEDGER_CONFLICT')
      return false
    }
    // Pre-send cancellation/failure is recorded, but remains unresolved, not a refund.
    if (!entry.wasSent && (result.usage || (!result.failure && !result.cancelled))) fail('LEDGER_CONFLICT')
    return true
  }

  private persist(kind: string, entry: Entry, rest: Record<string, unknown>): void {
    this.assertUsable()
    this.appending = true
    try {
      const fields = freeze({ runId: entry.attribution.runId, taskId: entry.attribution.taskId,
        data: { version: 1, coverage: REQUEST_LEDGER_COVERAGE, id: entry.id, ...rest } })
      const result = this.append(kind, fields)
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
        // Contain rejection of an accidentally async native callback without invoking an
        // arbitrary thenable. Persistence is still ambiguous and admission must stop.
        try { void Promise.prototype.then.call(result, undefined, () => undefined) } catch { /* not a native Promise */ }
        fail('APPEND_UNCERTAIN')
      }
      if (this.poisoned) fail('APPEND_UNCERTAIN')
    } catch {
      this.poisoned = true
      fail('APPEND_UNCERTAIN')
    } finally {
      this.appending = false
    }
  }

  private replay(event: SwarmEventRecord): void {
    const reserved = event.kind === 'request/reserved'
    const allowed = ['version', 'coverage', 'id', ...(reserved ? ['attribution', 'route', 'budget'] : event.kind === 'request/settled' ? ['settlement'] : [])]
    if (!reserved && event.kind !== 'request/sent' && event.kind !== 'request/settled') fail('LEDGER_CONFLICT')
    const data = record(event.data, 'INVALID_METADATA', allowed)
    if (data.version !== 1 || data.coverage !== REQUEST_LEDGER_COVERAGE) fail('LEDGER_CONFLICT')
    const id = token(data.id)
    const runId = token(event.runId)
    const taskId = token(event.taskId)
    if (reserved) {
      if (!/^request-[1-9][0-9]*$/.test(id)) fail('LEDGER_CONFLICT')
      const ordinal = Number(id.slice('request-'.length))
      if (!integer(ordinal) || `request-${ordinal}` !== id) fail('LEDGER_CONFLICT')
      const attribution = copyAttribution(data.attribution, true)
      const route = copyRoute(data.route, true)
      const budget = this.budgetFor(runId, copyBudget(data.budget))
      if (attribution.runId !== runId || attribution.taskId !== taskId) fail('LEDGER_CONFLICT')
      const existing = this.entries.get(id)
      if (existing) {
        if (!equal([existing.attribution, existing.route, existing.budget], [attribution, route, budget])) fail('LEDGER_CONFLICT')
        return
      }
      this.checkAdmission(runId, budget)
      this.add({ id, attribution: freeze(attribution), route: freeze(route), budget: freeze(budget), state: 'reserved', wasSent: false })
      this.nextOrdinal = Math.max(this.nextOrdinal, ordinal + 1)
      return
    }
    const entry = this.get(id)
    if (entry.attribution.runId !== runId || entry.attribution.taskId !== taskId) fail('LEDGER_CONFLICT')
    if (event.kind === 'request/sent') {
      if (entry.state === 'settled' && !entry.wasSent) fail('LEDGER_CONFLICT')
      if (entry.state === 'reserved') entry.state = 'sent'
      entry.wasSent = true
    } else {
      const settlement = copySettlement(data.settlement, true)
      if (this.canSettle(entry, settlement)) { entry.state = 'settled'; entry.settlement = freeze(settlement) }
    }
  }
}
