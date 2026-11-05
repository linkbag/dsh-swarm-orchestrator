import type { EventStore } from './domain/event-store.js'
import { digestWorkItemValue, type WorkItemCheckpoint, type WorkItemCheckpointAdapter } from './work-items.js'

const KIND = 'work-item/checkpoint'
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024

/** Durable whole-record CAS over the existing exclusive append authority. No
 * second store, timers, resends or scheduler. The caller owns and drains workers
 * before closing EventStore; use a quiescent read-only copy for inspection. */
export class EventWorkItemCheckpoints implements WorkItemCheckpointAdapter {
  constructor(private readonly events: EventStore) {}

  private current(runId: string): WorkItemCheckpoint | null {
    let current: WorkItemCheckpoint | null = null
    for (const event of this.events.all()) {
      if (event.kind !== KIND || event.runId !== runId) continue
      const next = event.data?.checkpoint as WorkItemCheckpoint | undefined
      if (next === undefined || next.version !== 1 || next.manifest?.runId !== runId || next.revision !== (current === null ? 0 : current.revision + 1)) throw new Error('invalid work-item checkpoint history')
      const { digest, ...body } = next
      if (digest !== digestWorkItemValue(body)) throw new Error('work-item checkpoint digest mismatch')
      current = next
    }
    return current
  }

  async load(runId: string): Promise<WorkItemCheckpoint | null> {
    const current = this.current(runId)
    return current === null ? null : structuredClone(current)
  }

  async compareAndSet(runId: string, expectedRevision: number | null, next: WorkItemCheckpoint): Promise<boolean> {
    // No await between comparison and the synchronous fsync-before-publish append.
    const current = this.current(runId)
    if ((current?.revision ?? null) !== expectedRevision) return false
    if (next.version !== 1 || next.manifest.runId !== runId || next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error('invalid checkpoint CAS transition')
    const { digest, ...body } = next
    if (digest !== digestWorkItemValue(body)) throw new Error('invalid checkpoint digest')
    const json = JSON.stringify(next)
    if (Buffer.byteLength(json, 'utf8') > MAX_CHECKPOINT_BYTES) throw new Error('checkpoint exceeds 4 MiB: persist artifact references instead of raw output')
    this.events.append(KIND, { runId, data: { checkpoint: JSON.parse(json) as Record<string, unknown> } })
    return true
  }
}
