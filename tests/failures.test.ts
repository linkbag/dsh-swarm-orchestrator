import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RoleConfig, Run, Task } from '../src/domain/types.js'
import { FAST_FAILURE_MS, spawnTaskAgent, type SpawnDeps } from '../src/dispatch/spawn.js'
import { classifyLlmFailure, structuredFailure, type FailureKind } from '../src/failures.js'

type FailureFacts = NonNullable<Parameters<typeof classifyLlmFailure>[0]>
const requestId = (value: string): FailureFacts['requestId'] => value as FailureFacts['requestId']

// No service/profile/store is imported: all child work below is an in-memory
// SpawnDeps fake. Vitest's default global setup supplies an isolated DSH_HOME.
describe('machine-readable failure classification', () => {
  it.each([
    ['ABORTED', 'cancelled'], ['CANCELLED', 'cancelled'], ['CANCELED', 'cancelled'],
    ['AUTHENTICATION', 'permanent'], ['AUTH', 'permanent'], ['UNAUTHORIZED', 'permanent'],
    ['FORBIDDEN', 'permanent'], ['INVALID_API_KEY', 'permanent'],
    // The host LlmFailure contract explicitly distinguishes absent/malformed
    // credentials. Neither should be retried as an unknown provider outage.
    ['MISSING_CREDENTIAL', 'permanent'], ['INVALID_CREDENTIAL', 'permanent'],
    ['CONFIG', 'permanent'], ['INVALID_REQUEST', 'permanent'], ['MODEL_NOT_FOUND', 'permanent'],
    ['PROVIDER_NOT_FOUND', 'permanent'], ['BUDGET_EXHAUSTED', 'permanent'],
    ['UNSUPPORTED_REASONING_EFFORT', 'effort'], ['INVALID_REASONING_EFFORT', 'effort'],
    ['QUOTA', 'quota'], ['PROVIDER_QUOTA_EXCEEDED', 'quota'], ['CREDITS_EXHAUSTED', 'quota'], ['INSUFFICIENT_BALANCE', 'quota'],
    ['RATE_LIMIT', 'transient'], ['SERVER', 'transient'], ['TIMEOUT', 'transient'], ['TRANSPORT', 'transient'],
    ['EMPTY_RESPONSE', 'transient'], ['ECONNRESET', 'transient'], ['ETIMEDOUT', 'transient'],
    ['UNKNOWN', 'unknown'], ['unrecognized-provider-code', 'unknown'],
  ] as const)('classifies code %s as %s without reading diagnostics or elapsed time', (code, kind) => {
    expect(classifyLlmFailure({ code })).toEqual({ kind, code })
  })

  it.each([400, 401, 403, 404, 409, 418, 422, 499])('classifies HTTP %i as permanent when the code is unknown', (status) => {
    expect(classifyLlmFailure({ code: 'PROVIDER_ERROR', status })).toEqual({ kind: 'permanent', code: 'PROVIDER_ERROR', status })
  })

  it.each([429, 500, 502, 503, 504, 599])('classifies HTTP %i as transient when the code is unknown', (status) => {
    expect(classifyLlmFailure({ code: 'PROVIDER_ERROR', status })).toEqual({ kind: 'transient', code: 'PROVIDER_ERROR', status })
  })

  it.each([200, 302, 399, 600])('does not infer transient failure outside the 429/5xx ranges: %i', (status) => {
    expect(classifyLlmFailure({ code: 'PROVIDER_ERROR', status }).kind).toBe('unknown')
  })

  it.each([
    [{ code: 'QUOTA', status: 429 }, 'quota'],
    [{ code: 'CREDITS_EXHAUSTED', status: 503 }, 'quota'],
    [{ code: 'CONFIG', status: 429 }, 'permanent'],
    [{ code: 'INVALID_API_KEY', status: 503 }, 'permanent'],
    [{ code: 'UNSUPPORTED_REASONING_EFFORT', status: 429 }, 'effort'],
    [{ code: 'INVALID_REASONING_EFFORT', status: 400 }, 'effort'],
    [{ code: 'UNSUPPORTED_REASONING_EFFORT', status: 401 }, 'permanent'],
    [{ code: 'QUOTA', status: 403 }, 'permanent'],
    [{ code: 'ABORTED', status: 401 }, 'cancelled'],
  ] satisfies Array<[FailureFacts, FailureKind]>)('applies typed code/status precedence for %j', (failure, kind) => {
    expect(classifyLlmFailure(failure).kind).toBe(kind)
  })

  it('lets explicit cancellation override auth/quota/effort while retaining provider facts', () => {
    for (const code of ['AUTH', 'QUOTA', 'UNSUPPORTED_REASONING_EFFORT']) {
      expect(classifyLlmFailure({ code, status: 403, providerRetryAfterMs: 123, requestId: requestId('request-1') }, true)).toEqual({ kind: 'cancelled', code, status: 403, retryAfterMs: 123, requestId: 'request-1' })
    }
    expect(classifyLlmFailure(undefined)).toEqual({ kind: 'unknown', code: 'UNKNOWN' })
    expect(classifyLlmFailure(undefined, true)).toEqual({ kind: 'cancelled', code: 'UNKNOWN' })
  })

  it.each([[-10, 0], [0, 0], [1250, 1250], [60000, 60000], [60001, 60000], [Number.MAX_SAFE_INTEGER, 60000]])('bounds retry-after %i ms to %i ms', (providerRetryAfterMs, expected) => {
    expect(classifyLlmFailure({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs })).toEqual({ kind: 'transient', code: 'RATE_LIMIT', status: 429, retryAfterMs: expected })
  })

  it('omits absent optional facts and bounds opaque request identifiers', () => {
    const result = classifyLlmFailure({ code: 'SERVER', requestId: requestId('r'.repeat(300)) })
    expect(result).toEqual({ kind: 'transient', code: 'SERVER', requestId: 'r'.repeat(256) })
    expect(Object.hasOwn(result, 'status')).toBe(false)
    expect(Object.hasOwn(result, 'retryAfterMs')).toBe(false)
  })

  it.each([undefined, null, false, 1, 'RATE_LIMIT', {}, { code: 429 }, new Error('AUTH: unsupported reasoning effort')])('ignores untyped thrown values rather than parsing their messages: %j', (value) => {
    expect(structuredFailure(value)).toBeUndefined()
  })

  it('normalizes typed thrown failures and ignores optional fields of the wrong type', () => {
    expect(structuredFailure(Object.assign(new Error('a human message is not the routing key'), { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 90000 }))).toEqual({ kind: 'transient', code: 'RATE_LIMIT', status: 429, retryAfterMs: 60000 })
    expect(structuredFailure({ code: 'RATE_LIMIT', status: '401', providerRetryAfterMs: '1000' })).toEqual({ kind: 'transient', code: 'RATE_LIMIT' })
  })

  it('preserves a bounded request id at the structured thrown-error boundary', () => {
    expect(structuredFailure({ code: 'SERVER', status: 503, providerRetryAfterMs: 25, requestId: 'r'.repeat(300) })).toEqual({ kind: 'transient', code: 'SERVER', status: 503, retryAfterMs: 25, requestId: 'r'.repeat(256) })
  })
})

const role: RoleConfig = { id: 'builder', label: 'Builder', description: 'No live models', reasoningEffort: 'max', fallbacks: [] }
const run: Run = { id: 'failure-run', title: 'Failure fixture', spec: 'Pure spawn tests', status: 'running', createdAt: 1, updatedAt: 1, taskIds: ['build'] }
const task: Task = { id: 'build', runId: run.id, subject: 'Build', description: 'No real child or service', role: role.id, status: 'running', attempts: 1, updatedAt: 1 }
const parent = { id: 'fake-parent' } as Agent
const candidates = [{ provider: 'fake-primary', model: 'model-a' }, { provider: 'fake-fallback', model: 'model-b' }]
const defaults = () => ({ parent, run, task, role, candidates, signal: new AbortController().signal })
type SpawnRequest = Parameters<SpawnDeps['start']>[0]
type Child = Awaited<ReturnType<SpawnDeps['start']>>
type ChildResult = Awaited<Child['result']>
const completed: ChildResult = { stopReason: 'completed', output: [{ type: 'text', text: 'fake success' }] }
const emptyError: ChildResult = { stopReason: 'error', output: [] }

function fakeChildren(respond: (index: number) => ChildResult): { deps: SpawnDeps; calls: SpawnRequest[]; disposed: string[] } {
  const calls: SpawnRequest[] = []
  const disposed: string[] = []
  return {
    calls, disposed,
    deps: { start: async (request) => {
      const index = calls.length
      const id = `child-${index + 1}`
      calls.push(request)
      return { id, result: Promise.resolve().then(() => respond(index)), dispose: async () => { disposed.push(id) } }
    } },
  }
}

const attempted = (calls: SpawnRequest[]) => calls.map((call) => [call.agentOptions?.provider, call.agentOptions?.model, call.agentOptions?.reasoningEffort])

describe('typed spawn failures take precedence over fast-empty timing', () => {
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(1000) })
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    { code: 'AUTH', status: 401 }, { code: 'CONFIG' }, { code: 'QUOTA', status: 429 },
    { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 3210 },
    { code: 'SERVER', status: 503 }, { code: 'CANCELLED' }, { code: 'UNKNOWN' },
  ])('does not lower effort or rotate candidates for typed %j, even in legacy fast-empty mode', async (facts) => {
    const failure = classifyLlmFailure(facts)
    // Both the diagnostic text and instantaneous empty output suggest the old
    // effort heuristic. A typed non-effort failure must defeat BOTH signals.
    const rig = fakeChildren((index) => index === 0 ? { ...emptyError, diagnostic: 'UNSUPPORTED_REASONING_EFFORT' } : completed)
    const fallback = vi.fn()
    const drop = vi.fn()
    const rung = vi.fn()
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), initialEffort: 'max', effortRungs: ['high', undefined], legacyEffortHeuristic: true, failureForChild: () => failure, onFallback: fallback, onDropEffort: drop, onEffortRung: rung })
    expect(result).toMatchObject({ ok: false, stopReason: 'error', failure, provider: 'fake-primary', model: 'model-a', childSessionId: 'child-1' })
    expect(result.failure).toBe(failure)
    expect(attempted(rig.calls)).toEqual([['fake-primary', 'model-a', 'max']])
    expect(rig.disposed).toEqual(['child-1'])
    expect(fallback).not.toHaveBeenCalled()
    expect(drop).not.toHaveBeenCalled()
    expect(rung).not.toHaveBeenCalled()
  })

  it('does not infer an effort mismatch from fast-empty output by default', async () => {
    const rig = fakeChildren((index) => index === 0 ? emptyError : completed)
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), initialEffort: 'max', effortRungs: ['high', undefined] })
    expect(result).toMatchObject({ ok: false, reason: 'child stopped: error' })
    expect(result.failure).toBeUndefined()
    expect(attempted(rig.calls)).toEqual([['fake-primary', 'model-a', 'max']])
    expect(rig.disposed).toEqual(['child-1'])
  })

  it.each([FAST_FAILURE_MS - 1, FAST_FAILURE_MS])('keeps the opt-in legacy boundary deterministic at elapsed %i ms', async (elapsed) => {
    vi.mocked(Date.now).mockReturnValueOnce(1000).mockReturnValue(1000 + elapsed)
    const rig = fakeChildren((index) => index === 0 ? emptyError : completed)
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), initialEffort: 'max', effortRungs: ['high', undefined], legacyEffortHeuristic: true })
    const fast = elapsed < FAST_FAILURE_MS
    expect(result.ok).toBe(fast)
    expect(attempted(rig.calls)).toEqual(fast ? [['fake-primary', 'model-a', 'max'], ['fake-primary', 'model-a', 'high']] : [['fake-primary', 'model-a', 'max']])
    expect(rig.disposed).toEqual(fast ? ['child-1', 'child-2'] : ['child-1'])
  })

  it('bounds legacy heuristic retries by the configured rungs on the same model', async () => {
    const rig = fakeChildren(() => emptyError)
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), initialEffort: 'max', effortRungs: ['high', undefined], legacyEffortHeuristic: true })
    expect(result.ok).toBe(false)
    expect(attempted(rig.calls)).toEqual([['fake-primary', 'model-a', 'max'], ['fake-primary', 'model-a', 'high'], ['fake-primary', 'model-a', undefined]])
    expect(rig.disposed).toEqual(['child-1', 'child-2', 'child-3'])
  })

  it.each(['UNSUPPORTED_REASONING_EFFORT', 'INVALID_REASONING_EFFORT'])('uses typed %s to walk effort rungs even with output and the legacy heuristic disabled', async (code) => {
    const failure = classifyLlmFailure({ code, status: 400 })
    const rig = fakeChildren((index) => index < 2 ? { stopReason: 'error', diagnostic: 'ordinary diagnostic without an effort signature', output: [{ type: 'text', text: 'some work was produced' }] } : completed)
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), initialEffort: 'max', effortRungs: ['high', undefined], legacyEffortHeuristic: false, failureForChild: (id) => id === 'child-3' ? undefined : failure })
    expect(result).toMatchObject({ ok: true, provider: 'fake-primary', model: 'model-a' })
    expect(attempted(rig.calls)).toEqual([['fake-primary', 'model-a', 'max'], ['fake-primary', 'model-a', 'high'], ['fake-primary', 'model-a', undefined]])
    expect(rig.disposed).toEqual(['child-1', 'child-2', 'child-3'])
  })

  it('synthesizes typed cancellation for an aborted empty child instead of retrying effort', async () => {
    const rig = fakeChildren(() => ({ stopReason: 'aborted', output: [] }))
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), effortRungs: ['high', undefined], legacyEffortHeuristic: true })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'cancelled', code: 'UNKNOWN' }, stopReason: 'aborted' })
    expect(rig.calls).toHaveLength(1)
    expect(rig.disposed).toEqual(['child-1'])
  })

  it.each([{ code: 'AUTH', status: 401 }, { code: 'CONFIG' }, { code: 'QUOTA', status: 429 }, { code: 'CANCELLED' }])('honors typed start rejection %j before misleading model-unavailability text', async (facts) => {
    const error = Object.assign(new Error('provider unavailable; model not found; UNSUPPORTED_REASONING_EFFORT'), facts)
    const start = vi.fn<SpawnDeps['start']>(async () => { throw error })
    const fallback = vi.fn()
    const result = await spawnTaskAgent({ start }, { ...defaults(), effortRungs: ['high', undefined], legacyEffortHeuristic: true, onFallback: fallback })
    expect(result).toMatchObject({ ok: false, failure: classifyLlmFailure(facts) })
    expect(start).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('normalizes a typed rejected child result and preserves retry-after without a timing retry', async () => {
    const error = Object.assign(new Error('provider unavailable'), { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 1234 })
    const rig = fakeChildren(() => { throw error })
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), effortRungs: ['high', undefined], legacyEffortHeuristic: true })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'transient', code: 'RATE_LIMIT', status: 429, retryAfterMs: 1234 } })
    expect(rig.calls).toHaveLength(1)
    expect(rig.disposed).toEqual(['child-1'])
  })

  it('prefers the recorded child failure over a rejected result or diagnostic', async () => {
    const failure = classifyLlmFailure({ code: 'AUTH', status: 403 })
    const rig = fakeChildren(() => { throw Object.assign(new Error('UNSUPPORTED_REASONING_EFFORT'), { code: 'TIMEOUT', status: 503 }) })
    const result = await spawnTaskAgent(rig.deps, { ...defaults(), effortRungs: ['high', undefined], legacyEffortHeuristic: true, failureForChild: () => failure })
    expect(result).toMatchObject({ ok: false, failure })
    expect(result.failure).toBe(failure)
    expect(rig.calls).toHaveLength(1)
    expect(rig.disposed).toEqual(['child-1'])
  })
})
