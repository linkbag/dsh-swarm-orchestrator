// B1: "Swarm" section on the GUI Settings page (root scope — reachable from
// any surface, including the new-session page where conversation tabs do not
// render). Embeds the live board summary and the full roster editor.
import { useEffect, useState } from 'react'
import { boardStore, type Board } from './board-store'
import { DutyTableEditor } from './DutyTableEditor'

export function SwarmSettingsSection(): JSX.Element {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const store = boardStore()
    store.start()
    const unsubscribe = store.subscribe((next, err) => {
      setBoard(next)
      setError(err)
    })
    return () => {
      unsubscribe()
      store.stop()
    }
  }, [])

  const active = (board?.runs ?? []).filter((r) => r.status === 'running' || r.status === 'planning' || r.status === 'paused')
  const done = (board?.runs ?? []).filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'aborted')

  return (
    <div className="dsh-swarm-settings">
      <h3>🐝 Swarm orchestration</h3>
      <p className="dsh-swarm-dim">
        Role-based multi-agent runs. Open any chat's <b>Swarm</b> tab for the live board;
        this section manages the model roster everywhere.
      </p>
      {error !== null && <p className="dsh-swarm-action-error">swarm host offline: {error}</p>}
      {board !== null && (
        <p className="dsh-swarm-dim">
          {board.runs.length} run{board.runs.length === 1 ? '' : 's'} total
          {' · '}{active.length} active{active.length > 0 ? ` (${active.map((r) => r.status).join(', ')})` : ''}
          {' · '}{done.length} finished
        </p>
      )}
      <DutyTableEditor board={board} onSaved={() => {}} />
    </div>
  )
}
