// B1: "Swarm" section on the GUI Settings page (root scope — reachable from
// any surface, including the new-session page where conversation tabs do not
// render). Embeds the live board summary and the full roster editor.
import { useEffect, useState } from 'react'
import { boardStore, type Board } from './board-store'
import { DutyTableEditor } from './DutyTableEditor'
import { RuntimeSettings } from './RuntimeSettings'
import { statusT, useT } from './locale'

export function SwarmSettingsSection(): JSX.Element {
  const t = useT()
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const store = boardStore()
    const release = store.retain()
    const unsubscribe = store.subscribe((next, err) => {
      setBoard(next)
      setError(err)
    })
    return () => {
      unsubscribe()
      release()
    }
  }, [])

  const active = (board?.runs ?? []).filter((r) => r.status === 'running' || r.status === 'planning' || r.status === 'paused')
  const done = (board?.runs ?? []).filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'aborted')

  return (
    <div className="dsh-swarm-settings">
      <h3>
        {t('section.title')}
        {board !== null && <span className="dsh-swarm-dim" style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.8em' }}>v{board.version}</span>}
      </h3>
      <p className="dsh-swarm-dim">
        {t('section.description')}
      </p>
      {error !== null && <p className="dsh-swarm-action-error">{t('section.offline', { error })}</p>}
      {board !== null && (
        <p className="dsh-swarm-dim">
          {t('section.summary', {
            total: board.runs.length,
            plural: board.runs.length === 1 ? '' : 's',
            active: active.length,
            detail: active.length > 0 ? ` (${active.map((r) => statusT(r.status)).join(', ')})` : '',
            done: done.length,
          })}
        </p>
      )}
      <DutyTableEditor board={board} onSaved={() => {}} />
      <RuntimeSettings board={board} />
    </div>
  )
}
