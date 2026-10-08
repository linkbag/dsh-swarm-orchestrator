import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { PLUGIN_VERSION } from './config.js'
import { isPlainRecord } from './domain/limits.js'
import type { SwarmService } from './service.js'

export const ROUTE_LIMITS = {
  bodyBytes: 1024 * 1024,
  bodyReadMs: 10000,
  urlChars: 8192,
  streams: 16,
  streamBufferBytes: 256 * 1024,
  streamBackpressureMs: 10000,
  heartbeatMs: 15000,
} as const

/** Structural copies of the inspected optional Host contracts; no hard inject. */
interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}
interface WebServerLike {
  register(route: WebRouteLike): () => void
}
interface ConnectionLike {
  admit(request: { readonly headers: IncomingMessage['headers'] }): { readonly peer: unknown } | { readonly rejection: 401 | 403 }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  try {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    })
    res.end(json)
  } catch {
    res.destroy()
  }
}

function requireJson(req: IncomingMessage): void {
  const type = req.headers['content-type']
  if (typeof type !== 'string' || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'mutations require application/json')
  }
  const charset = /;\s*charset\s*=\s*"?([^;"\s]+)"?/i.exec(type)?.[1]
  if (charset !== undefined && charset.toLowerCase() !== 'utf-8') throw new HttpError(415, 'JSON must use UTF-8')
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'encoded request bodies are not supported')
  }
}

/** Read with a byte ceiling AND a total deadline; no async iterator left waiting. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const length = req.headers['content-length']
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) throw new HttpError(400, 'invalid content-length')
  if (length !== undefined && Number(length) > ROUTE_LIMITS.bodyBytes) throw new HttpError(413, 'body too large')
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = (): void => {
      clearTimeout(deadline)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      req.off('close', onClose)
    }
    const fail = (error: HttpError): void => {
      if (settled) return
      settled = true
      cleanup()
      req.pause()
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
        size += bytes.length
        if (size > ROUTE_LIMITS.bodyBytes) { fail(new HttpError(413, 'body too large')); return }
        chunks.push(bytes)
      } catch { fail(new HttpError(400, 'invalid request body')) }
    }
    const onEnd = (): void => {
      if (settled) return
      if (length !== undefined && Number(length) !== size) { fail(new HttpError(400, 'content-length does not match body')); return }
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const onError = (): void => fail(new HttpError(400, 'request body read failed'))
    const onAborted = (): void => fail(new HttpError(400, 'request aborted'))
    const onClose = (): void => { if (!req.complete) onAborted() }
    const deadline = setTimeout(() => fail(new HttpError(408, 'request body read timed out')), ROUTE_LIMITS.bodyReadMs)
    deadline.unref?.()
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAborted)
    req.once('close', onClose)
    if (req.aborted || req.destroyed) onAborted()
    else req.resume()
  })
  if (raw.length === 0) throw new HttpError(400, 'JSON body required')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
  catch { throw new HttpError(400, 'invalid JSON body') }
  if (!isPlainRecord(value)) throw new HttpError(400, 'JSON body must be an object')
  return value
}

/**
 * One shared board stream remains cheap. Slow readers get one coalesced latest
 * event (not an unbounded queue), a drain deadline, and deterministic cleanup.
 */
function openBoardStream(req: IncomingMessage, res: ServerResponse, service: SwarmService, streams: Set<() => void>): void {
  let closed = false
  let blocked = false
  let pending: string | undefined
  let unsubscribe = (): void => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let drainDeadline: ReturnType<typeof setTimeout> | undefined
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (drainDeadline !== undefined) clearTimeout(drainDeadline)
    req.off('aborted', cleanup)
    req.off('error', cleanup)
    res.off('close', cleanup)
    res.off('error', cleanup)
    res.off('drain', onDrain)
    unsubscribe()
    pending = undefined
    streams.delete(cleanup)
    res.destroy()
  }
  const write = (frame: string): void => {
    if (closed) return
    if (res.destroyed || res.writableEnded || res.writableLength > ROUTE_LIMITS.streamBufferBytes) { cleanup(); return }
    if (blocked) { pending = frame; return }
    try {
      if (!res.write(frame)) {
        blocked = true
        drainDeadline = setTimeout(cleanup, ROUTE_LIMITS.streamBackpressureMs)
        drainDeadline.unref?.()
      }
      if (res.writableLength > ROUTE_LIMITS.streamBufferBytes) cleanup()
    } catch { cleanup() }
  }
  const onDrain = (): void => {
    if (closed) return
    blocked = false
    if (drainDeadline !== undefined) clearTimeout(drainDeadline)
    drainDeadline = undefined
    const frame = pending
    pending = undefined
    if (frame !== undefined) write(frame)
  }
  streams.add(cleanup)
  req.on('aborted', cleanup)
  req.on('error', cleanup)
  // IncomingMessage.close means the REQUEST completed, not an SSE disconnect.
  res.on('close', cleanup)
  res.on('error', cleanup)
  res.on('drain', onDrain)
  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    })
    write(`data: ${JSON.stringify({ seq: service.events.seq })}\n\n`)
    if (closed) return
    unsubscribe = service.events.subscribe((event) => {
      write(`data: ${JSON.stringify({ seq: event.seq, kind: event.kind.slice(0, 256) })}\n\n`)
    })
    heartbeat = setInterval(() => { if (!blocked) write(': heartbeat\n\n') }, ROUTE_LIMITS.heartbeatMs)
    heartbeat.unref?.()
  } catch (error) {
    cleanup()
    throw error
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new HttpError(400, `${name} must be a non-empty safe identifier (max 128 characters)`)
  }
  return value
}

function actionText(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!optional && value.trim().length === 0)) {
    throw new HttpError(400, `${name} must be ${optional ? '' : 'non-empty and '}at most ${max} characters without NUL`)
  }
  return value
}

function performAction(service: SwarmService, body: Record<string, unknown>): unknown {
  const action = actionText(body.action, 'action', 64)
  // Validate only the identifiers an action uses, before any service mutation.
  const run = (): string => identifier(body.runId, 'runId')
  const task = (): string => identifier(body.taskId, 'taskId')
  switch (action) {
    case 'endorse': { const runId = run(); service.endorse(runId); return { ok: true, action, runId } }
    case 'abort': { const runId = run(); service.abort(runId); return { ok: true, action, runId } }
    case 'resume': { const runId = run(); service.resumeRun(runId); return { ok: true, action, runId } }
    case 'retry-task': { const runId = run(); const taskId = task(); service.retryTask(runId, taskId); return { ok: true, action, runId, taskId } }
    case 'interrupt-task': { const runId = run(); const taskId = task(); service.interruptTask(runId, taskId, undefined); return { ok: true, action, runId, taskId } }
    case 'complete-task': {
      const runId = run(); const taskId = task()
      service.completeTaskExternally(runId, taskId, undefined, actionText(body.summary, 'summary', 32768, true))
      return { ok: true, action, runId, taskId }
    }
    case 'review': {
      const runId = run(); const taskId = task(); const verdict = body.verdict
      if (verdict !== 'approve' && verdict !== 'reject') throw new HttpError(400, 'verdict must be approve or reject')
      service.review(runId, taskId, verdict)
      return { ok: true, action, runId, taskId, verdict }
    }
    case 'set-duty-table': {
      if (!isPlainRecord(body.table)) throw new HttpError(400, 'table must be an object')
      return { ok: true, action, table: service.setDutyTable(body.table as never, 'dashboard') }
    }
    case 'set-runtime': {
      if (!isPlainRecord(body.runtime)) throw new HttpError(400, 'runtime must be an object')
      return { ok: true, action, runtime: service.setRuntimeOverrides(body.runtime as never) }
    }
    case 'rename-run': {
      const runId = run()
      return { ok: true, action, runId, title: service.renameRun(runId, actionText(body.title, 'title', 120)) }
    }
    case 'set-run-board-state': {
      const runId = run(); const state = body.state
      if (state !== 'visible' && state !== 'removed' && state !== 'purged') throw new HttpError(400, 'state must be visible, removed or purged')
      service.setRunBoardState(runId, state)
      return { ok: true, action, runId, state }
    }
    default: throw new HttpError(400, `unknown action ${JSON.stringify(action)}`)
  }
}

const METHODS: Readonly<Record<string, string>> = Object.freeze({
  '/swarm/health': 'GET', '/swarm/board': 'GET', '/swarm/workspace': 'GET',
  '/swarm/events': 'GET', '/swarm/action': 'POST',
})

/** All /swarm requests use the SAME Host/Origin/auth boundary as Connection. */
export function registerSwarmRoutes(ctx: Context, service: SwarmService): (() => void) | undefined {
  const webServer = ctx.get('webServer') as unknown as WebServerLike | undefined
  if (webServer === undefined) return undefined
  const streams = new Set<() => void>()
  const unregister = webServer.register({
    kind: 'prefix',
    path: '/swarm',
    async handler(req, res) {
      // Authenticate before parsing even the URL, let alone JSON, SSE or data.
      try {
        const connection = ctx.get('connection') as unknown as ConnectionLike | undefined
        if (connection === undefined || typeof connection.admit !== 'function') {
          sendJson(res, 503, { error: 'connection service unavailable' }, { connection: 'close' }); return
        }
        const admission = connection.admit({ headers: req.headers })
        if ('rejection' in admission) {
          sendJson(res, admission.rejection === 401 ? 401 : 403, { error: 'request refused' }, { connection: 'close' }); return
        }
        if (admission.peer === undefined || admission.peer === null) throw new Error('missing peer')
      } catch {
        sendJson(res, 503, { error: 'connection admission unavailable' }, { connection: 'close' }); return
      }
      try {
        const url = req.url ?? ''
        if (url.length > ROUTE_LIMITS.urlChars) throw new HttpError(414, 'URL too long')
        // Compare the literal path: no prefix aliases, encoded/normalized paths,
        // or method-changing OPTIONS/CORS bypass before authorization.
        const pathname = url.split('?', 1)[0]
        const method = Object.hasOwn(METHODS, pathname) ? METHODS[pathname] : undefined
        if (method === undefined) { sendJson(res, 404, { error: 'not found' }); return }
        if (req.method !== method) {
          sendJson(res, 405, { error: 'method not allowed' }, { allow: method, connection: 'close' }); return
        }
        switch (pathname) {
          case '/swarm/health':
            sendJson(res, 200, { ok: true, service: 'dsh-swarm-orchestrator', version: PLUGIN_VERSION }); return
          case '/swarm/board': {
            const params = new URL(url, 'http://localhost').searchParams
            const session = params.has('session') ? identifier(params.get('session'), 'session') : undefined
            const cwd = params.has('cwd') ? actionText(params.get('cwd'), 'cwd', 4096) : undefined
            sendJson(res, 200, service.snapshot({ ...(session !== undefined ? { session } : {}), ...(cwd !== undefined ? { cwd } : {}) })); return
          }
          case '/swarm/workspace': {
            const session = identifier(new URL(url, 'http://localhost').searchParams.get('session'), 'session')
            const cwd = service.resolveSessionWorkspace(session)
            sendJson(res, 200, cwd === undefined ? { session, unresolvable: true } : { session, cwd }); return
          }
          case '/swarm/events':
            if (streams.size >= ROUTE_LIMITS.streams) { sendJson(res, 429, { error: 'too many event streams' }, { 'retry-after': '15' }); return }
            openBoardStream(req, res, service, streams); return
          case '/swarm/action':
            requireJson(req)
            sendJson(res, 200, performAction(service, await readJsonBody(req))); return
        }
      } catch (error) {
        sendJson(res, error instanceof HttpError ? error.status : 400, {
          error: String(error instanceof Error ? error.message : error).slice(0, 2048),
        }, { connection: 'close' })
      }
    },
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try { unregister() } finally { for (const cleanup of [...streams]) cleanup() }
  }
}
