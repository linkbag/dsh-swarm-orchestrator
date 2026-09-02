// dsh-swarm-orchestrator browser half: the "Swarm" dashboard tab (board +
// roster/duty-table editor). Registered as a conversation.view entry
// (chat → trajectory → swarm), the same additive-tab mechanism ui-trajectory
// uses. Data bridge: the node half's /swarm HTTP+SSE routes; the live model
// catalog comes from the connection service's llm RPCs (the same ones the
// official Models settings page uses).
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SwarmTab } from './SwarmTab'
import { setApiGetter } from './catalog'
import css from './swarm.css'

export const name = 'dsh-swarm-orchestrator-client'

/** Required client services (cordis fiber inject — the loader treats module exports as the plugin object). */
export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): (() => void) | void {
  let style: HTMLStyleElement | null = null
  if (typeof document !== 'undefined') {
    style = document.head.querySelector<HTMLStyleElement>('style[data-dsh-swarm-orchestrator]')
    if (!style) {
      style = document.createElement('style')
      style.setAttribute('data-dsh-swarm-orchestrator', '')
      style.textContent = css
      document.head.appendChild(style)
    }
  }

  setApiGetter(() => {
    const connection = ctx.get('connection') as { api?: unknown } | undefined
    return connection?.api as never
  })

  ctx.slots.inject('conversation.view' as never, () =>
    ctx.slots.register(
      { name: 'conversation.view', id: 'swarm', order: 20, label: 'Swarm' } as never,
      SwarmTab as never,
    ),
  )
  return () => {
    if (style) style.remove()
  }
}
