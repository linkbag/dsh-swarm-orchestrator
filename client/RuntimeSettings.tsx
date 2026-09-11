// Runtime tuning section: edit the swarm's hardening and concurrency
// parameters from the AI Swarm settings (persisted to runtime.json, applied
// live — no restart needed).
import { useEffect, useState } from 'react'
import { boardStore, type Board, type BoardRuntime } from './board-store'

const FIELDS: Array<{ key: keyof BoardRuntime; label: string; hint: string; min: number; max: number; step: number }> = [
  { key: 'maxConcurrent', label: 'Max concurrent agents', hint: 'Simultaneously running task agents per run (default 5)', min: 1, max: 32, step: 1 },
  { key: 'spawnStaggerMs', label: 'Spawn stagger (ms)', hint: 'Delay between launches in one wave — softens provider load (default 750)', min: 0, max: 60000, step: 250 },
  { key: 'retryBackoffBaseMs', label: 'Retry backoff base (ms)', hint: 'Failed tasks wait base × 2^n before retrying (default 5000 = 5s)', min: 0, max: 120000, step: 1000 },
  { key: 'circuitBreakerThreshold', label: 'Circuit breaker threshold', hint: 'Failures within 30s before pausing retries — 0 = off (default 3)', min: 0, max: 10, step: 1 },
  { key: 'circuitBreakerCooldownMs', label: 'Circuit breaker cooldown (ms)', hint: 'How long retries pause after the breaker trips (default 60000 = 60s)', min: 1000, max: 600000, step: 5000 },
  { key: 'nudgeAfterMinutes', label: 'Nudge after silence (min)', hint: 'Board marker for silent tasks — 0 = off (default 20)', min: 0, max: 240, step: 5 },
  { key: 'staleTimeoutSeconds', label: 'Stale timeout (sec)', hint: 'Last-resort reclaim for silent agents (default 14400 = 4h)', min: 60, max: 86400, step: 600 },
]

export function RuntimeSettings({ board }: { board: Board | null }): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (board?.runtime !== undefined) {
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
      await boardStore().action({ action: 'set-runtime', runtime })
      setSavedAt(new Date().toLocaleTimeString())
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const runtime = board?.runtime

  return (
    <section className="dsh-swarm-runtime">
      <h4>⚙️ Runtime tuning</h4>
      <p className="dsh-swarm-dim">
        Adjust concurrency and hardening parameters — applied live, persisted across restarts.
        These override the profile's <code>cordis.patch.yml</code> values.
      </p>
      <div className="dsh-swarm-field-row">
        {FIELDS.map((f) => (
          <div key={f.key} className="dsh-swarm-field">
            <span>{f.label}</span>
            <input
              className="dsh-swarm-input"
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={draft[f.key] ?? ''}
              placeholder={runtime?.[f.key] !== undefined ? String(runtime[f.key]) : 'default'}
              title={f.hint}
              onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }) }}
            />
          </div>
        ))}
      </div>
      {error !== null && <p className="dsh-swarm-action-error">{error}</p>}
      {savedAt !== null && <p className="dsh-swarm-dim">Saved at {savedAt}</p>}
      <button className="dsh-swarm-btn primary" disabled={busy} onClick={() => { void save() }}>
        {busy ? 'Saving…' : 'Save runtime settings'}
      </button>
    </section>
  )
}
