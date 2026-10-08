import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardStore, type Board, type BoardSyncState } from '../client/board-store.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Fake transport deliberately ignores AbortSignal: ownership must still reject
// late network/body results after stop/restart, not merely trust cancellation.
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  close(): void { this.closed = true }
  frame(seq: unknown): void { this.onmessage?.({ data: JSON.stringify({ seq }) } as MessageEvent<string>) }
}

interface Request { url: string; init?: RequestInit; reply: Deferred<Response> }
let requests: Request[]
let stores: BoardStore[]
function makeStore(): BoardStore {
  const store = new BoardStore()
  stores.push(store)
  return store
}
function board(seq: number, patch: Partial<Board> = {}): Board {
  return { service: 'swarm', version: '0.6.30', seq, at: seq * 1000, runs: [], tasks: [], roles: {}, ...patch }
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }
async function reply(index: number, value: unknown, status = 200): Promise<void> {
  requests[index].reply.resolve(response(value, status))
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  stores = []
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    const pending = { url, init, reply: deferred<Response>() }
    requests.push(pending)
    return pending.reply.promise
  }))
})
afterEach(() => {
  for (const store of stores) store.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shared board transport ownership', () => {
  it('shares one stream and fetch across consumers; double release is harmless', () => {
    const store = makeStore()
    const first = store.retain()
    const second = store.retain()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/swarm/events')
    expect(requests).toHaveLength(1)
    first(); first()
    expect(FakeEventSource.instances[0].closed).toBe(false)
    expect(requests[0].init?.signal?.aborted).toBe(false)
    second()
    expect(FakeEventSource.instances[0].closed).toBe(true)
    expect(requests[0].init?.signal?.aborted).toBe(true)
    expect(store.getSyncState()).toBe('stopped')
  })

  it('serializes bursts and follows the highest observed SSE sequence through gaps', async () => {
    const store = makeStore()
    store.retain()
    const stream = FakeEventSource.instances[0]
    stream.frame(17); stream.frame(12); stream.frame(17)
    store.refresh(); store.refresh()
    expect(requests).toHaveLength(1)
    await reply(0, board(10))
    expect(store.get()?.seq).toBe(10)
    expect(store.getSyncState()).toBe('catching-up')
    await vi.advanceTimersByTimeAsync(149)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveLength(2)
    stream.frame(18); stream.frame(18)
    expect(requests).toHaveLength(2)
    await reply(1, board(17))
    await vi.advanceTimersByTimeAsync(150)
    expect(requests).toHaveLength(3)
    await reply(2, board(18))
    stream.frame(18); stream.frame(16)
    await vi.advanceTimersByTimeAsync(150)
    expect(requests).toHaveLength(3)
    expect(store.get()?.seq).toBe(18)
  })

  it('debounces normal events but immediately resynchronizes a sequence gap', async () => {
    const store = makeStore()
    store.retain()
    await reply(0, board(3))
    const stream = FakeEventSource.instances[0]
    stream.frame(4); stream.frame(4)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(150)
    await reply(1, board(4))
    stream.frame(8)
    expect(requests).toHaveLength(3)
    await reply(2, board(8))
  })

  it('ignores invalid SSE sequence numbers', async () => {
    const store = makeStore()
    store.retain()
    await reply(0, board(3))
    const stream = FakeEventSource.instances[0]
    for (const seq of [-1, 3.5, Number.MAX_SAFE_INTEGER + 1, '99', null]) stream.frame(seq)
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(1)
    expect(store.get()?.seq).toBe(3)
  })

  it.each(['success', 'failure'] as const)('rejects an old lifetime body %s without clearing the new fetch', async (outcome) => {
    const store = makeStore()
    const observed: Array<{ error: string | null; sync: BoardSyncState }> = []
    store.subscribe((_board, error, sync) => { observed.push({ error, sync }) })
    const release = store.retain()
    const staleBody = deferred<Board>()
    requests[0].reply.resolve({ ok: true, json: () => staleBody.promise } as Response)
    await flush()
    const oldStream = FakeEventSource.instances[0]
    release()
    store.retain()
    expect(requests).toHaveLength(2)
    await reply(1, board(20))
    store.refresh()
    expect(requests).toHaveLength(3)
    const notifications = observed.length
    if (outcome === 'success') staleBody.resolve(board(99))
    else staleBody.reject(new Error('late body failure'))
    oldStream.onopen?.(); oldStream.onerror?.(); oldStream.frame(100)
    await flush()
    expect(observed).toHaveLength(notifications)
    expect(store.get()?.seq).toBe(20)
    // The stale finally cannot clear this pending new-lifetime request.
    store.refresh()
    expect(requests).toHaveLength(3)
    await reply(2, board(21))
    expect(observed.at(-1)?.error).toBeNull()
    expect(store.get()?.seq).toBe(21)
  })

  it('publishes stopped state and cancels queued refreshes on last release', async () => {
    const store = makeStore()
    const states: BoardSyncState[] = []
    store.subscribe((_board, _error, sync) => { states.push(sync) })
    const release = store.retain()
    await reply(0, board(1))
    FakeEventSource.instances[0].frame(2)
    release()
    await vi.advanceTimersByTimeAsync(10000)
    expect(requests).toHaveLength(1)
    expect(states.at(-1)).toBe('stopped')
  })
})

describe('monotonic snapshots and independent error channels', () => {
  it.each([
    { seq: 4, at: 5000 },
    { seq: 5, at: 4000 },
  ])('keeps the last good snapshot when a later fetch returns stale $seq/$at', async (stale) => {
    const store = makeStore()
    let error: string | null = null
    store.subscribe((_board, next) => { error = next })
    store.retain()
    await reply(0, board(5))
    const good = store.get()
    store.refresh()
    await reply(1, board(stale.seq, { at: stale.at }))
    expect(store.get()).toBe(good)
    expect(error).toBe('stale board snapshot — retrying')
    await vi.advanceTimersByTimeAsync(3000)
    await reply(2, board(6))
    expect(error).toBeNull()
    expect(store.get()?.seq).toBe(6)
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12'])('refuses invalid snapshot sequence %s', async (seq) => {
    const store = makeStore()
    let error: string | null = null
    store.subscribe((_board, next) => { error = next })
    store.retain()
    await reply(0, { ...board(1), seq })
    expect(store.get()).toBeNull()
    expect(error).toBe('invalid board snapshot')
  })

  it('a stream reconnect cannot erase a failed snapshot; only a successful fetch does', async () => {
    const store = makeStore()
    let error: string | null = null
    store.subscribe((_board, next) => { error = next })
    store.retain()
    await reply(0, board(3))
    const stream = FakeEventSource.instances[0]
    stream.onerror?.()
    store.refresh()
    requests[1].reply.reject(new Error('snapshot down'))
    await flush()
    expect(error).toBe('snapshot down')
    expect(store.get()?.seq).toBe(3)
    stream.onopen?.()
    expect(error).toBe('snapshot down')
    await reply(2, board(4))
    expect(error).toBeNull()
    expect(store.getSyncState()).toBe('live')
  })

  it('a successful snapshot cannot erase a disconnected-stream warning', async () => {
    const store = makeStore()
    let error: string | null = null
    store.subscribe((_board, next) => { error = next })
    store.retain()
    const stream = FakeEventSource.instances[0]
    stream.onerror?.()
    await reply(0, board(3))
    expect(error).toContain('stream disconnected')
    expect(store.getSyncState()).toBe('reconnecting')
    stream.onopen?.()
    await reply(1, board(4))
    expect(error).toBeNull()
  })

  it('retains snapshot access when constructing the stream throws', async () => {
    vi.stubGlobal('EventSource', class { constructor() { throw new Error('blocked stream') } })
    const store = makeStore()
    let error: string | null = null
    store.subscribe((_board, next) => { error = next })
    expect(() => store.retain()).not.toThrow()
    await reply(0, board(3))
    expect(store.get()?.seq).toBe(3)
    expect(store.getSyncState()).toBe('snapshot')
    expect(error).toContain('live stream unavailable')
  })

  it.each(['success', 'failure'] as const)('fences a pre-mutation snapshot %s after a successful action ACK', async (outcome) => {
    const store = makeStore()
    let error: string | null = null
    store.subscribe((_board, next) => { error = next })
    store.retain()
    await reply(0, board(3, { runtime: { maxConcurrent: 2 } }))
    store.refresh()
    const action = store.action({ action: 'set-runtime', runtime: { maxConcurrent: 7 } })
    await reply(2, { ok: true, runtime: { maxConcurrent: 7 } })
    await action
    if (outcome === 'success') await reply(1, board(3, { runtime: { maxConcurrent: 2 } }))
    else { requests[1].reply.reject(new Error('old snapshot failed')); await flush() }
    expect(error).toBeNull()
    expect(store.get()?.runtime?.maxConcurrent).toBe(2)
    await vi.advanceTimersByTimeAsync(150)
    expect(requests).toHaveLength(4)
    await reply(3, board(3, { at: 4000, runtime: { maxConcurrent: 7 } }))
    expect(store.get()?.runtime?.maxConcurrent).toBe(7)
  })

  it('does not refresh on failed or cancelled actions', async () => {
    const store = makeStore()
    store.retain()
    await reply(0, board(1))
    const rejected = store.action({ action: 'review', verdict: 'approve' })
    const rejection = expect(rejected).rejects.toThrow('review refused')
    await reply(1, { ok: false, error: 'review refused' }, 409)
    await rejection
    const controller = new AbortController()
    const cancelled = store.action({ action: 'review' }, controller.signal)
    const cancellation = expect(cancelled).rejects.toThrow('request cancelled')
    controller.abort()
    await reply(2, { ok: true })
    await cancellation
    await vi.advanceTimersByTimeAsync(3000)
    expect(requests).toHaveLength(3)
  })
})
