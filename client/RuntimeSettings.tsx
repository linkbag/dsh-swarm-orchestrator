// Runtime tuning section: edit the swarm's hardening and concurrency
// parameters from the AI Swarm settings (persisted to runtime.json, applied
// live — no restart needed).
import { useEffect, useRef, useState } from 'react'
import { boardStore, type Board, type BoardRuntime } from './board-store'
import { useT } from './locale'

const FIELDS: Array<{ key: keyof BoardRuntime; labelKey: string; hintKey: string; min: number; max: number; step: number }> = [
  { key: 'maxConcurrent', labelKey: 'rt.maxConcurrent.label', hintKey: 'rt.maxConcurrent.hint', min: 1, max: 64, step: 1 },
  { key: 'maxTotalConcurrentAgents', labelKey: 'rt.maxTotalConcurrentAgents.label', hintKey: 'rt.maxTotalConcurrentAgents.hint', min: 1, max: 128, step: 1 },
  { key: 'spawnStaggerMs', labelKey: 'rt.spawnStaggerMs.label', hintKey: 'rt.spawnStaggerMs.hint', min: 0, max: 60000, step: 250 },
  { key: 'retryBackoffBaseMs', labelKey: 'rt.retryBackoffBaseMs.label', hintKey: 'rt.retryBackoffBaseMs.hint', min: 0, max: 120000, step: 1000 },
  { key: 'circuitBreakerThreshold', labelKey: 'rt.circuitBreakerThreshold.label', hintKey: 'rt.circuitBreakerThreshold.hint', min: 0, max: 10, step: 1 },
  { key: 'circuitBreakerCooldownMs', labelKey: 'rt.circuitBreakerCooldownMs.label', hintKey: 'rt.circuitBreakerCooldownMs.hint', min: 1000, max: 600000, step: 5000 },
  { key: 'nudgeAfterMinutes', labelKey: 'rt.nudgeAfterMinutes.label', hintKey: 'rt.nudgeAfterMinutes.hint', min: 0, max: 240, step: 5 },
  { key: 'staleTimeoutSeconds', labelKey: 'rt.staleTimeoutSeconds.label', hintKey: 'rt.staleTimeoutSeconds.hint', min: 60, max: 86400, step: 600 },
  { key: 'spawnTimeoutSeconds', labelKey: 'rt.spawnTimeoutSeconds.label', hintKey: 'rt.spawnTimeoutSeconds.hint', min: 0, max: 86400, step: 300 },
]
export function RuntimeSettings({ board }: { board: Board | null }): JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  // Initialize the draft from the board ONCE (on mount). Subsequent board
  // updates (SSE-driven, arriving every few seconds during active runs) must
  // NOT clobber the user's in-progress edits. After a successful save, the
  // board's next fetch carries the new values and we re-sync once.
  useEffect(() => {
    if (!initialized.current && board?.runtime !== undefined) {
      initialized.current = true
      const next: Record<string, string> = {}
      for (const f of FIELDS) {
        const v = board.runtime?.[f.key]
        next[f.key] = v !== undefined ? String(v) : ''
      }
      setDraft(next)
    }
  }, [board?.runtime])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const runtime: Record<string, number> = {}
      for (const f of FIELDS) {
        const raw = draft[f.key]
        if (raw !== undefined && raw.trim().length > 0) {
          const n = Number(raw)
          if (Number.isFinite(n) && n >= 0) runtime[f.key] = n
        }
      }
      const result = await boardStore().action({ action: 'set-runtime', runtime })
      setSavedAt(new Date().toLocaleTimeString())
      // Re-sync the draft from the saved result (the authoritative values).
      const saved = (result as { runtime?: Record<string, number> }).runtime
      if (saved !== undefined) {
        const next: Record<string, string> = {}
        for (const f of FIELDS) {
          const v = saved[f.key]
          next[f.key] = v !== undefined ? String(v) : ''
        }
        setDraft(next)
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const runtime = board?.runtime

  return (
    <section className="dsh-swarm-runtime">
      <h4>{t('rt.title')}</h4>
      <p className="dsh-swarm-dim">
        {t('rt.description')}
      </p>
      <div className="dsh-swarm-field-row">
        {FIELDS.map((f) => (
          <div key={f.key} className="dsh-swarm-field">
            <span>{t(f.labelKey)}</span>
            <input
              className="dsh-swarm-input"
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={draft[f.key] ?? ''}
              placeholder={runtime?.[f.key] !== undefined ? String(runtime[f.key]) : t('rt.ph.default')}
              title={t(f.hintKey)}
              onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }) }}
            />
          </div>
        ))}
      </div>
      {error !== null && <p className="dsh-swarm-action-error">{error}</p>}
      {savedAt !== null && <p className="dsh-swarm-dim">{t('rt.savedAt', { time: savedAt })}</p>}
      <button className="dsh-swarm-btn primary" disabled={busy} onClick={() => { void save() }}>
        {busy ? t('rt.saving') : t('rt.save')}
      </button>
    </section>
  )
}
