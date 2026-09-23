// B1: 🐝 button in every session header — a self-contained live popover
// (active runs + latest statuses from the board), so the swarm is visible
// and one glance away even on surfaces where chat tabs do not render.
import { useEffect, useState } from 'react'
import { boardStore } from './board-store'
import { statusT, useT } from './locale'

interface LiveBoard {
  runs: Array<{ id: string; title: string; status: string }>
}

function statusColor(status: string): string {
  if (status === 'completed') return 'rgb(46, 160, 67)'
  if (status === 'running' || status === 'dispatching' || status === 'reviewing') return 'rgb(56, 139, 253)'
  if (status === 'paused') return 'rgb(227, 148, 36)'
  if (status === 'failed' || status === 'blocked') return 'rgb(219, 88, 96)'
  return 'rgba(125, 125, 125, 0.6)'
}

export function SwarmHeaderButton(): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<LiveBoard['runs']>([])

  useEffect(() => {
    if (!open) return
    // The live popover rides the shared board stream: this widget must not open
    // a connection of its own (see the connection budget in board-store.ts).
    const store = boardStore()
    const release = store.retain()
    const unsubscribe = store.subscribe((board) => {
      if (board !== null) setRuns(board.runs.slice(0, 6))
    })
    return () => {
      unsubscribe()
      release()
    }
  }, [open])

  return (
    <div className="dsh-swarm-hbtn-wrap">
      <button
        className="dsh-swarm-hbtn"
        title={t('header.title')}
        onClick={() => { setOpen(!open) }}
      >🐝</button>
      {open && (
        <div className="dsh-swarm-hpop">
          <b>{t('header.title')}</b>
          {runs.length === 0 && <p className="dsh-swarm-dim">{t('header.empty')}</p>}
          {runs.map((r) => (
            <div key={r.id} className="dsh-swarm-hpop-row">
              <span className="dsh-swarm-tvc-dot" style={{ background: statusColor(r.status) }} title={statusT(r.status)} />
              <span>{r.title.length > 42 ? r.title.slice(0, 42) + '…' : r.title}</span>
              <span className="dsh-swarm-dim">{statusT(r.status)}</span>
            </div>
          ))}
          <p className="dsh-swarm-dim">{t('header.footer')}</p>
        </div>
      )}
    </div>
  )
}
