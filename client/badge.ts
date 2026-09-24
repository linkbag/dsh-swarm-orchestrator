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
//
// Labels are injectable (index.ts passes translated templates from the locale
// service); the defaults are the original English strings.
export interface BadgeRun {
  status: string
  createdAt?: number
}

/**
 * B1: the task facts the attention rule needs. `humanReview` is sticky in the
 * projection (it records "has ever waited"), so it only counts as waiting while
 * the task still sits in `reviewing` — a resolved gate must not cry wolf forever.
 */
export interface BadgeTaskState {
  status: string
  humanReview?: boolean
}

export interface BadgeView {
  /** Empty string means "hide the badge". */
  text: string
  /** Alert styling: the thing being reported needs attention. */
  alert: boolean
}

/** Translated label templates ({n}/{plural}/{status} slots) + status word map. */
export interface BadgeLabels {
  active?: string
  paused?: string
  awaiting?: string
  last?: string
  review?: string
  status?: (status: string) => string
}

const EN_DEFAULTS: Required<Omit<BadgeLabels, 'status'>> = {
  active: '🐝 {n} swarm run{plural} active',
  paused: '🐝 {n} swarm run{plural} paused',
  awaiting: '🐝 {n} swarm run{plural} awaiting endorsement',
  last: '🐝 last swarm run: {status}',
  review: '🐝 {n} task{plural} waiting for your review',
}

const ATTENTION = new Set(['failed', 'aborted'])

export function badgeView(runs: readonly BadgeRun[] | undefined, labels?: BadgeLabels, tasks?: readonly BadgeTaskState[]): BadgeView {
  if (!Array.isArray(runs) || runs.length === 0) return { text: '', alert: false }

  const templates = { ...EN_DEFAULTS, ...labels }
  const statusWord = (status: string): string => labels?.status !== undefined ? labels.status(status) : status
  const say = (template: string, vars: Record<string, string | number>): string => {
    let text = template
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
    return text
  }
  const plural = (n: number): string => (n === 1 ? '' : 's')

  // B1: a human decision outranks everything. While anything waits on a person
  // the swarm is not progressing — however many other tasks are still running —
  // so this is the one state that must be impossible to miss (the incident: a
  // run sat blocked for a human with the badge calmly reading "1 run active").
  // Waiting = a blocked task, or a task parked in a human review gate. The
  // sticky `humanReview` flag alone does NOT count: it stays set after the
  // verdict, and permanently red would be its own false alarm. A malformed
  // tasks payload degrades to "no tasks", exactly like the runs guard above.
  const taskList = Array.isArray(tasks) ? tasks : []
  const waiting = taskList.filter((t) => t.status === 'blocked' || (t.humanReview === true && t.status === 'reviewing')).length
  if (waiting > 0) return { text: say(templates.review, { n: waiting, plural: plural(waiting) }), alert: true }

  // In-flight work outranks past outcomes: that is what the user cares about live.
  const running = runs.filter((r) => r.status === 'running' || r.status === 'planning').length
  if (running > 0) return { text: say(templates.active, { n: running, plural: plural(running) }), alert: false }

  // A paused run is not progress, so it never gets the "active" wording.
  const paused = runs.filter((r) => r.status === 'paused').length
  if (paused > 0) return { text: say(templates.paused, { n: paused, plural: plural(paused) }), alert: true }

  // Neither running nor finished: it is waiting on a human, and that IS
  // attention — nothing will move until someone endorses (B1: this branch used
  // to render non-alert, which hid exactly the state the user must act on).
  const awaiting = runs.filter((r) => r.status === 'awaiting-endorsement').length
  if (awaiting > 0) {
    return { text: say(templates.awaiting, { n: awaiting, plural: plural(awaiting) }), alert: true }
  }

  // Newest run wins, by createdAt rather than array position, so the label does
  // not depend on the server's sort order.
  const newest = runs.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a))
  return { text: say(templates.last, { status: statusWord(newest.status) }), alert: ATTENTION.has(newest.status) }
}
