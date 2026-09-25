// Board wire types (mirror of the host snapshot — the client never imports host code).

export interface BoardRun {
  id: string
  title: string
  spec: string
  status: string
  createdAt: number
  updatedAt: number
  endorsedAt?: number
  completedAt?: number
  taskIds: string[]
  report?: RunReport
  pauseReason?: string
  dispatch?: { cwd?: string; presetId?: string }
  stats?: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number }
  /** A8: how the board presents this run; absent means `visible`. */
  boardState?: BoardRunState
}

/** A8: the three board presentations a run can have. Nothing is ever deleted. */
export type BoardRunState = 'visible' | 'removed' | 'purged'

export interface BoardTask {
  runId: string
  id: string
  subject: string
  description: string
  role: string
  blockedBy?: string[]
  reviewBy?: string
  status: string
  attempts: number
  agent?: { label: string; provider?: string; model?: string; effort?: string }
  blockedReason?: string
  lastNote?: string
  lastNoteAt?: number
  summary?: string
  reviews?: number
  reviewFeedback?: string
  reviewed?: boolean
  reviewExhausted?: boolean
  humanReview?: boolean
  evidence?: { files?: string[]; commands?: string[] }
  writes?: string[]
  nudgedAt?: number
  updatedAt: number
}

export interface RunReport {
  completedAt: number
  durationMs: number
  taskCount: number
  byStatus: Record<string, number>
  stats: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number }
  tasks: Array<{ id: string; role: string; model?: string; status: string; reviewed?: boolean; reviewExhausted?: boolean; summary?: string }>
}

export interface BoardRole {
  id: string
  label: string
  description: string
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
  effortFallbacks?: string[]
  toolFilter?: { deny?: string[]; allow?: string[] }
  maxConcurrent?: number
  spawnTimeoutSeconds?: number
  fallbacks: Array<{ provider: string; model: string }>
  persona?: string
}

export interface BoardRuntime {
  maxConcurrent?: number
  maxTotalConcurrentAgents?: number
  spawnStaggerMs?: number
  retryBackoffBaseMs?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  nudgeAfterMinutes?: number
  staleTimeoutSeconds?: number
  spawnTimeoutSeconds?: number
}

export interface Board {
  service: string
  version: string
  seq: number
  runs: BoardRun[]
  tasks: BoardTask[]
  roles: Record<string, BoardRole>
  override?: { enabled: boolean; note?: string; setBy?: string; at: number }
  runtime?: BoardRuntime
  at: number
  /**
   * A8: the recycle bin, newest first — present only when non-empty. The server
   * excludes removed runs from `runs`/`tasks` and purged runs from BOTH lists, so
   * this is the single place the restore UI reads from; the client never filters
   * runs itself, which keeps one source of truth.
   */
  removedRuns?: BoardRemovedRun[]
}

/** A8: the lightweight shape of a removed run, as the snapshot carries it. */
export interface BoardRemovedRun {
  id: string
  title: string
  status: string
  createdAt: number
}

export interface BoardActionBody {
  action: string
  runtime?: unknown
  runId?: string
  taskId?: string
  table?: unknown
  /** A8: rename-run. */
  title?: string
  /** A8: set-run-board-state — the three board presentations. */
  state?: BoardRunState
}

type Listener = (board: Board | null, error: string | null) => void

/**
 * Board data source: full-snapshot fetch + SSE change pings (one refetch per
 * event batch). Module-level singleton — the tab mounts/unmounts freely.
 *
 * CONNECTION BUDGET: this instance owns the plugin's ONLY `/swarm/events`
 * EventSource. A browser allows ~6 concurrent connections per origin and an SSE
 * stream never ends, so every extra stream is stolen capacity. Per-card or
 * per-widget streams are what froze the web UI ("no chat history, no market
 * catalog") on 2026-09-23: the `swarm_dispatch` toolview rendered once per
 * historical dispatch, each card opened its own EventSource, and the exhausted
 * pool queued every other request on the page forever while the host stayed
 * healthy. Route live data through this store; never construct an EventSource
 * elsewhere in the client.
 */
export class BoardStore {
  private board: Board | null = null
  private error: string | null = null
  private readonly listeners = new Set<Listener>()
  private source: EventSource | null = null
  private refetchTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private refs = 0

  start(): void {
    this.stopped = false
    void this.refetch()
    if (this.source === null && typeof EventSource !== 'undefined') {
      this.source = new EventSource('/swarm/events')
      this.source.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as { seq?: number }
          if (typeof frame.seq !== 'number') return
          // J6 seq-gap resync: a skipped seq means a frame was lost — refetch
          // unconditionally instead of trusting the stale snapshot.
          if (this.board !== null && frame.seq > this.board.seq + 1) {
            void this.refetch()
            return
          }
          if (this.board === null || frame.seq > this.board.seq) this.scheduleRefetch()
        } catch {
          this.scheduleRefetch()
        }
      }
      this.source.onerror = () => {
        this.setError('stream disconnected — retrying')
      }
      this.source.onopen = () => {
        this.setError(null)
        this.scheduleRefetch()
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.source?.close()
    this.source = null
    if (this.refetchTimer !== null) clearTimeout(this.refetchTimer)
    this.refetchTimer = null
  }

  /**
   * Reference-counted lifetime for the shared singleton: the first consumer
   * starts the one stream, the last release stops it. Consumers MUST use this
   * instead of start()/stop() — with several components riding the same
   * instance, one unmount calling stop() would otherwise kill the stream every
   * other consumer still depends on.
   */
  retain(): () => void {
    this.refs += 1
    if (this.refs === 1) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.refs -= 1
      if (this.refs === 0) this.stop()
    }
  }

  get(): Board | null {
    return this.board
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.board, this.error)
    return () => this.listeners.delete(listener)
  }

  async action(body: BoardActionBody): Promise<Record<string, unknown>> {
    const response = await fetch('/swarm/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await response.json()) as Record<string, unknown>
    if (!response.ok || json.ok !== true) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${response.status}`)
    this.scheduleRefetch()
    return json
  }

  private scheduleRefetch(): void {
    if (this.stopped) return
    if (this.refetchTimer !== null) return
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null
      void this.refetch()
    }, 150)
  }

  private async refetch(): Promise<void> {
    try {
      const response = await fetch('/swarm/board')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const board = (await response.json()) as Board
      this.board = board
      this.error = null
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err)
    }
    this.notify()
  }

  private setError(error: string | null): void {
    this.error = error
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.board, this.error)
  }
}

let shared: BoardStore | null = null

export function boardStore(): BoardStore {
  if (shared === null) shared = new BoardStore()
  return shared
}
