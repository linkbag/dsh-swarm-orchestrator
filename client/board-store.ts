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
  stats?: { fallbacks: number; retries: number; reviewsPassed: number; reviewsRejected: number }
}

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
  agent?: { label: string; provider?: string; model?: string }
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
  fallbacks: Array<{ provider: string; model: string }>
  persona?: string
}

export interface Board {
  service: string
  version: string
  seq: number
  runs: BoardRun[]
  tasks: BoardTask[]
  roles: Record<string, BoardRole>
  override?: { enabled: boolean; note?: string; setBy?: string; at: number }
  at: number
}

export interface BoardActionBody {
  action: string
  runId?: string
  taskId?: string
  table?: unknown
}

type Listener = (board: Board | null, error: string | null) => void

/**
 * Board data source: full-snapshot fetch + SSE change pings (one refetch per
 * event batch). Module-level singleton — the tab mounts/unmounts freely.
 */
export class BoardStore {
  private board: Board | null = null
  private error: string | null = null
  private readonly listeners = new Set<Listener>()
  private source: EventSource | null = null
  private refetchTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

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
