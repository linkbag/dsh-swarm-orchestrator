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
 */
function wireWhenAvailable(
  ctx: Context,
  serviceName: string,
  fn: () => (() => void) | void,
  timeoutMs = 60000,
): () => void {
  let inner: (() => void) | void
  let settled = false
  if (ctx.get(serviceName) !== undefined) {
    inner = fn()
    settled = true
    return () => { if (inner !== undefined) inner() }
  }
  const timer = setInterval(() => {
    if (ctx.get(serviceName) !== undefined) {
      clearInterval(timer)
      clearTimeout(to)
      inner = fn()
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
  // cordis 4: the Service constructor registers itself under 'swarm'.
  const service = new SwarmService(ctx, config)

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
