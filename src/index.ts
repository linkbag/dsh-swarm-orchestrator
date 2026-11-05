import type { Context } from '@deepseek-ai/cordis'
import { type SwarmConfig, Config, PLUGIN_VERSION } from './config.js'
import { registerSwarmCommand } from './command.js'
import { registerSwarmRoutes } from './routes.js'
import { SwarmService } from './service.js'
import { registerSwarmTools } from './tools/index.js'
import { structuredFailure } from './failures.js'
import type { RequestSettlement } from './request-ledger.js'

export * from './work-items.js'
export { EventWorkItemCheckpoints } from './work-item-store.js'
export { HARDENING_CAPABILITIES } from './capabilities.js'
export { RequestLedger, validateRequestBudget } from './request-ledger.js'
export type { RequestAttribution, RequestBudget, RequestRoute, RequestSettlement, RequestLedgerSummary } from './request-ledger.js'
export { DEFAULT_POLICY, taskPolicy, validatePolicy } from './policy.js'
export type { TaskPolicy, TaskPolicyOverride } from './policy.js'

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

  // Initial effort is supplied in agentOptions before the first request. Keep
  // the request waterfall scoped to still-owned children for later requests;
  // an explicit no-pin must remove inherited effort, not preserve it.
  ctx.effect(() => {
    const scoped = ctx as unknown as {
      on(event: 'agent/request', listener: (payload: { agent: { id: string } }, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>): () => void
    }
    return scoped.on('agent/request', async (payload, next) => {
      const resolved = await next()
      // Resolve ownership AFTER the waterfall await: cancellation or a fallback
      // may have revoked/replaced this child's pin while another hook yielded.
      const override = service.effortOverrideFor(String(payload.agent.id))
      if (override === undefined) return resolved
      if (override.effort !== undefined) return { ...resolved, reasoningEffort: override.effort }
      const unpinned = { ...resolved }
      delete unpinned.reasoningEffort
      return unpinned
    })
  })

  // One retry owner for policy-aware task/review children. Prepend so the
  // host's normal/always retry hook cannot swallow permanent errors first.
  // Unknown/unowned sessions retain the host's own policy unchanged.
  ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
    const id = String(payload.agent.id)
    const parent = payload.agent.session.header.origin === 'subagent' ? payload.agent.session.header.parentSession : undefined
    const parentId = parent !== undefined ? String(parent) : undefined
    service.recordChildFailure(id, payload.failure, payload.signal.aborted, parentId)
    if (service.ownsRetryForChild(id, parentId)) return undefined
    return next()
  }, { prepend: true }))

  // One durable reservation/send per observed provider-attempt stream. This is
  // NOT certification of SDK/wire retries, unowned auxiliaries or descendants.
  ctx.effect(() => ctx.on('llm/stream', async function* (options, next) {
    const observed = service.beginObservedRequest(options.sessionId !== undefined ? String(options.sessionId) : undefined, { provider: options.provider, model: options.model, ...(options.purpose !== undefined ? { purpose: options.purpose } : {}) })
    if (observed === undefined) { yield* next(); return }
    const settlement: RequestSettlement = {}
    let finished = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') settlement.usage = chunk.usage
        if (chunk.type === 'finish') {
          finished = true
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            const failure = chunk.reason.failure
            settlement.failure = { code: failure.code, ...(failure.status !== undefined ? { status: failure.status } : {}), ...(failure.requestId !== undefined ? { requestId: String(failure.requestId) } : {}) }
            if (chunk.reason.kind === 'aborted') settlement.cancelled = true
          }
        }
        yield chunk
      }
    } catch (error) {
      const failure = structuredFailure(error)
      settlement.failure = { code: failure?.code ?? 'UNKNOWN', ...(failure?.status !== undefined ? { status: failure.status } : {}) }
      throw error
    } finally {
      if (options.signal?.aborted || !finished) settlement.cancelled = true
      observed.settle(settlement)
    }
  }, { prepend: true }))

  // Web GUI data bridge (GET /swarm/board, POST /swarm/action) — web profiles only.
  ctx.effect(() => wireWhenAvailable(ctx, 'webServer', () => registerSwarmRoutes(ctx, service)))

  // Model tools (global layer: visible to the lead session and spawned task agents).
  ctx.effect(() => wireWhenAvailable(ctx, 'tools', () => registerSwarmTools(ctx, service)))

  // K5: the /swarm <goal> one-shot command (explicit user action → endorse).
  ctx.effect(() => wireWhenAvailable(ctx, 'commands', () => registerSwarmCommand(ctx, service)))
}
