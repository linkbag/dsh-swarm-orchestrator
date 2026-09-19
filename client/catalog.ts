// Live model catalog for the Roster's model pickers: providers plus their
// models, grouped by provider route (the `provider/model` pair the duty table
// stores, e.g. `zai/glm-5.3-flash`).
//
// DSH 0.1.6 moved the wire face. The old `connection.api.llm.providers/models`
// calls stopped working — the `connection` service still exists but is now only
// connection *state*, and RPCs moved to the typert Remote face: `ctx.remote.llm.*`
// (the same face the shipped Models settings page uses). This module speaks BOTH:
// remote first, legacy api as the fallback for hosts that still ship it, so one
// published bundle serves every DSH version.
//
// Remote-face facts this relies on (verified against 0.1.6-alpha.2):
//  - every call resolves to { ok, value?, error? };
//  - `listProviders()` → LlmProviderInfo[] ({ id, name }) — registered routes;
//  - `listConfigurableProviders()` → routes with a settingsNs, configured or not;
//  - `discoverModels(settingsNs, { provider })` answers from the adapter's own
//    registry for routes it knows — no network call — and refuses for routes it
//    cannot answer. A refused provider is skipped, not fatal: one unconfigured
//    provider must not blank the whole picker.

export interface CatalogProvider { provider: string; displayName?: string }
export interface CatalogModel { provider: string; id: string; name: string }
export interface ModelCatalog { providers: CatalogProvider[]; models: CatalogModel[] }

interface RemoteReply<T> { ok: boolean; value?: T; error?: { code?: string; message?: string } }
interface RemoteProviderEntry { id?: string; name?: string }
interface RemoteConfigurableProvider { provider?: string; displayName?: string; settingsNs?: string }
interface RemoteDiscoveredModel { id?: string; name?: string }

/** One provider group of the Host-generation session catalog (`remote.session.modelCatalog`). */
interface SessionCatalogGroup { id?: string; name?: string; models?: Array<{ id?: string; name?: string }> }
interface SessionCatalogValue { groups?: SessionCatalogGroup[] }

/**
 * 0.1.6+: the typert Remote face reached as `ctx.remote`. The session catalog is
 * the same Host-generation catalog the composer's model picker renders — every
 * configured provider's models, DeepSeek included. `$on` carries the Host events
 * (`llm/adapters-updated`, `settings/document-updated`,
 * `credentials/reference-updated`) that fire when any of that changes.
 */
export interface RemoteLike {
  session?: {
    modelCatalog(): Promise<RemoteReply<SessionCatalogValue>>
  }
  llm?: {
    listProviders(): Promise<RemoteReply<RemoteProviderEntry[]>>
    listConfigurableProviders(): Promise<RemoteReply<RemoteConfigurableProvider[]>>
    discoverModels(settingsNs: string, request: { provider?: string }): Promise<RemoteReply<RemoteDiscoveredModel[]>>
  }
  $on?(event: string, handler: () => void): () => void
}

/** ≤0.1.5: the legacy `connection.api` wire face. */
export interface LegacyApiLike {
  llm: {
    providers(input: {}): Promise<{ result: { ok: boolean; value?: { providers?: Array<{ provider?: string; displayName?: string }> }; error?: { message?: string } } }>
    models(input: {}): Promise<{ result: { ok: boolean; value?: { groups?: Array<{ id?: string; models?: Array<{ id?: string; name?: string }> }> }; error?: { message?: string } } }>
  }
}

/** Both faces, as visible from the client context. Either may be absent. */
export interface CatalogFaces { remote?: RemoteLike; api?: LegacyApiLike }

let getFaces: () => CatalogFaces = () => ({})

/** Wired once by the client plugin apply(): exposes both RPC faces. */
export function setFacesGetter(getter: () => CatalogFaces): void {
  getFaces = getter
}

export async function fetchModelCatalog(): Promise<ModelCatalog> {
  const faces = getFaces()
  const remote = faces?.remote
  // 1. The Host-generation session catalog — the composer's own source, so it
  //    covers every configured provider (zai, DeepSeek, …) uniformly.
  if (typeof remote?.session?.modelCatalog === 'function') {
    try {
      return await fromSessionCatalog(remote)
    } catch { /* a refused session catalog falls through to the llm face */ }
  }
  // 2. The llm Remote face: registered routes + per-provider adapter discovery.
  if (remote?.llm !== undefined) return fromRemoteLlm(remote)
  // 3. ≤0.1.5: the legacy `connection.api` wire face.
  if (faces?.api?.llm !== undefined) return fromLegacyApi(faces.api)
  throw new Error('host connection unavailable (no ctx.remote face and no legacy connection.api — is the plugin older than the host?)')
}

async function fromSessionCatalog(remote: RemoteLike): Promise<ModelCatalog> {
  const reply = await remote.session!.modelCatalog()
  if (!reply.ok) {
    const code = reply.error?.code !== undefined ? `${reply.error.code}: ` : ''
    throw new Error(`${code}${reply.error?.message ?? 'session model catalog failed'}`)
  }
  const providers = new Map<string, CatalogProvider>()
  const models = new Map<string, CatalogModel>()
  for (const group of reply.value?.groups ?? []) {
    if (group?.id === undefined) continue
    if (!providers.has(group.id)) {
      providers.set(group.id, { provider: group.id, ...(group.name !== undefined ? { displayName: group.name } : {}) })
    }
    for (const model of group.models ?? []) {
      if (model?.id === undefined) continue
      const key = `${group.id}/${model.id}`
      if (!models.has(key)) models.set(key, { provider: group.id, id: model.id, name: model.name ?? model.id })
    }
  }
  return {
    providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    models: [...models.values()].sort((a, b) => a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)),
  }
}

/**
 * Fire `handler` when anything that can change the catalog changes on the Host
 * (adapters re-registered, settings rewritten, credentials added/removed).
 * Returns the combined disposer, or undefined when the host has no `$on` face.
 */
export function subscribeCatalogUpdates(handler: () => void): (() => void) | undefined {
  const $on = getFaces()?.remote?.$on
  if (typeof $on !== 'function') return undefined
  const disposers = ['llm/adapters-updated', 'settings/document-updated', 'credentials/reference-updated']
    .map((event) => {
      try { return $on.call(undefined, event, handler) } catch { return undefined }
    })
  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* best-effort unsubscribe */ }
    }
  }
}

async function fromRemoteLlm(remote: RemoteLike): Promise<ModelCatalog> {
  const llm = remote.llm
  if (llm === undefined) throw new Error('llm remote face unavailable')
  const [providersReply, configurablesReply] = await Promise.all([
    llm.listProviders(),
    llm.listConfigurableProviders().catch((): RemoteReply<RemoteConfigurableProvider[]> => ({ ok: false })),
  ])
  if (!providersReply.ok) {
    throw new Error(providersReply.error?.message ?? 'llm.listProviders failed')
  }

  // Only REGISTERED routes: an adapter activates a route when the user configures
  // it, so this list is exactly "providers the user has set up in DSH". The
  // configurable directory also knows dormant routes (shipped-but-unconfigured,
  // user drafts); those must not appear in the pickers.
  const providers = new Map<string, CatalogProvider>()
  for (const entry of providersReply.value ?? []) {
    if (entry?.id === undefined) continue
    providers.set(entry.id, { provider: entry.id, ...(entry.name !== undefined ? { displayName: entry.name } : {}) })
  }

  const models = new Map<string, CatalogModel>()
  await Promise.all((configurablesReply.ok ? configurablesReply.value ?? [] : []).map(async (entry) => {
    if (entry?.provider === undefined || entry.settingsNs === undefined) return
    if (!providers.has(entry.provider)) return // dormant route — not configured by the user
    try {
      const reply = await llm.discoverModels(entry.settingsNs, { provider: entry.provider })
      if (!reply.ok) return
      for (const model of reply.value ?? []) {
        if (model?.id === undefined) continue
        const key = `${entry.provider}/${model.id}`
        if (!models.has(key)) models.set(key, { provider: entry.provider, id: model.id, name: model.name ?? model.id })
      }
    } catch { /* a provider that cannot answer is simply absent from the picker */ }
  }))

  return {
    providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    models: [...models.values()].sort((a, b) => a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)),
  }
}

async function fromLegacyApi(api: LegacyApiLike): Promise<ModelCatalog> {
  const [providersReply, modelsReply] = await Promise.all([api.llm.providers({}), api.llm.models({})])
  if (!providersReply.result.ok || !modelsReply.result.ok) {
    throw new Error(providersReply.result.error?.message ?? modelsReply.result.error?.message ?? 'catalog RPC failed')
  }
  const providers = (providersReply.result.value?.providers ?? []).flatMap((entry) =>
    entry.provider === undefined
      ? []
      : [{ provider: entry.provider, ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}) }],
  )
  const models: CatalogModel[] = []
  for (const group of modelsReply.result.value?.groups ?? []) {
    if (group.id === undefined) continue
    for (const model of group.models ?? []) {
      if (model.id === undefined) continue
      models.push({ provider: group.id, id: model.id, name: model.name ?? model.id })
    }
  }
  return { providers, models }
}
