// The Roster's model pickers are fed by this catalog, so a wire-face change in
// DSH blanks every dropdown. That is exactly what shipped: the plugin called the
// 0.1.1-era `connection.api.llm.*` face, DSH 0.1.6 moved RPCs to `ctx.remote.llm.*`
// (the connection service remains, but as connection *state* only), and the
// Roster degraded to "host connection unavailable" with a single "inherit
// deployment default" entry.
//
// These tests pin the dual-path behavior: remote face first, legacy api as the
// fallback, and a diagnostic (not a blank) when neither exists.
import { describe, expect, it } from 'vitest'
import { fetchModelCatalog, setFacesGetter, type CatalogFaces } from '../client/catalog.js'

function use(partial: Partial<CatalogFaces>): void {
  setFacesGetter(() => partial as CatalogFaces)
}

/**
 * The 0.1.6 remote face: zai and deepseek are configured (registered routes);
 * openrouter is shipped-but-dormant — known to the adapter, never registered,
 * so it must not appear in the pickers.
 */
const remoteFace = {
  llm: {
    listProviders: async () => ({
      ok: true,
      value: [{ id: 'zai', name: 'Z.ai' }, { id: 'deepseek-official', name: 'DeepSeek' }],
    }),
    listConfigurableProviders: async () => ({
      ok: true,
      value: [
        { provider: 'zai', displayName: 'Z.ai', settingsNs: 'llm.zai' },
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm.deepseek' },
        { provider: 'openrouter', displayName: 'OpenRouter (shipped, unconfigured)', settingsNs: 'llm.openrouter' },
      ],
    }),
    discoverModels: async (_ns: string, request: { provider?: string }) => {
      if (request.provider === 'zai') {
        return {
          ok: true,
          value: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }, { id: 'glm-5.3' }, { id: 'glm-5.3-flash' }],
        }
      }
      return { ok: false, error: { message: 'provider refused discovery' } }
    },
  },
}

/** The ≤0.1.5 legacy wire face. */
const legacyFace = {
  llm: {
    providers: async () => ({ result: { ok: true, value: { providers: [{ provider: 'zai', displayName: 'Z.ai' }] } } }),
    models: async () => ({
      result: {
        ok: true,
        value: { groups: [{ id: 'zai', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] }] },
      },
    }),
  },
}

describe('model catalog wire faces', () => {
  it('builds the catalog from the remote face (0.1.6+)', async () => {
    use({ remote: remoteFace })
    const catalog = await fetchModelCatalog()

    // Configured providers only: the dormant openrouter route is excluded even
    // though the configurable directory knows it.
    expect(catalog.providers.map((p) => p.provider)).toEqual(['deepseek-official', 'zai'])
    expect(catalog.providers.some((p) => p.provider === 'openrouter')).toBe(false)
    expect(catalog.providers.find((p) => p.provider === 'zai')?.displayName).toBe('Z.ai')

    // deepseek refused discovery — it must be absent, not fatal.
    expect(catalog.models.map((m) => `${m.provider}/${m.id}`)).toEqual(['zai/glm-5.3', 'zai/glm-5.3-flash'])
    expect(catalog.models.find((m) => m.id === 'glm-5.3-flash')?.name).toBe('GLM 5.3 Flash')
  })

  it('never offers models for a provider the user has not configured', async () => {
    use({ remote: remoteFace })
    const catalog = await fetchModelCatalog()
    expect(catalog.models.some((m) => m.provider === 'openrouter')).toBe(false)
  })

  it('dedupes models a provider reports twice', async () => {
    use({ remote: remoteFace })
    const catalog = await fetchModelCatalog()
    expect(catalog.models.filter((m) => m.id === 'glm-5.3-flash')).toHaveLength(1)
  })

  it('surfaces the remote error instead of a blank when listProviders refuses', async () => {
    use({
      remote: {
        llm: {
          ...remoteFace.llm,
          listProviders: async () => ({ ok: false, error: { message: 'not connected' } }),
        },
      },
    })
    await expect(fetchModelCatalog()).rejects.toThrow('not connected')
  })

  it('still works against the legacy connection.api face (≤0.1.5)', async () => {
    use({ api: legacyFace })
    const catalog = await fetchModelCatalog()
    expect(catalog.providers).toEqual([{ provider: 'zai', displayName: 'Z.ai' }])
    expect(catalog.models).toEqual([{ provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }])
  })

  it('prefers the remote face when both exist', async () => {
    use({ remote: remoteFace, api: legacyFace })
    const catalog = await fetchModelCatalog()
    // The legacy face knows only zai; the remote face lists both providers.
    expect(catalog.providers.map((p) => p.provider)).toContain('deepseek-official')
  })

  it('names both missing faces in the diagnostic', async () => {
    use({})
    await expect(fetchModelCatalog()).rejects.toThrow('host connection unavailable')
    await expect(fetchModelCatalog()).rejects.toThrow('ctx.remote')
  })

  it('treats a context without either face as unavailable (the reported regression)', async () => {
    // What the plugin saw on 0.1.6: `connection` resolves, but carries no `.api`.
    use({ api: undefined, remote: undefined })
    await expect(fetchModelCatalog()).rejects.toThrow('host connection unavailable')
  })
})
