// Board wire types (mirror of the host snapshot without importing the host runtime).

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
  planPath?: string
  pauseReason?: string
  dispatch?: { cwd?: string; presetId?: string }
  stats?: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number; reviewsUnavailable?: number }
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
  /** Builder identity; reviewer identity is separate on newer hosts. */
  agent?: { label: string; provider?: string; model?: string; effort?: string; requestedEffort?: string }
  reviewerAgent?: { label: string; provider?: string; model?: string; effort?: string; requestedEffort?: string }
  attemptRevoked?: boolean
  reviewGate?: 'agent' | 'human'
  reviewQueueInfo?: Record<string, unknown>
  fileWarnings?: string[]
  evidenceOutcomes?: Array<Record<string, unknown>>
  blockedReason?: string
  lastNote?: string
  lastNoteAt?: number
  summary?: string
  reviews?: number
  reviewFeedback?: string
  reviewed?: boolean
  reviewExhausted?: boolean
  reviewUnavailable?: boolean
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
  stats: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number; reviewsUnavailable?: number }
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
  maxRetries?: number
  reviewLoops?: number
  evidenceTimeoutMs?: number
}

export interface Board {
  service: string
  version: string
  /**
   * B1: dashboard actions the host serves. Absent on hosts older than the guard,
   * which is why client/version.ts falls back to version math and then fails open.
   */
  capabilities?: string[]
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
  verdict?: string
}

export type BoardSyncState = 'connecting' | 'live' | 'catching-up' | 'reconnecting' | 'snapshot' | 'stopped'
type Listener = (board: Board | null, error: string | null, sync: BoardSyncState) => void

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
  private fetchError: string | null = null
  private streamError: string | null = null
  private readonly listeners = new Set<Listener>()
  private source: EventSource | null = null
  private stream: 'connecting' | 'connected' | 'reconnecting' | 'unavailable' = 'connecting'
  private refetchTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private refs = 0
  private generation = 0
  private inFlight: AbortController | null = null
  private trailing = false
  private latestSeq = 0
  /** A successful mutation fences any snapshot that started before its ACK. */
  private mutationRevision = 0

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const generation = ++this.generation
    this.streamError = null
    this.latestSeq = this.board?.seq ?? 0
    this.stream = typeof EventSource === 'undefined' ? 'unavailable' : 'connecting'
    this.refresh()
    if (this.source === null && typeof EventSource !== 'undefined') {
      let source: EventSource
      try {
        source = new EventSource('/swarm/events')
      } catch {
        this.stream = 'unavailable'
        this.streamError = 'live stream unavailable — showing last snapshot'
        this.notify()
        return
      }
      this.source = source
      const owns = (): boolean => !this.stopped && this.generation === generation && this.source === source
      source.onmessage = (event) => {
        if (!owns()) return
        try {
          const frame = JSON.parse(event.data) as { seq?: number }
          if (typeof frame.seq !== 'number' || !Number.isSafeInteger(frame.seq) || frame.seq < 0) return
          this.latestSeq = Math.max(this.latestSeq, frame.seq)
          if (this.board === null || frame.seq > this.board.seq) {
            // Gaps need an immediate resync; ordinary bursts share one debounce.
            if (this.board !== null && frame.seq > this.board.seq + 1) this.refresh()
            else this.scheduleRefetch()
          }
        } catch {
          this.scheduleRefetch()
        }
      }
      source.onerror = () => {
        if (!owns()) return
        this.stream = 'reconnecting'
        this.streamError = 'stream disconnected — reconnecting; showing last snapshot'
        this.notify()
      }
      source.onopen = () => {
        if (!owns()) return
        this.stream = 'connected'
        this.streamError = null
        // Opening the stream is NOT proof a failed board fetch recovered.
        this.refresh()
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.source?.close()
    this.source = null
    if (this.refetchTimer !== null) clearTimeout(this.refetchTimer)
    this.refetchTimer = null
    this.inFlight?.abort()
    this.inFlight = null
    this.trailing = false
    this.notify()
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
    listener(this.board, this.fetchError ?? this.streamError, this.getSyncState())
    return () => this.listeners.delete(listener)
  }

  async action(body: BoardActionBody, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const generation = this.generation
    const response = await fetch('/swarm/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await response.json()) as Record<string, unknown>
    if (signal?.aborted) throw new Error('request cancelled')
    if (!response.ok || json.ok !== true) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${response.status}`)
    if (generation === this.generation) {
      this.mutationRevision += 1
      this.scheduleRefetch()
    }
    return json
  }

  getSyncState(): BoardSyncState {
    if (this.stopped) return 'stopped'
    if (this.stream === 'reconnecting') return 'reconnecting'
    if (this.board === null) return 'connecting'
    if (this.fetchError !== null || this.inFlight !== null || this.refetchTimer !== null || this.latestSeq > this.board.seq) return 'catching-up'
    return this.stream === 'connected' ? 'live' : this.stream === 'unavailable' ? 'snapshot' : 'connecting'
  }

  /** At most one fetch per lifetime, with one trailing refresh for a burst. */
  refresh(): void {
    if (this.stopped) return
    if (this.refetchTimer !== null) clearTimeout(this.refetchTimer)
    this.refetchTimer = null
    if (this.inFlight !== null) {
      this.trailing = true
      return
    }
    void this.refetch()
  }

  private scheduleRefetch(delay = 150): void {
    if (this.stopped) return
    if (this.inFlight !== null) {
      this.trailing = true
      this.notify()
      return
    }
    if (this.refetchTimer !== null) return
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null
      this.refresh()
    }, delay)
    this.notify()
  }

  private async refetch(): Promise<void> {
    const generation = this.generation
    const mutationRevision = this.mutationRevision
    const controller = new AbortController()
    this.inFlight = controller
    this.trailing = false
    const owns = (): boolean => !this.stopped && this.generation === generation && this.inFlight === controller && !controller.signal.aborted
    let failed = false
    this.notify()
    try {
      const response = await fetch('/swarm/board', { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const board = (await response.json()) as Board
      if (!owns() || mutationRevision !== this.mutationRevision) return
      if (board === null || !Number.isSafeInteger(board.seq) || board.seq < 0 || !Number.isFinite(board.at) || !Array.isArray(board.runs) || !Array.isArray(board.tasks) || board.roles === null || Array.isArray(board.roles) || typeof board.roles !== 'object') {
        throw new Error('invalid board snapshot')
      }
      // Even a later request can be answered by an older cached snapshot.
      if (this.board !== null && (board.seq < this.board.seq || (board.seq === this.board.seq && board.at < this.board.at))) throw new Error('stale board snapshot — retrying')
      this.board = board
      this.fetchError = null
    } catch (err) {
      if (!owns() || mutationRevision !== this.mutationRevision) return
      failed = true
      this.fetchError = String(err instanceof Error ? err.message : err)
    } finally {
      // An old, aborted promise must not clear a newer lifetime's request.
      if (owns()) {
        this.inFlight = null
        const again = this.trailing || this.latestSeq > (this.board?.seq ?? -1)
        this.trailing = false
        if (failed || again) this.scheduleRefetch(failed ? 3000 : 150)
        this.notify()
      }
    }
  }

  private notify(): void {
    const error = this.fetchError ?? this.streamError
    const sync = this.getSyncState()
    for (const listener of this.listeners) listener(this.board, error, sync)
  }
}

let shared: BoardStore | null = null

export function boardStore(): BoardStore {
  if (shared === null) shared = new BoardStore()
  return shared
}
