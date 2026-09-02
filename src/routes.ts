import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { PLUGIN_VERSION } from './config.js'
import type { SwarmService } from './service.js'

/**
 * SSE change stream: one `data: {"seq":N}` frame per appended event plus a
 * 15s heartbeat. Clients refetch the full board on each frame — display-only
 * data, deliberately never written into any session log.
 */
function openBoardStream(req: IncomingMessage, res: ServerResponse, service: SwarmService): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  res.write(`data: ${JSON.stringify({ seq: service.events.seq })}\n\n`)
  const unsubscribe = service.events.subscribe((event) => {
    try {
      res.write(`data: ${JSON.stringify({ seq: event.seq, kind: event.kind })}\n\n`)
    } catch {
      cleanup()
    }
  })
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n')
    } catch {
      cleanup()
    }
  }, 15000)
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    res.destroy()
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
}

/** Structural copy of the host webserver's route shape (optional service — no hard inject). */
interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

interface WebServerLike {
  register(route: WebRouteLike): () => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** The /swarm HTTP surface: health, board snapshot, SSE change stream, and dashboard actions. */
export function registerSwarmRoutes(ctx: Context, service: SwarmService): (() => void) | undefined {
  const webServer = ctx.get('webServer') as unknown as WebServerLike | undefined
  if (webServer === undefined) return undefined
  return webServer.register({
    kind: 'prefix',
    path: '/swarm',
    async handler(req, res) {
      const url = req.url ?? ''
      try {
        if (req.method === 'GET' && url.startsWith('/swarm/health')) {
          sendJson(res, 200, { ok: true, service: 'dsh-swarm-orchestrator', version: PLUGIN_VERSION })
          return
        }
        if (req.method === 'GET' && url.startsWith('/swarm/board')) {
          sendJson(res, 200, service.snapshot())
          return
        }
        if (req.method === 'GET' && url.startsWith('/swarm/events')) {
          openBoardStream(req, res, service)
          return
        }
        if (req.method === 'POST' && url.startsWith('/swarm/action')) {
          const body = await readJsonBody(req)
          const action = typeof body.action === 'string' ? body.action : ''
          const runId = typeof body.runId === 'string' ? body.runId : undefined
          const taskId = typeof body.taskId === 'string' ? body.taskId : undefined
          switch (action) {
            case 'endorse':
              if (runId === undefined) throw new Error('runId required')
              service.endorse(runId)
              sendJson(res, 200, { ok: true, action, runId })
              return
            case 'abort':
              if (runId === undefined) throw new Error('runId required')
              service.abort(runId)
              sendJson(res, 200, { ok: true, action, runId })
              return
            case 'retry-task':
              if (runId === undefined || taskId === undefined) throw new Error('runId and taskId required')
              service.retryTask(runId, taskId)
              sendJson(res, 200, { ok: true, action, runId, taskId })
              return
            case 'set-duty-table': {
              const table = body.table
              if (table === null || typeof table !== 'object') throw new Error('table required')
              const saved = service.setDutyTable(table as never, 'dashboard')
              sendJson(res, 200, { ok: true, action, table: saved })
              return
            }
            default:
              sendJson(res, 400, { error: `unknown action ${JSON.stringify(action)}` })
              return
          }
        }
        sendJson(res, 404, { error: 'not found' })
      } catch (err) {
        sendJson(res, 400, { error: String(err instanceof Error ? err.message : err) })
      }
    },
  })
}
