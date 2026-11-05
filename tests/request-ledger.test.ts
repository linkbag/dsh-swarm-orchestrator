import { describe, expect, it, vi } from 'vitest'
import type { SwarmEventRecord } from '../src/domain/types.js'
import {
  REQUEST_LEDGER_COVERAGE, RequestLedger, RequestLedgerError, validateRequestBudget,
  type RequestAttribution, type RequestBudget, type RequestLedgerAppend, type RequestSettlement,
} from '../src/request-ledger.js'

// Pure synthetic records only: no provider, service, runtime or filesystem imports.
const owner = (overrides: Partial<RequestAttribution> = {}): RequestAttribution => ({
  runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', sessionId: 'session-1', phase: 'build', ...overrides,
})
const route = { provider: 'test-provider', model: 'test/model:1' }
const usage = { inputTokens: 100, outputTokens: 20 }
function fixture(seed: readonly SwarmEventRecord[] = []) {
  const events = structuredClone([...seed])
  const append = vi.fn<RequestLedgerAppend>((kind, fields) => {
    const event = structuredClone({ seq: events.length + 1, at: 1, kind, ...fields })
    events.push(event)
    return event
  })
  return { events, append, ledger: new RequestLedger(events, append) }
}
function expectCode(action: () => unknown, code: string): void {
  let error: unknown
  try { action() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(RequestLedgerError)
  expect(error).toMatchObject({ code })
}
function finished(settlement: RequestSettlement = { usage }) {
  const test = fixture()
  const id = test.ledger.reserve(owner(), route)
  test.ledger.sent(id)
  test.ledger.settle(id, settlement)
  return { ...test, id }
}
function extend(events: readonly SwarmEventRecord[], event: SwarmEventRecord): SwarmEventRecord[] {
  return [...structuredClone([...events]), { ...structuredClone(event), seq: events.length + 1 }]
}

// Explicit undefined is not valid persisted JSON policy. Zero is a useful deny-all limit.
describe('request budget schema (not enforcement certification)', () => {
  it.each([
    { mode: 'advisory' }, { mode: 'hard' },
    { mode: 'advisory', maxRequests: 0, maxTokens: 0, maxCostUsd: 0 },
    { mode: 'hard', maxRequests: 4, maxTokens: 500, maxCostUsd: 0.25 },
    { mode: 'advisory', maxRequests: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER, maxCostUsd: Number.MAX_SAFE_INTEGER },
    Object.assign(Object.create(null), { mode: 'advisory' }),
  ])('validates a supported schema without mutating it: %j', (value) => {
    const before = JSON.stringify(value)
    expect(() => validateRequestBudget(value)).not.toThrow()
    expect(JSON.stringify(value)).toBe(before)
  })

  it.each([
    undefined, null, false, 1, 'advisory', [], new Date(0), {}, { mode: 'strict' },
    { mode: 'advisory', maxUsd: 1 }, { mode: 'advisory', prompt: 'not metadata' },
    Object.assign(Object.create({ mode: 'advisory' }), { maxRequests: 1 }),
    { mode: 'advisory', [Symbol('unexpected')]: true },
    ...['maxRequests', 'maxTokens'].flatMap((key) => [undefined, null, '1', true, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ mode: 'advisory', [key]: value }))),
    ...[undefined, null, '1', true, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ mode: 'advisory', maxCostUsd: value })),
  ])('refuses invalid, unknown or non-JSON policy: %j', (value) => {
    expectCode(() => validateRequestBudget(value), 'INVALID_BUDGET')
  })

  it('does not evaluate accessors', () => {
    const read = vi.fn(() => 'advisory')
    expectCode(() => validateRequestBudget(Object.defineProperty({}, 'mode', { get: read })), 'INVALID_BUDGET')
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['maxRequests', 'maxTokens', 'maxCostUsd', 'none'] as const)('refuses hard mode before persistence, even for %s only', (key) => {
    const { ledger, append } = fixture()
    const budget: RequestBudget = { mode: 'hard', ...(key === 'none' ? {} : { [key]: 1 }) }
    expectCode(() => ledger.reserve(owner(), route, budget), 'UNSUPPORTED_HARD_BUDGET')
    expect(append).not.toHaveBeenCalled()
    expect(ledger.summary('run-1')).toMatchObject({ counts: { total: 0 }, physicalWireCoverage: 'not-certified', hardBudgetsSupported: false })
  })
})

describe('durable observed-attempt lifecycle', () => {
  it('commits reserve, then sent, then settlement before changing memory or authorizing I/O', () => {
    const test = fixture()
    const normal = test.append.getMockImplementation()!
    const states: unknown[] = []
    test.append.mockImplementation((kind, fields) => {
      states.push(test.ledger.summary('run-1').counts)
      return normal(kind, fields)
    })
    const id = test.ledger.reserve(owner(), route)
    expect(id).toBe('request-1')
    expect(test.events[0]).toMatchObject({ kind: 'request/reserved', runId: 'run-1', taskId: 'task-1', data: {
      version: 1, coverage: REQUEST_LEDGER_COVERAGE, id, attribution: owner(), route, budget: { mode: 'advisory' },
    } })
    const adapter = vi.fn(() => expect(test.events.at(-1)?.kind).toBe('request/sent'))
    test.ledger.sent(id)
    adapter()
    test.ledger.settle(id, { usage })
    expect(adapter).toHaveBeenCalledOnce()
    expect(states).toEqual([
      { total: 0, reserved: 0, sent: 0, settled: 0, failed: 0, cancelled: 0 },
      { total: 1, reserved: 1, sent: 0, settled: 0, failed: 0, cancelled: 0 },
      { total: 1, reserved: 0, sent: 1, settled: 0, failed: 0, cancelled: 0 },
    ])
    expect(test.ledger.summary('run-1')).toMatchObject({ counts: { total: 1, settled: 1 }, usage: { reportedRequests: 1, known: usage }, cost: { usd: null, unknownRequests: 1 } })
  })

  it('mints distinct identities for repeated calls and across replay, routes and task attempts', () => {
    const test = fixture()
    expect(test.ledger.reserve(owner(), route)).toBe('request-1')
    expect(test.ledger.reserve(owner(), { ...route, model: 'fallback' })).toBe('request-2')
    const reopened = new RequestLedger(test.events, test.append)
    expect(reopened.reserve(owner({ attemptId: 'attempt-2' }), route)).toBe('request-3')
    expect(reopened.summary('run-1').unresolved.reservedWithoutUsage).toBe(3)
  })

  it('gates cumulative observed reservations for the entire run, never refunding cancellation or unknown usage', () => {
    const { ledger } = fixture()
    const budget: RequestBudget = { mode: 'advisory', maxRequests: 2, maxTokens: 1, maxCostUsd: 0.01 }
    const first = ledger.reserve(owner(), route, budget)
    ledger.sent(first)
    ledger.settle(first, { usage }) // token/cost limits are advisory, not safe input/output bounds.
    const second = ledger.reserve(owner({ taskId: 'review-task', phase: 'review' }), route)
    ledger.settle(second, { cancelled: true })
    expectCode(() => ledger.reserve(owner({ taskId: 'descendant', phase: 'descendant' }), route), 'OBSERVED_REQUEST_LIMIT')
    expect(ledger.summary('run-1')).toMatchObject({ budget, counts: { total: 2, settled: 2 }, unresolved: { settledWithoutUsage: 1 } })
    expect(ledger.reserve(owner({ runId: 'other-run' }), route, { mode: 'advisory', maxRequests: 1 })).toBe('request-3')
  })

  it('counts build/review/compaction/descendant reservations at the same observed seam', () => {
    const { ledger } = fixture()
    for (const phase of ['build', 'review', 'compaction', 'descendant'] as const) {
      ledger.reserve(owner({ phase }), { ...route, purpose: phase }, { mode: 'advisory', maxRequests: 4 })
    }
    expectCode(() => ledger.reserve(owner(), route), 'OBSERVED_REQUEST_LIMIT')
    expect(ledger.summary('run-1').counts.total).toBe(4)
  })

  it('persists immutable run-level policy, inheriting omission and rejecting policy changes', () => {
    const { ledger, append } = fixture()
    const budget: RequestBudget = { mode: 'advisory', maxRequests: 3, maxTokens: 50 }
    ledger.reserve(owner(), route, budget)
    budget.maxRequests = 99
    ledger.reserve(owner(), route, { maxTokens: 50, maxRequests: 3, mode: 'advisory' })
    expectCode(() => ledger.reserve(owner(), route, budget), 'LEDGER_CONFLICT')
    expectCode(() => ledger.reserve(owner(), route, { mode: 'advisory' }), 'LEDGER_CONFLICT')
    ledger.reserve(owner(), route)
    expectCode(() => ledger.reserve(owner(), route), 'OBSERVED_REQUEST_LIMIT')
    expect(append).toHaveBeenCalledTimes(3)
  })

  it('does not silently introduce a policy after unbounded reservations', () => {
    const { ledger } = fixture()
    ledger.reserve(owner(), route)
    expectCode(() => ledger.reserve(owner(), route, { mode: 'advisory', maxRequests: 1 }), 'LEDGER_CONFLICT')
  })

  it('supports deny-all observed counts without a durable reservation', () => {
    const { ledger, append } = fixture()
    expectCode(() => ledger.reserve(owner(), route, { mode: 'advisory', maxRequests: 0 }), 'OBSERVED_REQUEST_LIMIT')
    expect(append).not.toHaveBeenCalled()
  })

  it('allows exact duplicate settlements but rejects changed usage, cancellation or failure', () => {
    const { ledger, append, id } = finished()
    ledger.settle(id, { usage: { ...usage }, cancelled: false })
    expect(append).toHaveBeenCalledTimes(3)
    for (const settlement of [{ usage: { ...usage, inputTokens: 101 } }, { cancelled: true }, { failure: { code: 'timeout' } }, {}]) {
      expectCode(() => ledger.settle(id, settlement), 'LEDGER_CONFLICT')
    }
    expect(ledger.summary('run-1').usage.known.inputTokens).toBe(100)
  })

  it('does not turn a missing-usage finish into known zero or silently reconcile it later', () => {
    const { ledger, id } = finished({ failure: { code: 'cancelled' }, cancelled: true })
    ledger.settle(id, { failure: { code: 'cancelled' }, cancelled: true })
    expectCode(() => ledger.settle(id, { usage: { inputTokens: 0, outputTokens: 0 }, failure: { code: 'cancelled' }, cancelled: true }), 'LEDGER_CONFLICT')
    expect(ledger.summary('run-1')).toMatchObject({ usage: { reportedRequests: 0 }, unresolved: { settledWithoutUsage: 1, requestsWithoutUsage: 1 }, cost: { usd: null } })
  })

  it('refuses duplicate send authorization, send after cancellation, unknown and pre-send successful usage', () => {
    const { ledger, append } = fixture()
    const id = ledger.reserve(owner(), route)
    expectCode(() => ledger.sent('request-999'), 'UNKNOWN_REQUEST')
    expectCode(() => ledger.settle('request-999', {}), 'UNKNOWN_REQUEST')
    expectCode(() => ledger.settle(id, { usage }), 'LEDGER_CONFLICT')
    expectCode(() => ledger.settle(id, {}), 'LEDGER_CONFLICT')
    ledger.sent(id)
    expectCode(() => ledger.sent(id), 'LEDGER_CONFLICT')
    ledger.settle(id, {})
    expectCode(() => ledger.sent(id), 'LEDGER_CONFLICT')
    const cancelled = ledger.reserve(owner(), route)
    ledger.settle(cancelled, { cancelled: true })
    expectCode(() => ledger.sent(cancelled), 'LEDGER_CONFLICT')
    expect(append).toHaveBeenCalledTimes(5)
  })
})

describe('bounded honest usage and exposure summaries', () => {
  it('separates replayed reserved, sent, failed/cancelled unknown usage and reported zero', () => {
    const test = fixture()
    test.ledger.reserve(owner(), route)
    test.ledger.sent(test.ledger.reserve(owner(), route))
    for (const settlement of [{ cancelled: true }, { failure: { code: 'timeout' } }, { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }]) {
      const id = test.ledger.reserve(owner(), route)
      test.ledger.sent(id)
      test.ledger.settle(id, settlement)
    }
    test.ledger.settle(test.ledger.reserve(owner(), route), { cancelled: true })
    const summary = new RequestLedger(test.events, test.append).summary('run-1')
    expect(summary).toMatchObject({
      coverage: 'observed-llm-stream', physicalWireCoverage: 'not-certified', hardBudgetsSupported: false,
      counts: { total: 6, reserved: 1, sent: 1, settled: 4, failed: 1, cancelled: 2 },
      usage: { reportedRequests: 1, known: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null } },
      unresolved: { reservedWithoutUsage: 1, sentWithoutUsage: 1, settledWithoutUsage: 3, requestsWithoutUsage: 5 },
      cost: { usd: null, unknownRequests: 6 },
    })
  })

  it('reports individual overlapping token buckets without adding caches or reasoning to input/output', () => {
    const { ledger } = fixture()
    for (const usage of [
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 5 },
      { inputTokens: 10, outputTokens: 4, cacheWriteTokens: 3 },
    ]) {
      const id = ledger.reserve(owner(), route)
      ledger.sent(id)
      ledger.settle(id, { usage, failure: { code: 'cancelled' }, cancelled: true })
    }
    expect(ledger.summary('run-1')).toMatchObject({
      counts: { total: 2, failed: 2, cancelled: 2 }, unresolved: { requestsWithoutUsage: 0 },
      usage: { reportedRequests: 2, known: { inputTokens: 110, outputTokens: 24, cacheReadTokens: 80, cacheWriteTokens: 3, reasoningTokens: 5 },
        bucketReports: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1 }, overflowed: false },
      cost: { usd: null, unknownRequests: 2 },
    })
  })

  it('does not round overflowing measured totals or confuse them with zero', () => {
    const { ledger } = fixture()
    for (const inputTokens of [Number.MAX_SAFE_INTEGER, 1]) {
      const id = ledger.reserve(owner(), route)
      ledger.sent(id)
      ledger.settle(id, { usage: { inputTokens, outputTokens: 0 } })
    }
    expect(ledger.summary('run-1')).toMatchObject({ usage: { reportedRequests: 2, known: { inputTokens: null, outputTokens: 0 }, overflowed: true }, unresolved: { requestsWithoutUsage: 0 } })
  })

  it('is constant-size, scoped and detached from internal mutable state', () => {
    const { ledger } = fixture()
    for (let i = 0; i < 500; i++) ledger.reserve(owner(), route, { mode: 'advisory', maxRequests: 501 })
    const summary = ledger.summary('run-1')
    expect(JSON.stringify(summary).length).toBeLessThan(1_600)
    summary.counts.total = 0
    summary.budget!.maxRequests = 9_999
    summary.usage.known.inputTokens = 999
    expect(ledger.summary('run-1')).toMatchObject({ counts: { total: 500 }, budget: { maxRequests: 501 }, usage: { known: { inputTokens: null } } })
    expect(ledger.summary('no-such-run')).toMatchObject({ counts: { total: 0 }, cost: { usd: null, unknownRequests: 0 } })
  })
})

describe('replay identity, idempotence and conflict detection', () => {
  it('replays identical reserved/sent/settled duplicates without rollback or double-counting', () => {
    const { events, ledger } = finished()
    let replay = [...events]
    for (const event of events) replay = extend(replay, event)
    expect(new RequestLedger(replay, vi.fn()).summary('run-1')).toEqual(ledger.summary('run-1'))
  })

  it('ignores unrelated swarm events and performs no append during replay', () => {
    const { events, ledger } = finished()
    const append = vi.fn()
    const unrelated = { seq: 99, at: 1, kind: 'task/completed', data: { arbitrary: 'not ledger metadata' } }
    expect(new RequestLedger([unrelated, ...events], append).summary('run-1')).toEqual(ledger.summary('run-1'))
    expect(append).not.toHaveBeenCalled()
  })

  it.each(['usage', 'failure', 'cancelled'] as const)('detects a conflicting duplicate %s settlement', (key) => {
    const { events } = finished()
    const other = structuredClone(events[2])
    other.data!.settlement = key === 'usage' ? { usage: { ...usage, outputTokens: 21 } } : key === 'failure' ? { failure: { code: 'timeout' } } : { cancelled: true }
    expectCode(() => new RequestLedger(extend(events, other), vi.fn()), 'LEDGER_CONFLICT')
  })

  it.each(['attemptId', 'sessionId', 'phase', 'provider', 'model', 'budget'] as const)('detects conflicting reservation identity/route/policy: %s', (key) => {
    const { events } = finished()
    const other = structuredClone(events[0])
    if (key === 'budget') other.data!.budget = { mode: 'advisory', maxRequests: 5 }
    else if (key === 'provider' || key === 'model') (other.data!.route as Record<string, unknown>)[key] = 'different'
    else (other.data!.attribution as Record<string, unknown>)[key] = key === 'phase' ? 'review' : 'different'
    expectCode(() => new RequestLedger(extend(events, other), vi.fn()), 'LEDGER_CONFLICT')
  })

  it.each(['runId', 'taskId'] as const)('rejects stale or cross-scope settlement envelopes: %s', (key) => {
    const { events } = finished()
    const copy = structuredClone(events)
    copy[2][key] = 'different'
    expectCode(() => new RequestLedger(copy, vi.fn()), 'LEDGER_CONFLICT')
    copy[0][key] = 'different'
    expectCode(() => new RequestLedger(copy, vi.fn()), 'LEDGER_CONFLICT')
  })

  it('refuses an orphan settlement or send rather than inventing an attribution', () => {
    const { events } = finished()
    expectCode(() => new RequestLedger([events[1]], vi.fn()), 'UNKNOWN_REQUEST')
    expectCode(() => new RequestLedger([events[2]], vi.fn()), 'UNKNOWN_REQUEST')
  })

  it('refuses a send after a pre-send terminal cancellation', () => {
    const { ledger, events } = fixture()
    const id = ledger.reserve(owner(), route)
    ledger.settle(id, { cancelled: true })
    const sent = { ...events[1], kind: 'request/sent', data: { version: 1, coverage: REQUEST_LEDGER_COVERAGE, id } }
    expectCode(() => new RequestLedger(extend(events, sent), vi.fn()), 'LEDGER_CONFLICT')
  })

  it.each(['version', 'coverage', 'kind', 'sequence', 'identity'] as const)('refuses unsupported/corrupt ledger semantics: %s', (field) => {
    const { events } = finished()
    const copy = structuredClone(events)
    if (field === 'version') copy[0].data!.version = 2
    if (field === 'coverage') copy[0].data!.coverage = 'all-wire-requests'
    if (field === 'kind') copy[0].kind = 'request/refunded'
    if (field === 'sequence') copy[2].seq = copy[1].seq
    if (field === 'identity') copy[0].data!.id = 'request-01'
    expectCode(() => new RequestLedger(copy, vi.fn()), 'LEDGER_CONFLICT')
  })

  it('rejects replayed hard budgets and impossible observed admission history', () => {
    const { events } = finished()
    const hard = structuredClone(events)
    hard[0].data!.budget = { mode: 'hard', maxRequests: 1 }
    expectCode(() => new RequestLedger(hard, vi.fn()), 'UNSUPPORTED_HARD_BUDGET')
    const impossible = structuredClone(events)
    impossible[0].data!.budget = { mode: 'advisory', maxRequests: 0 }
    expectCode(() => new RequestLedger(impossible, vi.fn()), 'OBSERVED_REQUEST_LIMIT')
  })

  it('fails closed when replay exhausts the safe identity space', () => {
    const { events } = fixture()
    const first = fixture()
    first.ledger.reserve(owner(), route)
    const event = structuredClone(first.events[0])
    event.data!.id = `request-${Number.MAX_SAFE_INTEGER}`
    events.push(event)
    const ledger = new RequestLedger(events, vi.fn())
    expectCode(() => ledger.reserve(owner(), route), 'LEDGER_CAPACITY')
    expect(ledger.summary('run-1').unresolved.reservedWithoutUsage).toBe(1)
  })
})

describe('append uncertainty and fail-closed admission', () => {
  it.each(['reserved', 'sent', 'settled'] as const)('never updates committed memory on a failed %s append, even if the event was persisted', (stage) => {
    const test = fixture()
    let id = 'request-1'
    if (stage !== 'reserved') id = test.ledger.reserve(owner(), route)
    if (stage === 'settled') test.ledger.sent(id)
    const before = test.ledger.summary('run-1')
    const normal = test.append.getMockImplementation()!
    test.append.mockImplementationOnce((kind, fields) => {
      normal(kind, fields) // Simulate durable write followed by an ambiguous lost acknowledgement.
      throw new Error('provider-body-secret-must-not-escape')
    })
    const action = () => stage === 'reserved' ? test.ledger.reserve(owner(), route) : stage === 'sent' ? test.ledger.sent(id) : test.ledger.settle(id, { usage })
    expectCode(action, 'APPEND_UNCERTAIN')
    expect(test.ledger.summary('run-1')).toEqual({ ...before, persistence: 'uncertain' })
    expectCode(() => test.ledger.reserve(owner(), route), 'LEDGER_POISONED')
    expectCode(() => test.ledger.sent(id), 'LEDGER_POISONED')
    expectCode(() => test.ledger.settle(id, { usage }), 'LEDGER_POISONED')
    const replayed = new RequestLedger(test.events, test.append).summary('run-1')
    expect(replayed.persistence).toBe('consistent')
    expect(replayed.counts[stage]).toBe(1)
    expect(JSON.stringify(test.ledger.summary('run-1'))).not.toContain('provider-body-secret')
  })

  it('also poisons definite-looking append failures because the injected API cannot prove rollback', () => {
    const { ledger, append, events } = fixture()
    append.mockImplementationOnce(() => { throw new Error('not persisted') })
    expectCode(() => ledger.reserve(owner(), route), 'APPEND_UNCERTAIN')
    expect(events).toHaveLength(0)
    expect(ledger.summary('run-1')).toMatchObject({ persistence: 'uncertain', counts: { total: 0 } })
    expectCode(() => ledger.reserve(owner(), route), 'LEDGER_POISONED')
  })

  it.each([() => Promise.resolve(), () => Promise.reject(new Error('async failure secret')), () => ({ then() { throw new Error('must not invoke arbitrary thenable') } })])('refuses an asynchronous append result and retains old state', (result) => {
    const { ledger, append } = fixture()
    append.mockImplementationOnce(result)
    expectCode(() => ledger.reserve(owner(), route), 'APPEND_UNCERTAIN')
    expect(ledger.summary('run-1')).toMatchObject({ persistence: 'uncertain', counts: { total: 0 } })
    expectCode(() => ledger.reserve(owner(), route), 'LEDGER_POISONED')
  })

  it('contains swallowed synchronous re-entry and refuses the outer commit too', () => {
    const test = fixture()
    const normal = test.append.getMockImplementation()!
    test.append.mockImplementationOnce((kind, fields) => {
      expectCode(() => test.ledger.reserve(owner(), route), 'APPEND_UNCERTAIN')
      return normal(kind, fields)
    })
    expectCode(() => test.ledger.reserve(owner(), route), 'APPEND_UNCERTAIN')
    expect(test.ledger.summary('run-1')).toMatchObject({ persistence: 'uncertain', counts: { total: 0 } })
    expect(new RequestLedger(test.events, vi.fn()).summary('run-1').counts.reserved).toBe(1)
  })

  it('does not call an adapter if durable send fails', () => {
    const { ledger, append } = fixture()
    const id = ledger.reserve(owner(), route)
    const adapter = vi.fn()
    append.mockImplementationOnce(() => { throw new Error('disk failure') })
    expectCode(() => { ledger.sent(id); adapter() }, 'APPEND_UNCERTAIN')
    expect(adapter).not.toHaveBeenCalled()
    expect(ledger.summary('run-1').unresolved.reservedWithoutUsage).toBe(1)
  })
})

describe('bounded metadata sanitation', () => {
  it('persists only whitelisted metadata, excluding prompt, credentials, full errors and overlapping totalTokens', () => {
    const { ledger, events } = fixture()
    const secret = 'THIS IS CONTENT AND A CREDENTIAL: sk-secret'
    const noisyOwner = { ...owner(), prompt: secret }
    const noisyRoute = { ...route, apiKey: secret, system: secret, messages: [{ content: secret }] }
    const id = ledger.reserve(noisyOwner, noisyRoute)
    ledger.sent(id)
    ledger.settle(id, {
      usage: { ...usage, totalTokens: 999, prompt: secret },
      failure: { code: 'rate-limit', status: 429, requestId: 'req-1', message: secret, headers: { authorization: secret } },
      prompt: secret,
    } as RequestSettlement)
    const raw = JSON.stringify(events)
    expect(raw).not.toContain(secret)
    expect(raw).not.toMatch(/prompt|apiKey|system|messages|headers|authorization|totalTokens/)
    expect(events[2].data!.settlement).toEqual({ usage, failure: { code: 'rate-limit', status: 429, requestId: 'req-1' } })
  })

  it('uses an unknown code and omits unsafe provider request identifiers instead of saving free text', () => {
    const { ledger, events } = fixture()
    const id = ledger.reserve(owner(), route)
    ledger.sent(id)
    ledger.settle(id, { failure: { code: 'Bearer sk-secret full error text', requestId: 'https://provider/error?api_key=secret' } })
    expect(events[2].data!.settlement).toEqual({ failure: { code: 'unknown' } })
  })

  it.each([
    { attribution: owner({ runId: 'x'.repeat(129) }), route },
    { attribution: owner({ attemptId: 'has whitespace' }), route },
    { attribution: owner({ sessionId: 'sk-secret' }), route },
    { attribution: owner(), route: { ...route, provider: 'x'.repeat(129) } },
    { attribution: owner(), route: { ...route, provider: 'https://provider' } },
    { attribution: owner(), route: { ...route, model: 'x'.repeat(257) } },
    { attribution: owner(), route: { ...route, purpose: 'x'.repeat(65) } },
    { attribution: owner(), route: { ...route, purpose: 'full prompt text' } },
  ])('refuses unsafe or oversized identity metadata without truncating or appending: %j', (input) => {
    const { ledger, append } = fixture()
    expectCode(() => ledger.reserve(input.attribution, input.route), 'INVALID_METADATA')
    expect(append).not.toHaveBeenCalled()
  })

  it.each([
    {}, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.1, outputTokens: 0 },
    { inputTokens: 0, outputTokens: Infinity }, { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
    ...['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].map((key) => ({ ...usage, [key]: NaN })),
  ])('refuses malformed usage without poisoning the ledger or settling: %j', (reported) => {
    const { ledger, append } = fixture()
    const id = ledger.reserve(owner(), route)
    ledger.sent(id)
    expectCode(() => ledger.settle(id, { usage: reported } as RequestSettlement), 'INVALID_USAGE')
    expect(append).toHaveBeenCalledTimes(2)
    expect(ledger.summary('run-1')).toMatchObject({ persistence: 'consistent', counts: { sent: 1 } })
    ledger.settle(id, { usage })
  })

  it('refuses accessors without evaluating or persisting them, and rejects unknown replay metadata', () => {
    const { ledger, append } = fixture()
    const read = vi.fn(() => 'test-provider')
    const target = Object.defineProperty({ model: 'model' }, 'provider', { get: read })
    expectCode(() => ledger.reserve(owner(), target as typeof route), 'INVALID_METADATA')
    expect(read).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    const { events } = finished()
    events[0].data!.prompt = 'not ledger data'
    expectCode(() => new RequestLedger(events, vi.fn()), 'INVALID_METADATA')
  })

  it('freezes append metadata and copies caller/summary objects so neither can change ledger identity', () => {
    const test = fixture()
    const normal = test.append.getMockImplementation()!
    test.append.mockImplementation((kind, fields) => {
      expect(Object.isFrozen(fields)).toBe(true)
      expect(Object.isFrozen(fields.data)).toBe(true)
      if (fields.data.attribution) expect(Object.isFrozen(fields.data.attribution)).toBe(true)
      return normal(kind, fields)
    })
    const attribution = owner()
    const target = { ...route }
    const id = test.ledger.reserve(attribution, target)
    attribution.runId = 'changed'
    target.model = 'changed'
    test.ledger.sent(id)
    expect(test.events[1]).toMatchObject({ runId: 'run-1', taskId: 'task-1' })
    expect(test.ledger.summary('run-1').counts.total).toBe(1)
  })
})
