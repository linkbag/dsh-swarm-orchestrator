// B1: 🐝 button in every session header — a self-contained live popover
// (active runs + latest statuses from the board), so the swarm is visible
// and one glance away even on surfaces where chat tabs do not render.
import { useEffect, useState } from 'react'

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
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<LiveBoard['runs']>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = (): void => {
      void fetch('/swarm/board')
        .then((r) => r.json() as Promise<LiveBoard>)
        .then((board) => { if (!cancelled) setRuns(board.runs.slice(0, 6)) })
        .catch(() => { /* transient */ })
    }
    load()
    const source = new EventSource('/swarm/events')
    source.onmessage = load
    source.onerror = () => { source.close() }
    return () => {
      cancelled = true
      source.close()
    }
  }, [open])

  return (
    <div className="dsh-swarm-hbtn-wrap">
      <button
        className="dsh-swarm-hbtn"
        title="Swarm runs"
        onClick={() => { setOpen(!open) }}
      >🐝</button>
      {open && (
        <div className="dsh-swarm-hpop">
          <b>Swarm runs</b>
          {runs.length === 0 && <p className="dsh-swarm-dim">no runs yet — dispatch one from any chat</p>}
          {runs.map((r) => (
            <div key={r.id} className="dsh-swarm-hpop-row">
              <span className="dsh-swarm-tvc-dot" style={{ background: statusColor(r.status) }} title={r.status} />
              <span>{r.title.length > 42 ? r.title.slice(0, 42) + '…' : r.title}</span>
              <span className="dsh-swarm-dim">{r.status}</span>
            </div>
          ))}
          <p className="dsh-swarm-dim">open a chat's Swarm tab for the live board · Settings → Swarm for the roster</p>
        </div>
      )}
    </div>
  )
}
