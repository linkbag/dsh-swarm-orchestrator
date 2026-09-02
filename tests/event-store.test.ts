import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/domain/event-store.js'

function tempStore(): { store: EventStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-events-'))
  return { store: new EventStore(join(dir, 'events.jsonl')), dir }
}

describe('event store', () => {
  const cleanups: string[] = []
  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('appends with monotonic seq and persists lines', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const first = store.append('run/created', { runId: 'run-1', data: { title: 't' } })
    const second = store.append('task/started', { runId: 'run-1', taskId: 'a' })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(store.seq).toBe(2)
    const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    expect(raw.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(2)
  })

  it('reloads events from disk with seq continuity', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    store.append('run/created', { runId: 'run-1' })
    store.append('run/endorsed', { runId: 'run-1' })
    const reopened = new EventStore(join(dir, 'events.jsonl'))
    expect(reopened.all()).toHaveLength(2)
    expect(reopened.seq).toBe(2)
    const third = reopened.append('task/completed', { runId: 'run-1', taskId: 'a' })
    expect(third.seq).toBe(3)
  })

  it('notifies subscribers on append', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const seen: string[] = []
    const unsubscribe = store.subscribe((event) => seen.push(event.kind))
    store.append('task/heartbeat', { runId: 'r', taskId: 'a' })
    unsubscribe()
    store.append('task/heartbeat', { runId: 'r', taskId: 'a' })
    expect(seen).toEqual(['task/heartbeat'])
  })

  it('skips malformed lines on reload', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    store.append('run/created', { runId: 'run-1' })
    const file = join(dir, 'events.jsonl')
    appendFileSync(file, 'this is not json\n', 'utf8')
    const reopened = new EventStore(file)
    expect(reopened.all()).toHaveLength(1)
    expect(reopened.seq).toBe(1)
  })
})
