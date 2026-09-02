import type { Context } from '@deepseek-ai/cordis'
import { type SwarmConfig, Config, PLUGIN_VERSION } from './config.js'
import { registerSwarmRoutes } from './routes.js'
import { SwarmService } from './service.js'
import { registerSwarmTools } from './tools/index.js'

export const name = 'dsh-swarm-orchestrator'
export { Config, PLUGIN_VERSION }

/**
 * Optional-service lazy wiring: a service the plugin reads may not be provided
 * yet at apply time (cordis injection order). Poll ctx.get until it appears,
 * then run the wiring once; the fn may return its own disposer, which the
 * outer disposer chains. Effect-scoped: all timers clean up on unload.
 * The wiring call is guarded: a wiring failure logs and degrades — it must
 * never throw out of a timer callback (that would kill the whole process).
 */
function wireWhenAvailable(
  ctx: Context,
  serviceName: string,
  fn: () => (() => void) | void,
  timeoutMs = 60000,
): () => void {
  const logger = ctx.logger('swarm')
  const guarded = (): (() => void) | void => {
    try {
      return fn()
    } catch (err) {
      logger.error('wiring %s failed (degraded until next reload): %s', serviceName, String(err))
      return undefined
    }
  }
  let inner: (() => void) | void
  let settled = false
  if (ctx.get(serviceName) !== undefined) {
    inner = guarded()
    settled = true
    return () => { if (inner !== undefined) inner() }
  }
  const timer = setInterval(() => {
    if (ctx.get(serviceName) !== undefined) {
      clearInterval(timer)
      clearTimeout(to)
      inner = guarded()
      settled = true
    }
  }, 500)
  const to = setTimeout(() => clearInterval(timer), timeoutMs)
  return () => {
    clearInterval(timer)
    clearTimeout(to)
    if (settled && inner !== undefined) inner()
  }
}

export function apply(ctx: Context, config: SwarmConfig) {
  const logger = ctx.logger('swarm')
  // A swarm startup failure (e.g. unwritable storage dir) must degrade this
  // plugin only — never abort the whole loader tree and kill the host boot.
  let service: SwarmService
  try {
    service = new SwarmService(ctx, config)
  } catch (err) {
    logger.error('swarm service failed to start (plugin disabled this session): %s', String(err))
    return
  }

  // Per-role reasoning effort: AgentOptions has no effort field, so pin it
  // per LLM request through the agent/request waterfall, scoped to tracked
  // swarm children only (same mechanism the host's model selection uses).
  ctx.effect(() => {
    const scoped = ctx as unknown as {
      on(event: 'agent/request', listener: (payload: { agent: { id: string } }, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>): () => void
    }
    return scoped.on('agent/request', async (payload, next) => {
      const effort = service.effortFor(String(payload.agent.id))
      const resolved = await next()
      if (effort === undefined) return resolved
      return { ...resolved, reasoningEffort: effort }
    })
  })

  // Web GUI data bridge (GET /swarm/board, POST /swarm/action) — web profiles only.
  ctx.effect(() => wireWhenAvailable(ctx, 'webServer', () => registerSwarmRoutes(ctx, service)))

  // Model tools (global layer: visible to the lead session and spawned task agents).
  ctx.effect(() => wireWhenAvailable(ctx, 'tools', () => registerSwarmTools(ctx, service)))
}
