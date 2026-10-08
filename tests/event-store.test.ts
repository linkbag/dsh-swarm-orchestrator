import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/domain/event-store.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }))

const PREFIX = 'swarm-hardening-storage-events-'
const cleanups: string[] = []
function tempStore(): { store: EventStore; dir: string; file: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), PREFIX))
  cleanups.push(dir)
  const file = join(dir, 'events.jsonl')
  return { store: new EventStore(file), dir, file }
}
const line = (seq: number): string => JSON.stringify({ seq, at: 1, kind: 'test/event' })

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of cleanups.splice(0)) {
    expect(dir.startsWith(join(tmpdir(), PREFIX))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('event store', () => {
  it('appends with monotonic seq, persists records and reloads continuity', () => {
    const { store, file } = tempStore()
    expect(store.append('run/created', { runId: 'run-1', data: { title: 't' } }).seq).toBe(1)
    expect(store.append('task/started', { runId: 'run-1', taskId: 'a' }).seq).toBe(2)
    const reopened = new EventStore(file)
    expect(reopened.all()).toHaveLength(2)
    expect(reopened.seq).toBe(2)
    expect(reopened.append('task/completed', { runId: 'run-1', taskId: 'a' }).seq).toBe(3)
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('notifies subscribers and unsubscribes', () => {
    const { store } = tempStore()
    const seen: string[] = []
    const unsubscribe = store.subscribe((event) => seen.push(event.kind))
    store.append('task/heartbeat')
    unsubscribe()
    store.append('task/heartbeat')
    expect(seen).toEqual(['task/heartbeat'])
  })

  it('quarantines only the torn EOF tail before the next append and reload', () => {
    const { file, dir } = tempStore()
    const partial = '{"seq":2,"at":1,"kind":"task'
    fs.writeFileSync(file, line(1) + '\n' + partial)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reopened = new EventStore(file)
    expect(reopened.seq).toBe(1)
    expect(reopened.diagnostics[0]).toMatch(/repaired incomplete event tail/)
    const quarantine = fs.readdirSync(dir).find((name) => name.includes('.corrupt-tail-'))!
    expect(fs.readFileSync(join(dir, quarantine), 'utf8')).toBe(partial)
    expect(fs.readFileSync(file, 'utf8')).toBe(line(1) + '\n')
    expect(reopened.append('task/completed').seq).toBe(2)
    const again = new EventStore(file)
    expect(again.all().map((event) => event.seq)).toEqual([1, 2])
  })

  it('preserves a complete valid no-newline EOF record and separates the next append', () => {
    const { file, dir } = tempStore()
    fs.writeFileSync(file, line(1))
    const reopened = new EventStore(file)
    expect(reopened.all()).toHaveLength(1)
    expect(fs.readFileSync(file, 'utf8')).toBe(line(1))
    expect(fs.readdirSync(dir)).toEqual(['events.jsonl'])
    reopened.append('task/started')
    expect(fs.readFileSync(file, 'utf8').startsWith(line(1) + '\n')).toBe(true)
    expect(new EventStore(file).all()).toHaveLength(2)
  })

  it.each([
    [line(1) + '\nthis is not json\n' + line(2) + '\n', 2],
    [line(1) + '\n{"seq":2\n', 2],
    [line(1) + '\n{"seq":2,"kind":"missing timestamp"}', 2],
    [line(1) + '\nthis is not json', 2],
    [line(1) + '\n' + line(1) + '\n', 2],
  ])('surfaces complete/interior corruption without modifying source bytes', (raw, number) => {
    const { file, dir } = tempStore()
    fs.writeFileSync(file, raw)
    expect(() => new EventStore(file)).toThrow(new RegExp(`corrupt event store .* at line ${number}`))
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    expect(fs.readdirSync(dir)).toEqual(['events.jsonl'])
  })

  it('replays distinct legacy sequence collisions losslessly without changing historical bytes', () => {
    const { file } = tempStore()
    const raw = line(1) + '\n' + JSON.stringify({ seq: 1, at: 2, kind: 'run/endorsed' }) + '\n' + JSON.stringify({ seq: 2, at: 3, kind: 'task/started' }) + '\n'
    fs.writeFileSync(file, raw)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const replay = new EventStore(file)
    expect(replay.all().map((event) => [event.seq, event.storedSeq])).toEqual([[1, undefined], [2, 1], [3, 2]])
    expect(replay.diagnostics[0]).toContain('original storedSeq values and source bytes preserved')
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    const committed = replay.append('run/completed')
    expect(committed.seq).toBe(4)
    expect(committed.storeVersion).toBe(2)
    expect(fs.readFileSync(file, 'utf8').startsWith(raw)).toBe(true)
    const reopened = new EventStore(file)
    expect(reopened.all()).toEqual(replay.all())
    expect(reopened.seq).toBe(4)
  })

  it.each([true, false])('refuses sequence resets after strict format starts, including mixed old writers (%s)', (marked) => {
    const { store, file } = tempStore()
    store.append('run/created')
    fs.appendFileSync(file, JSON.stringify({ seq: 1, at: 2, kind: 'run/endorsed', ...(marked ? { storeVersion: 2 } : {}) }) + '\n')
    const before = fs.readFileSync(file, 'utf8')
    expect(() => new EventStore(file)).toThrow(/non-increasing sequence/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('makes storage read failures visible', () => {
    const { file } = tempStore()
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('injected read failure'), { code: 'EACCES' }) })
    expect(() => new EventStore(file)).toThrow(/cannot read event store .*injected read failure/)
  })

  it('does not commit sequence or notify when append fails', () => {
    const { store, file } = tempStore()
    store.append('run/created')
    const seen = vi.fn()
    store.subscribe(seen)
    vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => { throw new Error('injected append failure') })
    expect(() => store.append('task/started')).toThrow(/injected append failure/)
    expect(store.seq).toBe(1)
    expect(store.all()).toHaveLength(1)
    expect(seen).not.toHaveBeenCalled()
    expect(store.append('task/completed').seq).toBe(2)
    expect(new EventStore(file).all().map((event) => event.seq)).toEqual([1, 2])
  })

  it('rolls back a short write and an fsync failure so the same store can retry', () => {
    const { store, file } = tempStore()
    store.append('run/created')
    const before = fs.readFileSync(file, 'utf8')
    vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((descriptor, data) => {
      fs.writeFileSync(descriptor, String(data).slice(0, 12))
      throw new Error('injected partial write')
    })
    expect(() => store.append('task/started')).toThrow(/partial write/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected fsync failure') })
    expect(() => store.append('task/started')).toThrow(/fsync failure/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(store.append('task/completed').seq).toBe(2)
    expect(new EventStore(file).all()).toHaveLength(2)
  })

  it('contains a throwing listener and still publishes to the next observer', () => {
    const { store, file } = tempStore()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.subscribe(() => { throw new Error('injected observer failure') })
    const seen = vi.fn()
    store.subscribe(seen)
    expect(() => store.append('run/created')).not.toThrow()
    expect(seen).toHaveBeenCalledOnce()
    expect(store.seq).toBe(1)
    expect(new EventStore(file).seq).toBe(1)
    expect(store.diagnostics[0]).toMatch(/observer failure/)
  })

  it('contains unprintable listener throws and a throwing diagnostic sink', () => {
    const { store } = tempStore()
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('diagnostic sink unavailable') })
    store.subscribe(() => { throw { toString() { throw new Error('cannot print') } } })
    const seen = vi.fn()
    store.subscribe(seen)
    expect(() => store.append('run/created')).not.toThrow()
    expect(seen).toHaveBeenCalledOnce()
    expect(store.diagnostics[0]).toContain('unprintable observer error')
  })

  it('closes a descriptor when file-stat fails without consuming a sequence', () => {
    const { store } = tempStore()
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce(() => { throw new Error('injected stat failure') })
    expect(() => store.append('run/created')).toThrow(/stat failure/)
    expect(close).toHaveBeenCalledOnce()
    expect(store.seq).toBe(0)
    expect(store.append('run/created').seq).toBe(1)
  })

  it('prevents same-process retries when rollback fails and requires reload', () => {
    const { store, file } = tempStore()
    store.append('run/created')
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((descriptor, data) => {
      fs.writeFileSync(descriptor, String(data).slice(0, 12))
      throw new Error('injected partial write')
    })
    vi.spyOn(fs, 'ftruncateSync').mockImplementationOnce(() => { throw new Error('injected rollback failure') })
    expect(() => store.append('task/started')).toThrow(/needs reload after failed append rollback/)
    expect(store.seq).toBe(1)
    expect(() => store.append('task/completed')).toThrow(/needs reload/)
    expect(append).toHaveBeenCalledOnce()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reloaded = new EventStore(file)
    expect(reloaded.seq).toBe(1)
    expect(reloaded.append('task/completed').seq).toBe(2)
  })

  it('rejects an untyped root toJSON envelope rewrite before writing', () => {
    const { store, file } = tempStore()
    expect(() => store.append('run/created', { toJSON: () => ({ seq: 999, at: 1, kind: 'spoof' }) } as never)).toThrow(/unknown field/)
    expect(store.seq).toBe(0)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('authoritative seq/kind/timestamp cannot be spoofed by untyped fields', () => {
    const { store } = tempStore()
    const event = store.append('run/created', { seq: 200, at: 0, kind: 'spoofed' } as never)
    expect(event.seq).toBe(1)
    expect(event.kind).toBe('run/created')
    expect(event.at).toBeGreaterThan(0)
  })
})
