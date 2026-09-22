import { useCallback, useEffect, useMemo, useState } from 'react'
import { boardStore, type Board, type BoardRole } from './board-store'
import { fetchModelCatalog, subscribeCatalogUpdates, type ModelCatalog } from './catalog'
import { useT } from './locale'

const EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'max'] as const
const BUILTIN_ROLES = ['architect', 'builder', 'reviewer', 'integrator']

type DraftRole = BoardRole

function cloneRoles(board: Board | null): Record<string, DraftRole> {
  const clone: Record<string, DraftRole> = {}
  for (const [id, role] of Object.entries(board?.roles ?? {})) {
    clone[id] = { ...role, fallbacks: role.fallbacks.map((f) => ({ ...f })) }
  }
  return clone
}

function providerLabel(catalog: ModelCatalog | null, provider: string): string {
  return catalog?.providers.find((p) => p.provider === provider)?.displayName ?? provider
}

function encodeModel(provider: string, model: string): string {
  return `${provider} ${model}`
}

/** One <select> over the whole live catalog; the value encodes provider + model. */
function ModelSelect({ catalog, modelsByProvider, value, onChange, allowInherit }: {
  catalog: ModelCatalog | null
  modelsByProvider: Map<string, Array<{ id: string; name: string }>>
  value: { provider: string; model: string }
  onChange: (next: { provider: string; model: string }) => void
  allowInherit: boolean
}): JSX.Element {
  const t = useT()
  const encoded = value.provider.length > 0 && value.model.length > 0 ? encodeModel(value.provider, value.model) : ''
  return (
    <select
      className="dsh-swarm-input"
      value={encoded}
      onChange={(event) => {
        if (event.target.value === '') onChange({ provider: '', model: '' })
        else {
          const separator = event.target.value.indexOf(' ')
          onChange({ provider: event.target.value.slice(0, separator), model: event.target.value.slice(separator + 1) })
        }
      }}
    >
      {allowInherit && <option value="">{t('select.inherit')}</option>}
      {[...modelsByProvider.keys()].sort().map((provider) => (
        <optgroup key={provider} label={providerLabel(catalog, provider)}>
          {(modelsByProvider.get(provider) ?? []).map((model) => (
            <option key={encodeModel(provider, model.id)} value={encodeModel(provider, model.id)}>
              {model.name} ({providerLabel(catalog, provider)})
            </option>
          ))}
        </optgroup>
      ))}
      {encoded === '' && !allowInherit && <option value="">{t('select.chooseModel')}</option>}
    </select>
  )
}

export function DutyTableEditor({ board, onSaved }: { board: Board | null; onSaved: () => void }): JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState<Record<string, DraftRole>>(() => cloneRoles(board))
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)
  const [lockNote, setLockNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [newRole, setNewRole] = useState('')

  useEffect(() => {
    setDraft(cloneRoles(board))
    setLocked(board?.override?.enabled === true)
    setLockNote(board?.override?.note ?? '')
  }, [board])

  const refreshCatalog = useCallback(() => {
    setCatalogError(null)
    fetchModelCatalog()
      .then(setCatalog)
      .catch((err: unknown) => { setCatalogError(String(err instanceof Error ? err.message : err)) })
  }, [])

  useEffect(() => { refreshCatalog() }, [refreshCatalog])

  // Auto-update: adding an API key happens in Settings — another surface — so the
  // catalog re-fetches on a short poll and whenever this tab or the window
  // regains focus. Newly configured providers then appear without any manual
  // refresh, and removed ones drop out.
  useEffect(() => {
    const poll = window.setInterval(refreshCatalog, 30_000)
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') refreshCatalog()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [refreshCatalog])

  // Preferred: the Host pushes catalog invalidations as events (adapters
  // re-registered, settings rewritten, credentials changed) — refresh on each
  // instead of waiting for the poll. A no-$on host keeps the poll above.
  useEffect(() => subscribeCatalogUpdates(refreshCatalog), [refreshCatalog])

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, Array<{ id: string; name: string }>>()
    for (const model of catalog?.models ?? []) {
      const list = map.get(model.provider) ?? []
      list.push({ id: model.id, name: model.name })
      map.set(model.provider, list)
    }
    return map
  }, [catalog])

  const updateRole = useCallback((id: string, patch: Partial<DraftRole>) => {
    setDraft((current) => {
      const role = current[id]
      if (role === undefined) return current
      return { ...current, [id]: { ...role, ...patch } }
    })
  }, [])

  const addFallback = useCallback((id: string, provider: string, model: string) => {
    setDraft((current) => {
      const role = current[id]
      if (role === undefined || provider.length === 0) return current
      if (role.fallbacks.some((f) => f.provider === provider && f.model === model)) return current
      return { ...current, [id]: { ...role, fallbacks: [...role.fallbacks, { provider, model }] } }
    })
  }, [])

  const moveFallback = useCallback((id: string, index: number, delta: number) => {
    setDraft((current) => {
      const role = current[id]
      if (role === undefined) return current
      const next = [...role.fallbacks]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const swap = next[target]
      next[target] = next[index]
      next[index] = swap
      return { ...current, [id]: { ...role, fallbacks: next } }
    })
  }, [])

  const removeFallback = useCallback((id: string, index: number) => {
    setDraft((current) => {
      const role = current[id]
      if (role === undefined) return current
      return { ...current, [id]: { ...role, fallbacks: role.fallbacks.filter((_, i) => i !== index) } }
    })
  }, [])

  const save = useCallback(async () => {
    setBusy(true)
    setSaveError(null)
    try {
      await boardStore().action({
        action: 'set-duty-table',
        table: {
          version: 1,
          updatedAt: Date.now(),
          roles: draft,
          override: { enabled: locked, note: lockNote.length > 0 ? lockNote : undefined, setBy: 'dashboard', at: Date.now() },
        },
      })
      setSavedAt(new Date().toLocaleTimeString())
      onSaved()
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }, [draft, locked, lockNote, onSaved])

  const addRole = useCallback(() => {
    const id = newRole.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (id.length === 0 || draft[id] !== undefined) return
    setDraft((current) => ({
      ...current,
      [id]: { id, label: id, description: '', fallbacks: [] },
    }))
    setNewRole('')
  }, [draft, newRole])

  const deleteRole = useCallback((id: string) => {
    setDraft((current) => {
      if (BUILTIN_ROLES.includes(id)) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }, [])

  return (
    <div className="dsh-swarm-roster">
      <div className="dsh-swarm-roster-bar">
        <div>
          {catalog !== null
            ? <span className="dsh-swarm-pill">{t('roster.catalogLive', { providers: catalog.providers.length, models: catalog.models.length })}</span>
            : <span className="dsh-swarm-pill warn">{catalogError ?? t('roster.loadingCatalog')}</span>}
          {' '}<button className="dsh-swarm-btn ghost" onClick={refreshCatalog}>{t('roster.refreshCatalog')}</button>
        </div>
        <div className="dsh-swarm-run-actions">
          <label className="dsh-swarm-lock">
            <input type="checkbox" checked={locked} onChange={(event) => { setLocked(event.target.checked) }} />
            {t('roster.overrideLock')}
          </label>
          {locked && (
            <input
              className="dsh-swarm-input"
              placeholder={t('roster.lockNotePh')}
              value={lockNote}
              onChange={(event) => { setLockNote(event.target.value) }}
            />
          )}
          <button className="dsh-swarm-btn primary" disabled={busy} onClick={() => { void save() }}>
            {locked ? t('roster.saveClearsLock') : t('roster.save')}
          </button>
        </div>
      </div>
      {saveError !== null && <p className="dsh-swarm-action-error">{saveError}</p>}
      {savedAt !== null && saveError === null && <p className="dsh-swarm-dim">{t('roster.savedAt', { time: savedAt })}</p>}

      <div className="dsh-swarm-role-grid">
        {Object.values(draft).map((role) => (
          <section key={role.id} className="dsh-swarm-role-card">
            <header>
              <h4><kbd>{role.id}</kbd> {role.label}</h4>
              {!BUILTIN_ROLES.includes(role.id) && (
                <button className="dsh-swarm-btn ghost" onClick={() => { deleteRole(role.id) }}>{t('roster.remove')}</button>
              )}
            </header>
            <div className="dsh-swarm-field">
              <span>{t('roster.field.model')}</span>
              <ModelSelect
                catalog={catalog} modelsByProvider={modelsByProvider} allowInherit
                value={{ provider: role.provider ?? '', model: role.model ?? '' }}
                onChange={(next) => { updateRole(role.id, { provider: next.provider.length > 0 ? next.provider : undefined, model: next.model.length > 0 ? next.model : undefined }) }}
              />
            </div>
            <div className="dsh-swarm-field-row">
              <div className="dsh-swarm-field">
                <span>{t('roster.field.effort')}</span>
                <select
                  className="dsh-swarm-input"
                  value={role.reasoningEffort ?? ''}
                  onChange={(event) => { updateRole(role.id, { reasoningEffort: event.target.value === '' ? undefined : event.target.value }) }}
                >
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>{effort === '' ? t('roster.effortInherit') : effort}</option>
                  ))}
                </select>
              </div>
              <div className="dsh-swarm-field">
                <span>{t('roster.field.maxTokens')}</span>
                <input
                  className="dsh-swarm-input" type="number" min={1024} step={1024}
                  value={role.maxTokens ?? ''}
                  placeholder={t('roster.ph.default')}
                  onChange={(event) => { updateRole(role.id, { maxTokens: event.target.value === '' ? undefined : Number(event.target.value) }) }}
                />
              </div>
            </div>
            <div className="dsh-swarm-field">
              <span>{t('roster.field.fallbacks')}</span>
              {role.fallbacks.length === 0 && <p className="dsh-swarm-dim">{t('roster.field.noFallbacks')}</p>}
              <ol className="dsh-swarm-fallbacks">
                {role.fallbacks.map((fallback, index) => (
                  <li key={encodeModel(fallback.provider, fallback.model)}>
                    <code>{fallback.provider}/{fallback.model}</code>
                    <span className="dsh-swarm-fallback-actions">
                      <button className="dsh-swarm-btn ghost" disabled={index === 0} onClick={() => { moveFallback(role.id, index, -1) }}>{t('roster.up')}</button>
                      <button className="dsh-swarm-btn ghost" disabled={index === role.fallbacks.length - 1} onClick={() => { moveFallback(role.id, index, 1) }}>{t('roster.down')}</button>
                      <button className="dsh-swarm-btn ghost" onClick={() => { removeFallback(role.id, index) }}>{t('roster.fallbackRemove')}</button>
                    </span>
                  </li>
                ))}
              </ol>
              <ModelSelect
                catalog={catalog} modelsByProvider={modelsByProvider} allowInherit={false}
                value={{ provider: '', model: '' }}
                onChange={(next) => { addFallback(role.id, next.provider, next.model) }}
              />
            </div>
            <div className="dsh-swarm-field-row">
              <div className="dsh-swarm-field">
                <span>{t('roster.field.effortLadder')}</span>
                <input
                  className="dsh-swarm-input" placeholder={t('roster.ph.effortLadder')}
                  value={(role.effortFallbacks ?? []).join(', ')}
                  onChange={(event) => {
                    const chain = event.target.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
                    updateRole(role.id, { effortFallbacks: chain.length > 0 ? chain : undefined })
                  }}
                />
              </div>
              <div className="dsh-swarm-field">
                <span>{t('roster.field.cap')}</span>
                <input
                  className="dsh-swarm-input" type="number" min={1} step={1}
                  value={role.maxConcurrent ?? ''}
                  placeholder={t('roster.ph.globalDefault')}
                  onChange={(event) => { updateRole(role.id, { maxConcurrent: event.target.value === '' ? undefined : Number(event.target.value) }) }}
                />
              </div>
            </div>
            <div className="dsh-swarm-field">
              <span>{t('roster.field.spawnTimeout')}</span>
              <input
                className="dsh-swarm-input" type="number" min={0} step={300}
                value={role.spawnTimeoutSeconds ?? ''}
                placeholder={board?.runtime?.spawnTimeoutSeconds !== undefined ? String(board.runtime.spawnTimeoutSeconds) : t('roster.ph.spawnTimeout')}
                title={t('roster.spawnTimeoutHint')}
                onChange={(event) => { updateRole(role.id, { spawnTimeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value) }) }}
              />
            </div>
            <div className="dsh-swarm-field">
              <span>{t('roster.field.toolFilter')}</span>
              <input
                className="dsh-swarm-input" placeholder={t('roster.ph.toolFilter')}
                value={(role.toolFilter?.deny ?? []).join(', ')}
                onChange={(event) => {
                  const deny = event.target.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
                  updateRole(role.id, { toolFilter: deny.length > 0 ? { deny } : undefined })
                }}
              />
            </div>
            <details className="dsh-swarm-persona">
              <summary>{t('roster.field.persona')}</summary>
              <input
                className="dsh-swarm-input" placeholder={t('roster.ph.label')}
                value={role.label}
                onChange={(event) => { updateRole(role.id, { label: event.target.value }) }}
              />
              <input
                className="dsh-swarm-input" placeholder={t('roster.ph.description')}
                value={role.description}
                onChange={(event) => { updateRole(role.id, { description: event.target.value }) }}
              />
              <textarea
                className="dsh-swarm-input" rows={4} placeholder={t('roster.ph.personaText')}
                value={role.persona ?? ''}
                onChange={(event) => { updateRole(role.id, { persona: event.target.value === '' ? undefined : event.target.value }) }}
              />
            </details>
          </section>
        ))}
      </div>

      <div className="dsh-swarm-add-role">
        <input
          className="dsh-swarm-input" placeholder={t('roster.ph.newRole')}
          value={newRole}
          onChange={(event) => { setNewRole(event.target.value) }}
        />
        <button className="dsh-swarm-btn" disabled={newRole.trim().length === 0} onClick={addRole}>{t('roster.addRole')}</button>
      </div>
    </div>
  )
}
