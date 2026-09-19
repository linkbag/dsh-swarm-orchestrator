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

interface RemoteReply<T> { ok: boolean; value?: T; error?: { message?: string } }
interface RemoteProviderEntry { id?: string; name?: string }
interface RemoteConfigurableProvider { provider?: string; displayName?: string; settingsNs?: string }
interface RemoteDiscoveredModel { id?: string; name?: string }

/** 0.1.6+: the typert Remote face reached as `ctx.remote`. */
export interface RemoteLike {
  llm: {
    listProviders(): Promise<RemoteReply<RemoteProviderEntry[]>>
    listConfigurableProviders(): Promise<RemoteReply<RemoteConfigurableProvider[]>>
    discoverModels(settingsNs: string, request: { provider?: string }): Promise<RemoteReply<RemoteDiscoveredModel[]>>
  }
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
  if (faces?.remote?.llm !== undefined) return fromRemote(faces.remote)
  if (faces?.api?.llm !== undefined) return fromLegacyApi(faces.api)
  throw new Error('host connection unavailable (no ctx.remote face and no legacy connection.api — is the plugin older than the host?)')
}

async function fromRemote(remote: RemoteLike): Promise<ModelCatalog> {
  const [providersReply, configurablesReply] = await Promise.all([
    remote.llm.listProviders(),
    remote.llm.listConfigurableProviders().catch((): RemoteReply<RemoteConfigurableProvider[]> => ({ ok: false })),
  ])
  if (!providersReply.ok) {
    throw new Error(providersReply.error?.message ?? 'llm.listProviders failed')
  }

  const providers = new Map<string, CatalogProvider>()
  for (const entry of providersReply.value ?? []) {
    if (entry?.id === undefined) continue
    providers.set(entry.id, { provider: entry.id, ...(entry.name !== undefined ? { displayName: entry.name } : {}) })
  }
  for (const entry of configurablesReply.ok ? configurablesReply.value ?? [] : []) {
    if (entry?.provider === undefined || providers.has(entry.provider)) continue
    providers.set(entry.provider, {
      provider: entry.provider,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
    })
  }

  const models = new Map<string, CatalogModel>()
  await Promise.all((configurablesReply.ok ? configurablesReply.value ?? [] : []).map(async (entry) => {
    if (entry?.provider === undefined || entry.settingsNs === undefined) return
    try {
      const reply = await remote.llm.discoverModels(entry.settingsNs, { provider: entry.provider })
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
