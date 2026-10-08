import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSwarmRoutes, ROUTE_LIMITS } from '../src/routes.js'
import type { SwarmService } from '../src/service.js'
import type { SwarmEventRecord } from '../src/domain/types.js'

/** In-process transports only: these tests never open a port or contact a server. */
class Request extends EventEmitter {
  headers: IncomingMessage['headers'] = { host: '127.0.0.1:3080' }
  complete = false
  aborted = false
  destroyed = false
  pause = vi.fn(() => this)
  resume = vi.fn(() => this)
  constructor(readonly url: string, readonly method = 'GET') { super() }
  body(raw: string | Buffer): void {
    if (raw.length > 0) this.emit('data', raw)
    this.complete = true
    this.emit('end')
    this.emit('close')
  }
}
class Response extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  headersSent = false
  destroyed = false
  writableEnded = false
  writableLength = 0
  payload = ''
  frames: string[] = []
  writeResults: boolean[] = []
  writeHead = vi.fn((status: number, headers: Record<string, string>) => {
    this.statusCode = status; this.headers = headers; this.headersSent = true
    return this
  })
  end = vi.fn((body: string) => { this.payload = body; this.writableEnded = true; return this })
  write = vi.fn((frame: string) => { this.frames.push(frame); return this.writeResults.shift() ?? true })
  destroy = vi.fn(() => {
    if (!this.destroyed) { this.destroyed = true; this.emit('close') }
    return this
  })
  json(): Record<string, unknown> { return JSON.parse(this.payload) as Record<string, unknown> }
}
type Admission = { peer: object } | { rejection: 401 | 403 }
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
const disposers: Array<() => void> = []
function harness(options: { missingConnection?: boolean; missingWebServer?: boolean } = {}) {
  const subscribers = new Set<(event: SwarmEventRecord) => void>()
  const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
  const events = {
    seq: 4,
    subscribe: vi.fn((listener: (event: SwarmEventRecord) => void) => {
      subscribers.add(listener)
      const unsubscribe = vi.fn(() => { subscribers.delete(listener) })
      unsubscribes.push(unsubscribe)
      return unsubscribe
    }),
  }
  const service = {
    events,
    snapshot: vi.fn(() => ({ seq: 4, runs: [] })),
    resolveSessionWorkspace: vi.fn((session: string): string | undefined => session === 'missing' ? undefined : 'D:\\test workspace'),
    endorse: vi.fn(), abort: vi.fn(), resumeRun: vi.fn(), retryTask: vi.fn(),
    interruptTask: vi.fn(), completeTaskExternally: vi.fn(), review: vi.fn(),
    setDutyTable: vi.fn((table: unknown) => table), setRuntimeOverrides: vi.fn((runtime: unknown) => runtime),
    renameRun: vi.fn((_run: string, title: string) => title), setRunBoardState: vi.fn(),
  }
  const admit = vi.fn((_request: { headers: IncomingMessage['headers'] }): Admission => ({ peer: {} }))
  const unregister = vi.fn()
  let handler: Handler | undefined
  const register = vi.fn((route: { kind: string; path: string; handler: Handler }) => {
    expect(route).toMatchObject({ kind: 'prefix', path: '/swarm' })
    handler = route.handler
    return unregister
  })
  const context = { get: (name: string) => name === 'webServer'
    ? options.missingWebServer ? undefined : { register }
    : name === 'connection' ? options.missingConnection ? undefined : { admit } : undefined }
  const dispose = registerSwarmRoutes(context as unknown as Context, service as unknown as SwarmService)
  if (dispose !== undefined) disposers.push(dispose)
  const invoke = (request: Request, response = new Response()) => {
    if (handler === undefined) throw new Error('route not registered')
    const done = Promise.resolve(handler(request as unknown as IncomingMessage, response as unknown as ServerResponse))
    return { request, response, done }
  }
  const mutation = (body: unknown, headers: IncomingMessage['headers'] = { 'content-type': 'application/json' }) => {
    const request = new Request('/swarm/action', 'POST')
    Object.assign(request.headers, headers)
    const result = invoke(request)
    request.body(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    return result
  }
  const emit = (seq: number, kind = 'task/heartbeat') => {
    for (const listener of [...subscribers]) listener({ seq, at: 1, kind })
  }
  return { service, events, subscribers, unsubscribes, admit, register, unregister, invoke, mutation, emit, dispose }
}
const actionCalls = (h: ReturnType<typeof harness>): number => [
  h.service.endorse, h.service.abort, h.service.resumeRun, h.service.retryTask,
  h.service.interruptTask, h.service.completeTaskExternally, h.service.review,
  h.service.setDutyTable, h.service.setRuntimeOverrides, h.service.renameRun, h.service.setRunBoardState,
].reduce((count, method) => count + method.mock.calls.length, 0)

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('route admission and exact methods', () => {
  it('does not register without the optional web server', () => {
    const h = harness({ missingWebServer: true })
    expect(h.dispose).toBeUndefined()
    expect(h.register).not.toHaveBeenCalled()
  })

  it.each([
    ['/swarm/health', 'GET'], ['/swarm/board', 'GET'], ['/swarm/workspace?session=s', 'GET'],
    ['/swarm/events', 'GET'], ['/swarm/action', 'POST'], ['/swarm/board', 'OPTIONS'], ['/swarm/not-found', 'GET'],
  ])('rejects unauthorized %s %s before reading a body, opening SSE or exposing data', async (url, method) => {
    const h = harness()
    h.admit.mockReturnValue({ rejection: 401 })
    const { request, response, done } = h.invoke(new Request(url, method))
    await done
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(request.listenerCount('data')).toBe(0)
    expect(request.resume).not.toHaveBeenCalled()
    expect(h.service.snapshot).not.toHaveBeenCalled()
    expect(h.service.resolveSessionWorkspace).not.toHaveBeenCalled()
    expect(h.events.subscribe).not.toHaveBeenCalled()
    expect(actionCalls(h)).toBe(0)
    expect(h.admit).toHaveBeenCalledExactlyOnceWith({ headers: request.headers })
  })

  it.each([
    { host: 'evil.example', origin: 'http://127.0.0.1:3080' },
    { host: '127.0.0.1:3080', origin: 'https://evil.example' },
  ])('passes hostile Host/Origin through the connection boundary and honors its 403', async (headers) => {
    const h = harness()
    h.admit.mockImplementation(({ headers: actual }) => actual.host !== '127.0.0.1:3080' || actual.origin !== 'http://127.0.0.1:3080' ? { rejection: 403 } : { peer: {} })
    const request = new Request('/swarm/action', 'POST')
    Object.assign(request.headers, headers)
    const { response, done } = h.invoke(request)
    await done
    expect(response.statusCode).toBe(403)
    expect(h.admit.mock.calls[0][0].headers).toBe(request.headers)
    expect(request.resume).not.toHaveBeenCalled()
    expect(actionCalls(h)).toBe(0)
  })

  it('fails closed with a 503 when the connection service is absent, throws or returns no peer', async () => {
    const absent = harness({ missingConnection: true })
    const first = absent.invoke(new Request('/swarm/health'))
    await first.done
    expect(first.response.statusCode).toBe(503)
    const h = harness()
    h.admit.mockImplementationOnce(() => { throw new Error('admission unavailable') })
    const thrown = h.invoke(new Request('/swarm/events'))
    await thrown.done
    expect(thrown.response.statusCode).toBe(503)
    h.admit.mockReturnValueOnce({} as Admission)
    const noPeer = h.invoke(new Request('/swarm/action', 'POST'))
    await noPeer.done
    expect(noPeer.response.statusCode).toBe(503)
    expect(h.events.subscribe).not.toHaveBeenCalled()
    expect(actionCalls(h)).toBe(0)
  })

  it.each(['/swarm/board/extra', '/swarm/healthz', '/swarm/events/', '/swarm/%62oard', '/swarmish/board'])('does not accept suffixes/aliases: %s', async (url) => {
    const h = harness()
    const { response, done } = h.invoke(new Request(url))
    await done
    expect(response.statusCode).toBe(404)
    expect(h.service.snapshot).not.toHaveBeenCalled()
    expect(h.events.subscribe).not.toHaveBeenCalled()
  })

  it.each([
    ['/swarm/health', 'POST', 'GET'], ['/swarm/board', 'OPTIONS', 'GET'],
    ['/swarm/events', 'HEAD', 'GET'], ['/swarm/action', 'GET', 'POST'],
  ])('rejects wrong methods for %s without a CORS/OPTIONS bypass', async (url, method, allow) => {
    const h = harness()
    const { response, request, done } = h.invoke(new Request(url, method))
    await done
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe(allow)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(request.resume).not.toHaveBeenCalled()
    expect(h.events.subscribe).not.toHaveBeenCalled()
  })

  it('serves authorized health/board/workspace with JSON content type and validated filters', async () => {
    const h = harness()
    const health = h.invoke(new Request('/swarm/health'))
    await health.done
    expect(health.response.json()).toMatchObject({ ok: true, service: 'dsh-swarm-orchestrator' })
    const board = h.invoke(new Request('/swarm/board?session=session-1&cwd=D%3A%5Ctest%20workspace'))
    await board.done
    expect(h.service.snapshot).toHaveBeenCalledWith({ session: 'session-1', cwd: 'D:\\test workspace' })
    expect(board.response.headers['content-type']).toBe('application/json; charset=utf-8')
    const workspace = h.invoke(new Request('/swarm/workspace?session=missing'))
    await workspace.done
    expect(workspace.response.json()).toEqual({ session: 'missing', unresolvable: true })
  })

  it('contains a malformed/oversized URL and a snapshot exception', async () => {
    const h = harness()
    const tooLong = h.invoke(new Request('/swarm/board?' + 'x'.repeat(ROUTE_LIMITS.urlChars)))
    await tooLong.done
    expect(tooLong.response.statusCode).toBe(414)
    const malformed = h.invoke(new Request('/swarm/workspace?session=bad%20id'))
    await malformed.done
    expect(malformed.response.statusCode).toBe(400)
    h.service.snapshot.mockImplementationOnce(() => { throw new Error('snapshot failed') })
    const failed = h.invoke(new Request('/swarm/board'))
    await failed.done
    expect(failed.response.json()).toEqual({ error: 'snapshot failed' })
  })
})

describe('bounded JSON mutation input and action parity', () => {
  it.each([undefined, 'text/plain', 'application/json; charset=iso-8859-1'])('rejects mutation content type %s before reading JSON', async (type) => {
    const h = harness()
    const request = new Request('/swarm/action', 'POST')
    if (type !== undefined) request.headers['content-type'] = type
    const { response, done } = h.invoke(request)
    await done
    expect(response.statusCode).toBe(415)
    expect(request.resume).not.toHaveBeenCalled()
    expect(actionCalls(h)).toBe(0)
  })

  it('rejects compressed bodies before attempting to read them', async () => {
    const h = harness()
    const result = h.mutation({ action: 'abort', runId: 'r' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    await result.done
    expect(result.response.statusCode).toBe(415)
    expect(result.request.resume).not.toHaveBeenCalled()
    expect(actionCalls(h)).toBe(0)
  })

  it.each(['', '{', '[]', 'null', '"not an object"', Buffer.from([0xff])])('contains malformed JSON/object/UTF-8 input', async (body) => {
    const h = harness()
    const result = h.mutation(body)
    await result.done
    expect(result.response.statusCode).toBe(400)
    expect(actionCalls(h)).toBe(0)
    expect(result.request.listenerCount('data')).toBe(0)
  })

  it('rejects declared oversized bodies before attaching data listeners', async () => {
    const h = harness()
    const result = h.mutation('{}', { 'content-type': 'application/json', 'content-length': String(ROUTE_LIMITS.bodyBytes + 1) })
    await result.done
    expect(result.response.statusCode).toBe(413)
    expect(result.request.resume).not.toHaveBeenCalled()
    expect(actionCalls(h)).toBe(0)
  })

  it('caps actual bytes, pauses overflow and removes its listeners', async () => {
    const h = harness()
    const result = h.mutation(Buffer.alloc(ROUTE_LIMITS.bodyBytes + 1, 32))
    await result.done
    expect(result.response.statusCode).toBe(413)
    expect(result.request.pause).toHaveBeenCalledOnce()
    expect(result.request.listenerCount('data')).toBe(0)
    expect(result.request.listenerCount('aborted')).toBe(0)
    expect(actionCalls(h)).toBe(0)
  })

  it.each(['bad-length', '2'])('rejects malformed or mismatched content-length: %s', async (length) => {
    const h = harness()
    const result = h.mutation('{"action":"abort","runId":"r"}', { 'content-type': 'application/json', 'content-length': length })
    await result.done
    expect(result.response.statusCode).toBe(400)
    expect(actionCalls(h)).toBe(0)
  })

  it('enforces a total body read deadline and cleans body listeners', async () => {
    vi.useFakeTimers()
    const h = harness()
    const request = new Request('/swarm/action', 'POST')
    request.headers['content-type'] = 'application/json'
    const result = h.invoke(request)
    await vi.advanceTimersByTimeAsync(ROUTE_LIMITS.bodyReadMs)
    await result.done
    expect(result.response.statusCode).toBe(408)
    expect(request.pause).toHaveBeenCalledOnce()
    for (const event of ['data', 'end', 'error', 'aborted', 'close']) expect(request.listenerCount(event)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(actionCalls(h)).toBe(0)
  })

  it.each(['aborted', 'error', 'close'])('contains body read %s failures', async (event) => {
    const h = harness()
    const request = new Request('/swarm/action', 'POST')
    request.headers['content-type'] = 'application/json'
    const result = h.invoke(request)
    request.emit(event, new Error('test read failure'))
    await result.done
    expect(result.response.statusCode).toBe(400)
    expect(actionCalls(h)).toBe(0)
  })

  it.each([
    [{ action: 'endorse', runId: 'r' }, 'endorse', ['r']],
    [{ action: 'abort', runId: 'r' }, 'abort', ['r']],
    [{ action: 'resume', runId: 'r' }, 'resumeRun', ['r']],
    [{ action: 'retry-task', runId: 'r', taskId: 't' }, 'retryTask', ['r', 't']],
    [{ action: 'interrupt-task', runId: 'r', taskId: 't' }, 'interruptTask', ['r', 't', undefined]],
    [{ action: 'complete-task', runId: 'r', taskId: 't', summary: 'rescued' }, 'completeTaskExternally', ['r', 't', undefined, 'rescued']],
    [{ action: 'review', runId: 'r', taskId: 't', verdict: 'approve' }, 'review', ['r', 't', 'approve']],
    [{ action: 'set-runtime', runtime: { maxConcurrent: 2 } }, 'setRuntimeOverrides', [{ maxConcurrent: 2 }]],
    [{ action: 'set-duty-table', table: { version: 1 } }, 'setDutyTable', [{ version: 1 }, 'dashboard']],
    [{ action: 'rename-run', runId: 'r', title: 'new title' }, 'renameRun', ['r', 'new title']],
    [{ action: 'set-run-board-state', runId: 'r', state: 'removed' }, 'setRunBoardState', ['r', 'removed']],
  ])('authenticated action matches its service method', async (body, method, args) => {
    const h = harness()
    const result = h.mutation(body, { 'content-type': 'application/json; charset=UTF-8' })
    await result.done
    expect(result.response.statusCode).toBe(200)
    expect(h.service[method as keyof typeof h.service]).toHaveBeenCalledWith(...args as unknown[])
    expect(actionCalls(h)).toBe(1)
  })

  it.each([
    { action: 'abort', runId: '' }, { action: 'abort', runId: 'bad id' },
    { action: 'review', runId: 'r', taskId: 't', verdict: 'other' },
    { action: 'rename-run', runId: 'r', title: 'x'.repeat(121) },
    { action: 'set-run-board-state', runId: 'r', state: 'delete' },
    { action: 'set-duty-table', table: [] }, { action: 'set-runtime', runtime: [] },
    { action: 'complete-task', runId: 'r', taskId: 't', summary: 'x'.repeat(32769) },
    { action: 'not-a-real-action' },
  ])('contains invalid action shapes with no service mutation', async (body) => {
    const h = harness()
    const result = h.mutation(body)
    await result.done
    expect(result.response.statusCode).toBe(400)
    expect(actionCalls(h)).toBe(0)
  })

  it('contains service validation errors instead of rejecting its route promise', async () => {
    const h = harness()
    h.service.setRuntimeOverrides.mockImplementationOnce(() => { throw new Error('maxConcurrent must be an integer from 1 to 64') })
    const result = h.mutation({ action: 'set-runtime', runtime: { maxConcurrent: 1000000 } })
    await expect(result.done).resolves.toBeUndefined()
    expect(result.response.statusCode).toBe(400)
    expect(result.response.json().error).toBe('maxConcurrent must be an integer from 1 to 64')
  })
})

describe('one shared SSE stream with bounded slow-client resources', () => {
  it('ignores request completion close but cleans on actual response close', async () => {
    vi.useFakeTimers()
    const h = harness()
    const { request, response, done } = h.invoke(new Request('/swarm/events'))
    await done
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(h.subscribers.size).toBe(1)
    request.complete = true
    request.emit('close')
    expect(response.destroyed).toBe(false)
    h.emit(5)
    expect(response.frames).toHaveLength(2)
    expect(h.events.subscribe).toHaveBeenCalledOnce()
    response.emit('close')
    expect(h.subscribers.size).toBe(0)
    expect(h.unsubscribes[0]).toHaveBeenCalledOnce()
    expect(response.listenerCount('drain')).toBe(0)
    expect(request.listenerCount('aborted')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces many updates while blocked and writes only the latest event after drain', async () => {
    vi.useFakeTimers()
    const h = harness()
    const response = new Response()
    response.writeResults = [false, true]
    await h.invoke(new Request('/swarm/events'), response).done
    for (let seq = 5; seq < 105; seq += 1) h.emit(seq)
    expect(response.write).toHaveBeenCalledOnce()
    response.emit('drain')
    expect(response.write).toHaveBeenCalledTimes(2)
    expect(response.frames[1]).toContain('"seq":104')
    await vi.advanceTimersByTimeAsync(ROUTE_LIMITS.streamBackpressureMs)
    expect(response.destroyed).toBe(false)
    response.emit('close')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out backpressure and releases subscriptions/listeners/timers', async () => {
    vi.useFakeTimers()
    const h = harness()
    const response = new Response()
    response.writeResults = [false]
    const result = h.invoke(new Request('/swarm/events'), response)
    await result.done
    h.emit(5)
    await vi.advanceTimersByTimeAsync(ROUTE_LIMITS.streamBackpressureMs)
    expect(response.destroyed).toBe(true)
    expect(h.subscribers.size).toBe(0)
    expect(h.unsubscribes[0]).toHaveBeenCalledOnce()
    for (const event of ['close', 'error', 'drain']) expect(response.listenerCount(event)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects additional streams at the cap, then reuses a cleaned slot', async () => {
    vi.useFakeTimers()
    const h = harness()
    const responses: Response[] = []
    for (let i = 0; i < ROUTE_LIMITS.streams; i += 1) {
      const result = h.invoke(new Request('/swarm/events'))
      await result.done
      responses.push(result.response)
    }
    const overflow = h.invoke(new Request('/swarm/events'))
    await overflow.done
    expect(overflow.response.statusCode).toBe(429)
    expect(h.events.subscribe).toHaveBeenCalledTimes(ROUTE_LIMITS.streams)
    responses[0].emit('close')
    const replacement = h.invoke(new Request('/swarm/events'))
    await replacement.done
    expect(replacement.response.statusCode).toBe(200)
    expect(h.subscribers.size).toBe(ROUTE_LIMITS.streams)
    h.dispose!()
    expect(h.unregister).toHaveBeenCalledOnce()
    expect(h.subscribers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cuts off an excessive response buffer before registering an observer', async () => {
    vi.useFakeTimers()
    const h = harness()
    const response = new Response()
    response.writableLength = ROUTE_LIMITS.streamBufferBytes + 1
    await h.invoke(new Request('/swarm/events'), response).done
    expect(response.destroyed).toBe(true)
    expect(h.events.subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans all active streams when the route is disposed', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.invoke(new Request('/swarm/events'))
    const second = h.invoke(new Request('/swarm/events'))
    await Promise.all([first.done, second.done])
    h.dispose!()
    expect(h.unregister).toHaveBeenCalledOnce()
    expect(first.response.destroyed).toBe(true)
    expect(second.response.destroyed).toBe(true)
    expect(h.subscribers.size).toBe(0)
    expect(h.unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
