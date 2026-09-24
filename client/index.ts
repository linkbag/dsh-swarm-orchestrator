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
import { boardStore, type Board } from './board-store'
import { initLocale, setLocaleService, t, type LocaleLike } from './locale'
import css from './swarm.css'

export const name = 'dsh-swarm-orchestrator-client'

/**
 * Required client services (cordis fiber inject — the loader treats module exports as the plugin object).
 *
 * DELIBERATELY ONLY `slots`. A hard inject blocks plugin activation until the
 * named service exists — and a third-party plugin that hard-injects
 * version-specific faces (`remote.llm`, `locale`, …) will fail to activate, and
 * can stall the client tree, on any host that renames or drops one of them
 * (observed as "web ui freezes, no chat history" after an auto-updated DSH
 * shipped an incomplete companion set). Everything version-specific is wired
 * through the dynamic `ctx.inject([...], cb)` scoping in apply() instead: when
 * a face is missing on any host version the callback simply never fires and
 * the plugin degrades — English labels, no live model catalog — instead of
 * blocking activation.
 */
export const inject = ['slots']

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

  // Defensive baseline, always installed FIRST: resolve lazily at fetch time.
  // Every access is guarded — an undeclared service access throws on cordis,
  // and an escaping throw would break the catalog fetch; degrade to undefined.
  setFacesGetter(() => {
    let api: LegacyApiLike | undefined
    try {
      api = (ctx.get('connection') as { api?: unknown } | undefined)?.api as LegacyApiLike | undefined
    } catch { api = undefined }
    let remote: RemoteLike | undefined
    try {
      remote = (ctx as unknown as { remote?: unknown }).remote as RemoteLike | undefined
    } catch { remote = undefined }
    return { api, remote }
  })

  // Localization best-effort at apply time; the scoped callback below re-wires
  // with the real service when available. The UI follows the DSH language
  // preference (Settings → General → Language) automatically.
  let locale: LocaleLike | undefined
  try {
    locale = (ctx as unknown as { locale?: LocaleLike }).locale
  } catch { locale = undefined }
  initLocale(locale)
  setLocaleService(locale)

  // Upgrade wiring: a dynamically scoped inject that fires once the host
  // provides every optional face, replacing the guarded getters above with
  // resolved references. Missing any of them on some host version → the
  // callback never runs, the plugin still activates, and the baseline getters
  // keep the UI alive in degraded mode (English labels, no live catalog).
  try {
    (ctx as unknown as { inject?: (names: string[], cb: (scope: unknown) => void) => void }).inject?.(
      ['connection', 'remote', 'remote.llm', 'remote.session', 'locale'],
      (scope: unknown) => {
        const services = scope as {
          connection?: { api?: unknown }
          remote?: unknown
          locale?: LocaleLike
        }
        initLocale(services.locale)
        setLocaleService(services.locale)
        setFacesGetter(() => ({
          api: services.connection?.api as LegacyApiLike | undefined,
          remote: services.remote as RemoteLike | undefined,
        }))
      },
    )
  } catch { /* dynamic inject unavailable on this host — the guarded getters stand */ }

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
  if (typeof document !== 'undefined') {
    const badge = document.createElement('div')
    badge.className = 'dsh-swarm-badge'
    badge.style.display = 'none'
    document.body.appendChild(badge)
    // ONE shared stream for the whole plugin: the badge rides the same board
    // store as the tab, the settings section and the dispatch cards. Opening an
    // EventSource here (as 0.6.11 and earlier did) spent a second of the
    // browser's ~6 connections per origin for no additional information.
    const store = boardStore()
    const release = store.retain()
    // The pill tracks RUNS only: live activity, otherwise the newest run's status.
    // Human-waiting attention is the aggregated notification's job, not a count
    // here (a task count also aggregated history, so it never cleared).
    const render = (board: Board | null | undefined): void => {
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
      const view = badgeView(board?.runs, labels)
      badge.textContent = view.text
      badge.className = view.alert ? 'dsh-swarm-badge alert' : 'dsh-swarm-badge'
      badge.style.display = view.text.length === 0 ? 'none' : 'block'
    }
    const unsubscribe = store.subscribe((board) => { if (board !== null) render(board) })
    // A language switch must re-label the badge too — re-render from the
    // snapshot already in hand, without touching the network.
    const offLocale = locale?.subscribe?.(() => { render(store.get()) })
    // Teardown: released when the plugin's style element is removed (apply disposer).
    const observer = new MutationObserver(() => {
      if (document.head.querySelector('style[data-dsh-swarm-orchestrator]') === null) {
        unsubscribe()
        offLocale?.()
        release()
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
