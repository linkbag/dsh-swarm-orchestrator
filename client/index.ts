// dsh-swarm-orchestrator browser half: the "Swarm" dashboard tab (board +
// roster/duty-table editor). Registered as a conversation.view entry
// (chat → trajectory → swarm), the same additive-tab mechanism ui-trajectory
// uses. Data bridge: the node half's /swarm HTTP+SSE routes; the live model
// catalog comes from the llm RPC face — `ctx.remote.llm.*` on DSH 0.1.6+,
// the legacy `connection.api` face before that (see client/catalog.ts).
// Interface text follows the DSH language preference via the locale service
// (see client/locale.ts).
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SwarmTab } from './SwarmTab'
import { SwarmSettingsSection } from './SwarmSettingsSection'
import { SwarmHeaderButton } from './SwarmHeaderButton'
import { SwarmDispatchCard } from './ToolDispatchCard'
import { badgeView, type BadgeLabels } from './badge'
import { setFacesGetter, type LegacyApiLike, type RemoteLike } from './catalog'
import { initLocale, setLocaleService, t, type LocaleLike } from './locale'
import css from './swarm.css'

export const name = 'dsh-swarm-orchestrator-client'

/**
 * Required client services (cordis fiber inject — the loader treats module exports as the plugin object).
 * `remote`, `remote.llm` and `remote.session` are the 0.1.6 typert Remote faces the
 * model catalog calls (the same keys the shipped model-selection UI declares);
 * `connection` remains for the legacy ≤0.1.5 wire-face fallback; `locale` carries
 * the language preference and dictionary registry the Swarm UI translates through.
 */
export const inject = ['slots', 'connection', 'remote', 'remote.llm', 'remote.session', 'locale']

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

  setFacesGetter(() => {
    // Both faces, read lazily at fetch time: `ctx.remote` on DSH 0.1.6+, the
    // legacy `connection.api` wire face on hosts that still ship it.
    let api: LegacyApiLike | undefined
    try {
      api = (ctx.get('connection') as { api?: unknown } | undefined)?.api as LegacyApiLike | undefined
    } catch { api = undefined }
    const remote = (ctx as unknown as { remote?: unknown }).remote as RemoteLike | undefined
    return { api, remote }
  })

  // Localization: register the swarm dictionaries and keep the service reachable
  // for hooks (`useT`) and non-React surfaces (the badge). The UI follows the
  // DSH language preference (Settings → General → Language) automatically.
  const locale = (ctx as unknown as { locale?: LocaleLike }).locale
  initLocale(locale)
  setLocaleService(locale)

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
        .then((r) => r.json() as Promise<{ runs?: Array<{ status: string; createdAt?: number }> }>)
        .then((board) => {
          const statusWord = (status: string): string => {
            const translated = t(`status.${status}`)
            return translated === `status.${status}` ? status : translated
          }
          const labels: BadgeLabels = {
            active: t('badge.active'),
            paused: t('badge.paused'),
            awaiting: t('badge.awaiting'),
            last: t('badge.last'),
            status: statusWord,
          }
          const view = badgeView(board.runs, labels)
          badge.textContent = view.text
          badge.className = view.alert ? 'dsh-swarm-badge alert' : 'dsh-swarm-badge'
          badge.style.display = view.text.length === 0 ? 'none' : 'block'
        })
        .catch(() => { /* host offline — leave the badge as-is */ })
    }
    const source = new EventSource('/swarm/events')
    source.onmessage = update
    source.onerror = () => { badge.style.display = 'none' }
    const poll = setInterval(update, 60000)
    // A language switch must re-label the badge too — refetch and re-render.
    const offLocale = locale?.subscribe?.(() => { update() })
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
