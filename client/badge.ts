// Label logic for the global 🐝 badge (bottom-right overlay), kept pure and
// DOM-free so it can be unit-tested.
//
// The bug this replaces: the badge looked for the newest run whose status was
// 'failed' or 'paused' and announced it as the *last* swarm run. The board is
// sorted newest-first, so `find` returned the newest BAD run, not the newest run:
// once any run had failed, the pill read "last swarm run: failed" forever — while
// the actual newest run had completed successfully. A user-reported false alarm
// ("it says failed but the run succeeded") came straight from this line.
//
// The rule now: describe live activity if there is any, otherwise describe the
// newest run — whatever its status — so the pill can never contradict the board.
export interface BadgeRun {
  status: string
  createdAt?: number
}

export interface BadgeView {
  /** Empty string means "hide the badge". */
  text: string
  /** Alert styling: the thing being reported needs attention. */
  alert: boolean
}

const ATTENTION = new Set(['failed', 'aborted'])

export function badgeView(runs: readonly BadgeRun[] | undefined): BadgeView {
  if (!Array.isArray(runs) || runs.length === 0) return { text: '', alert: false }

  const plural = (n: number): string => (n === 1 ? '' : 's')

  // In-flight work outranks past outcomes: that is what the user cares about live.
  const running = runs.filter((r) => r.status === 'running' || r.status === 'planning').length
  if (running > 0) return { text: `🐝 ${running} swarm run${plural(running)} active`, alert: false }

  // A paused run is not progress, so it never gets the "active" wording.
  const paused = runs.filter((r) => r.status === 'paused').length
  if (paused > 0) return { text: `🐝 ${paused} swarm run${plural(paused)} paused`, alert: true }

  // Neither running nor finished: it is waiting on a human, not idle.
  const awaiting = runs.filter((r) => r.status === 'awaiting-endorsement').length
  if (awaiting > 0) {
    return { text: `🐝 ${awaiting} swarm run${plural(awaiting)} awaiting endorsement`, alert: false }
  }

  // Newest run wins, by createdAt rather than array position, so the label does
  // not depend on the server's sort order.
  const newest = runs.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a))
  return { text: `🐝 last swarm run: ${newest.status}`, alert: ATTENTION.has(newest.status) }
}
