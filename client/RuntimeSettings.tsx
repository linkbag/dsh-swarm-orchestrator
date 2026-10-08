// Runtime tuning is persisted by the host; client drafts never mutate the board.
import { useEffect, useState } from 'react'
import { boardStore, type Board, type BoardRuntime } from './board-store'
import { useT } from './locale'
import { useRequestOwner } from './use-request-owner'
import { acceptSaved, configKey, createDraft, editDraft, isDirty, keepDraft, parseRuntimeDraft, receiveLive, reloadDraft, RUNTIME_FIELDS as FIELDS, runtimeDraft } from './settings-draft'

export function RuntimeSettings({ board }: { board: Board | null }): JSX.Element {
  const t = useT()
  const [state, setState] = useState(() => createDraft(runtimeDraft(board?.runtime)))
  const draft = state.value
  const dirty = isDirty(state)
  const owner = useRequestOwner()
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<{ time: string; config: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (board !== null) setState((current) => receiveLive(current, runtimeDraft(board.runtime)))
  }, [board])

  const save = async (): Promise<void> => {
    if (busy || state.conflict || board === null) return
    const request = owner.begin()
    const revision = state.revision
    setBusy(true)
    setError(null)
    setSavedAt(null)
    try {
      const runtime = parseRuntimeDraft(draft)
      const result = await boardStore().action({ action: 'set-runtime', runtime }, request.signal)
      if (!request.owns()) return
      const saved = result.runtime as BoardRuntime | undefined
      const accepted = saved !== undefined ? runtimeDraft(saved) : draft
      setState((current) => acceptSaved(current, revision, accepted, state.latest))
      setSavedAt({ time: new Date().toLocaleTimeString(), config: configKey(accepted) })
    } catch (err) {
      if (request.owns()) setError(String(err instanceof Error ? err.message : err))
    } finally {
      if (request.owns()) setBusy(false)
    }
  }

  const runtime = board?.runtime
  return (
    <section className="dsh-swarm-runtime">
      <h4>{t('rt.title')}</h4>
      <p className="dsh-swarm-dim">{t('rt.description')}</p>
      <fieldset className="dsh-swarm-edit-fields" disabled={busy || board === null}>
      <div className="dsh-swarm-field-row">
        {FIELDS.map((field) => (
          <div key={field.key} className="dsh-swarm-field">
            <span>{t(field.labelKey)}</span>
            <input
              className="dsh-swarm-input" type="number"
              min={field.min} max={field.max} step={field.step}
              value={draft[field.key] ?? ''}
              placeholder={runtime?.[field.key] !== undefined ? String(runtime[field.key]) : t('rt.ph.default')}
              title={t(field.hintKey, { default: field.default })}
              onChange={(event) => {
                const value = event.target.value
                setState((current) => editDraft(current, { ...current.value, [field.key]: value }))
                setSavedAt(null)
              }}
            />
          </div>
        ))}
      </div>
      {error !== null && <p role="alert" className="dsh-swarm-action-error">{error}</p>}
      {state.conflict && <p role="alert" className="dsh-swarm-action-error">{t('draft.conflict')}</p>}
      {state.conflict && <div className="dsh-swarm-run-actions">
        <button className="dsh-swarm-btn" onClick={() => { setState(reloadDraft); setSavedAt(null) }}>{t('draft.reload')}</button>
        <button className="dsh-swarm-btn" onClick={() => { setState(keepDraft); setSavedAt(null) }}>{t('draft.keep')}</button>
      </div>}
      {dirty && !state.conflict && <p className="dsh-swarm-dim">{t('draft.unsaved')}</p>}
      {savedAt !== null && savedAt.config === configKey(state.value) && !dirty && !state.conflict && error === null && <p role="status" className="dsh-swarm-dim">{t('rt.savedAt', { time: savedAt.time })}</p>}
      <button className="dsh-swarm-btn primary" disabled={busy || state.conflict || board === null || !dirty} onClick={() => { void save() }}>
        {busy ? t('rt.saving') : t('rt.save')}
      </button>
      </fieldset>
    </section>
  )
}
