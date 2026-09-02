import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SwarmEventRecord } from './types.js'

/**
 * Append-only JSONL event store: the single source of truth for run/task state.
 * Every mutation is one appended event; the projection folds events into the
 * board. Sequence numbers are monotonic and gap-free per file.
 */
export class EventStore {
  private events: SwarmEventRecord[] = []
  private readonly listeners = new Set<(event: SwarmEventRecord) => void>()

  constructor(readonly file: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    let maxSeq = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as SwarmEventRecord
        if (typeof parsed.seq === 'number' && typeof parsed.kind === 'string') {
          this.events.push(parsed)
          maxSeq = Math.max(maxSeq, parsed.seq)
        }
      } catch {
        // Skip malformed lines defensively; the log stays append-only.
      }
    }
    this.nextSeq = maxSeq + 1
  }

  private nextSeq = 1

  get seq(): number {
    return this.nextSeq - 1
  }

  all(): readonly SwarmEventRecord[] {
    return this.events
  }

  append(kind: string, fields: Omit<SwarmEventRecord, 'seq' | 'at' | 'kind'> = {}): SwarmEventRecord {
    const event: SwarmEventRecord = { seq: this.nextSeq++, at: Date.now(), kind, ...fields }
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8')
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
    return event
  }

  subscribe(listener: (event: SwarmEventRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
