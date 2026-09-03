// dsh-swarm-orchestrator browser half: the "Swarm" dashboard tab (board +
// roster/duty-table editor). Registered as a conversation.view entry
// (chat → trajectory → swarm), the same additive-tab mechanism ui-trajectory
// uses. Data bridge: the node half's /swarm HTTP+SSE routes; the live model
// catalog comes from the connection service's llm RPCs (the same ones the
// official Models settings page uses).
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SwarmTab } from './SwarmTab'
import { SwarmSettingsSection } from './SwarmSettingsSection'
import { SwarmHeaderButton } from './SwarmHeaderButton'
import { SwarmDispatchCard } from './ToolDispatchCard'
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
  // Keyed toolview: swarm_dispatch calls render as a run card in chat
  // (title, task DAG, endorsement state, run id) instead of the generic
  // JSON row — the same per-tool seat ui-skill uses for `skill`.
  ctx.slots.inject('tool.call.toolview' as never, () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: 'swarm_dispatch' } as never,
      SwarmDispatchCard as never,
    ),
  )

  // B1: a root-scope Settings section — the roster/board stay reachable from
  // any surface, including the new-session page where chat tabs do not render.
  ctx.slots.inject('settings.section' as never, () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'swarm', order: 30, label: 'AI Swarm' } as never,
      SwarmSettingsSection as never,
    ),
  )

  // B1: 🐝 status button in every session header (live popover).
  ctx.slots.inject('conversation.session.header.actions' as never, () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'swarm-status' } as never,
      SwarmHeaderButton as never,
    ),
  )

  // B4: global run badge — a small fixed overlay fed by the board SSE, so run
  // activity is visible on every surface, not only inside the Swarm tab.
  if (typeof document !== 'undefined' && typeof EventSource !== 'undefined') {
    const badge = document.createElement('div')
    badge.className = 'dsh-swarm-badge'
    badge.style.display = 'none'
    document.body.appendChild(badge)
    const update = (): void => {
      void fetch('/swarm/board')
        .then((r) => r.json() as Promise<{ runs: Array<{ status: string }> }>)
        .then((board) => {
          const active = board.runs.filter((r) => r.status === 'running' || r.status === 'planning' || r.status === 'paused')
          const lastBad = board.runs.find((r) => r.status === 'failed' || r.status === 'paused')
          badge.textContent = active.length > 0
            ? `🐝 ${active.length} swarm run${active.length === 1 ? '' : 's'} active`
            : lastBad !== undefined
              ? `🐝 last swarm run: ${lastBad.status}`
              : board.runs.length > 0 ? '🐝 swarm idle' : ''
          badge.className = lastBad !== undefined && active.length === 0 ? 'dsh-swarm-badge alert' : 'dsh-swarm-badge'
          badge.style.display = badge.textContent.length === 0 ? 'none' : 'block'
        })
        .catch(() => { /* host offline — leave the badge as-is */ })
    }
    const source = new EventSource('/swarm/events')
    source.onmessage = update
    source.onerror = () => { badge.style.display = 'none' }
    const poll = setInterval(update, 60000)
    update()
    // Teardown: closed when the plugin's style element is removed (apply disposer).
    const observer = new MutationObserver(() => {
      if (document.head.querySelector('style[data-dsh-swarm-orchestrator]') === null) {
        source.close()
        if (poll !== null) clearInterval(poll)
        badge.remove()
        observer.disconnect()
      }
    })
    observer.observe(document.head, { childList: true })
  }

  return () => {
    if (style) style.remove()
  }
}
