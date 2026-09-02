// Live model catalog: the same llm RPCs the official Models settings page uses
// (providers + models grouped by provider), reached through the client
// connection service. Provider-agnostic by construction: every configured
// provider (DeepSeek official, zai/glm, kimi, claude, …) appears automatically.

export interface CatalogProvider { provider: string; displayName?: string }
export interface CatalogModel { provider: string; id: string; name: string }
export interface ModelCatalog { providers: CatalogProvider[]; models: CatalogModel[] }

type ApiLike = {
  llm: {
    providers(input: {}): Promise<{ result: { ok: boolean; value?: { providers?: CatalogProvider[] }; error?: { message?: string } } }>
    models(input: {}): Promise<{ result: { ok: boolean; value?: { groups?: Array<{ id?: string; models?: Array<{ id?: string; name?: string }> }> }; error?: { message?: string } } }>
  }
} | undefined

let getApi: () => ApiLike = () => undefined

/** Wired once by the client plugin apply(): exposes the connection's api face. */
export function setApiGetter(getter: () => ApiLike): void {
  getApi = getter
}

export async function fetchModelCatalog(): Promise<ModelCatalog> {
  const api = getApi()
  if (api === undefined) throw new Error('host connection unavailable')
  const [providersReply, modelsReply] = await Promise.all([api.llm.providers({}), api.llm.models({})])
  if (!providersReply.result.ok || !modelsReply.result.ok) {
    throw new Error(providersReply.result.error?.message ?? modelsReply.result.error?.message ?? 'catalog RPC failed')
  }
  const providers = (providersReply.result.value?.providers ?? []).map((entry) => ({
    provider: entry.provider,
    ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
  }))
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
