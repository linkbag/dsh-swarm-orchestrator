import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import ts from 'typescript'
import { EventStore, type EventStoreOptions } from '../src/domain/event-store.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }))

const PREFIX = 'swarm-owned-store-'
const directories: string[] = []
const stores: EventStore[] = []
const children: Array<{ child: ChildProcess; done: Promise<void> }> = []
const line = (seq: number, kind = 'test/event'): string => JSON.stringify({ seq, at: 1, kind })

function fixture(): { dir: string; file: string; marker: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), PREFIX))
  directories.push(dir)
  const file = join(dir, 'events.jsonl')
  return { dir, file, marker: `${file}.owner` }
}

function open(file: string, options?: EventStoreOptions): EventStore {
  const store = new EventStore(file, options)
  stores.push(store)
  return store
}

// Compile only the three dependency-free storage modules into an OWNED tmpdir.
// Real child processes load current source, not possibly stale lib artifacts.
// No shell, bundled host, profile, models, IPC pipe or captured stdio is involved.
function childProgram(dir: string): string {
  const modules = join(dir, 'child-modules')
  fs.mkdirSync(modules)
  fs.writeFileSync(join(modules, 'package.json'), '{"type":"module"}')
  for (const name of ['event-store', 'store-ownership', 'limits']) {
    const source = fs.readFileSync(new URL(`../src/domain/${name}.ts`, import.meta.url), 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    fs.writeFileSync(join(modules, `${name}.js`), output)
  }
  const script = join(modules, 'writer.mjs')
  fs.writeFileSync(script, `
import { EventStore } from './event-store.js'
import { existsSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
const [file, result, mode, control] = process.argv.slice(2)
try {
  const store = new EventStore(file)
  store.append('child/before-pause')
  if (mode === 'hold') {
    let resumed = false
    const watcher = watch(dirname(control), (_event, name) => {
      if (resumed || String(name) !== basename(control) || !existsSync(control)) return
      resumed = true
      watcher.close()
      try {
        store.append('child/after-resume')
        store.close()
        writeFileSync(result + '.done', JSON.stringify({ ok: true }))
      } catch (error) {
        writeFileSync(result + '.done', JSON.stringify({ ok: false, message: String(error) }))
        process.exitCode = 1
      }
    })
    writeFileSync(result, JSON.stringify({ ok: true, pid: process.pid }))
  } else {
    // Deliberately simulate process death/exit without disposal in crash mode.
    if (mode !== 'crash') store.close()
    writeFileSync(result, JSON.stringify({ ok: true }))
  }
} catch (error) {
  writeFileSync(result, JSON.stringify({ ok: false, message: String(error) }))
}
`)
  return script
}

function runWriter(script: string, file: string, result: string, mode = 'once'): { ok: boolean; message?: string } {
  const run = spawnSync(process.execPath, [script, file, result, mode], {
    cwd: dirname(script), stdio: 'ignore', timeout: 10000,
    env: { ...process.env, HOME: dirname(script), USERPROFILE: dirname(script), NODE_OPTIONS: '' },
  })
  expect(run.error).toBeUndefined()
  expect(run.signal).toBeNull()
  expect(run.status).toBe(0)
  return JSON.parse(fs.readFileSync(result, 'utf8'))
}

function launchWriter(script: string, file: string, result: string, control: string): ChildProcess {
  const child = spawn(process.execPath, [script, file, result, 'hold', control], {
    cwd: dirname(script), stdio: 'ignore',
    env: { ...process.env, HOME: dirname(script), USERPROFILE: dirname(script), NODE_OPTIONS: '' },
  })
  const done = new Promise<void>((resolve) => {
    child.once('error', () => resolve())
    child.once('exit', () => resolve())
  })
  children.push({ child, done })
  return child
}

async function waitForFile(file: string, child: ChildProcess): Promise<void> {
  if (fs.existsSync(file)) return
  await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(dirname(file), (_event, name) => {
      if (String(name) === basename(file) && fs.existsSync(file)) finish()
    })
    const timer = setTimeout(() => finish(new Error(`timed out waiting for owned fixture ${file}`)), 10000)
    const onError = (error: Error): void => finish(error)
    const onExit = (): void => finish(fs.existsSync(file) ? undefined : new Error('fixture writer exited before signaling'))
    function finish(error?: Error): void {
      clearTimeout(timer)
      watcher.close()
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', onError)
    child.once('exit', onExit)
    if (fs.existsSync(file)) finish()
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const { child, done } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done
  }
  for (const store of stores.splice(0)) store.close()
  for (const dir of directories.splice(0)) {
    expect(dir.startsWith(join(tmpdir(), PREFIX))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('exclusive store lifetime', () => {
  it('owns even a not-yet-created event file and releases only on close', () => {
    const { file, marker } = fixture()
    const store = open(file)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(marker)).toBe(true)
    expect(() => open(file)).toThrow(/already owned.*no automatic stale takeover/)
    store.append('first')
    store.close()
    expect(fs.existsSync(marker)).toBe(false)
    const successor = open(file)
    expect(successor.append('second').seq).toBe(2)
    // Repeated old-owner disposal cannot delete its successor's marker.
    store.dispose(); store.close()
    expect(() => open(file)).toThrow(/already owned/)
  })

  it('refuses a second writer before reading or attempting tail repair', () => {
    const { file, dir } = fixture()
    const store = open(file)
    store.append('first')
    fs.appendFileSync(file, '{"seq":2')
    const read = vi.spyOn(fs, 'readFileSync')
    const truncate = vi.spyOn(fs, 'ftruncateSync')
    expect(() => open(file)).toThrow(/already owned/)
    expect(read).not.toHaveBeenCalled()
    expect(truncate).not.toHaveBeenCalled()
    expect(fs.readdirSync(dir).some((name) => name.includes('corrupt-tail'))).toBe(false)
  })

  it('holds ownership throughout constructor repair', () => {
    const { file, dir, marker } = fixture()
    const partial = '{"seq":2,"at":1,"kind":"torn'
    fs.writeFileSync(file, line(1) + '\n' + partial)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const truncate = fs.ftruncateSync
    vi.spyOn(fs, 'ftruncateSync').mockImplementation((descriptor, length) => {
      expect(fs.existsSync(marker)).toBe(true)
      expect(() => open(file)).toThrow(/already owned/)
      truncate(descriptor, length)
    })
    const store = open(file)
    expect(store.seq).toBe(1)
    expect(fs.readFileSync(file, 'utf8')).toBe(line(1) + '\n')
    const quarantine = fs.readdirSync(dir).find((name) => name.includes('corrupt-tail'))!
    expect(fs.readFileSync(join(dir, quarantine), 'utf8')).toBe(partial)
    expect(store.append('repaired').seq).toBe(2)
  })

  it('holds ownership through append, failed fsync, rollback and data-handle close', () => {
    const { file, marker } = fixture()
    const store = open(file)
    store.append('first')
    const before = fs.readFileSync(file, 'utf8')
    const seen = vi.fn()
    store.subscribe(seen)
    const assertOwned = (): void => {
      expect(fs.existsSync(marker)).toBe(true)
      expect(() => open(file)).toThrow(/already owned/)
      expect(() => store.close()).toThrow(/during append/)
    }
    const append = fs.appendFileSync
    const sync = fs.fsyncSync
    const truncate = fs.ftruncateSync
    const close = fs.closeSync
    vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((...args) => { assertOwned(); append(...args) })
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { assertOwned(); throw new Error('injected fsync failure') })
      .mockImplementationOnce((descriptor) => { assertOwned(); sync(descriptor) })
    vi.spyOn(fs, 'ftruncateSync').mockImplementationOnce((...args) => { assertOwned(); truncate(...args) })
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => { assertOwned(); close(descriptor) })
    expect(() => store.append('not-committed')).toThrow(/injected fsync failure/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(store.seq).toBe(1)
    expect(seen).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(store.append('retried').seq).toBe(2)
  })

  it('cannot release ownership from caller serialization or append reentrantly', () => {
    const { file } = fixture()
    const store = open(file)
    expect(() => store.append('outer', { data: { toJSON() { store.close(); return {} } } })).toThrow(/during append/)
    expect(store.closed).toBe(false)
    expect(() => store.append('outer', { data: { toJSON() { store.append('inner'); return {} } } })).toThrow(/reentrantly/)
    expect(store.seq).toBe(0)
    expect(() => open(file)).toThrow(/already owned/)
    expect(store.append('normal').seq).toBe(1)
  })

  it('refuses operations after idempotent close/dispose', () => {
    const { file } = fixture()
    const store = open(file)
    const release = store.subscribe(() => {})
    store.close(); store.close(); store.dispose(); release(); release()
    expect(store.closed).toBe(true)
    expect(() => store.append('late')).toThrow(/is closed/)
    expect(() => store.subscribe(() => {})).toThrow(/is closed/)
    expect(() => store.all()).toThrow(/is closed/)
    expect(() => store.seq).toThrow(/is closed/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('does not expire an old marker or infer takeover from dead-PID metadata', () => {
    const { file, marker } = fixture()
    fs.writeFileSync(file, line(1) + '\n')
    fs.writeFileSync(marker, JSON.stringify({ pid: 999999999, nonce: 'not-a-fencing-token' }))
    fs.utimesSync(marker, new Date(0), new Date(0))
    const before = fs.readFileSync(marker, 'utf8')
    expect(() => open(file)).toThrow(/unreclaimed ownership marker.*no automatic stale takeover/)
    expect(fs.readFileSync(marker, 'utf8')).toBe(before)
    const replay = open(file, { readOnly: true })
    expect(replay.seq).toBe(1)
  })

  it('does not unlink a replacement marker or keep writing after ownership loss', () => {
    const { file, marker } = fixture()
    const store = open(file)
    store.append('first')
    fs.renameSync(marker, marker + '.old')
    fs.writeFileSync(marker, 'replacement owner')
    expect(() => store.append('unsafe')).toThrow(/ownership marker changed/)
    expect(() => store.close()).toThrow(/ownership marker was not removed/)
    expect(store.closed).toBe(true)
    expect(fs.readFileSync(marker, 'utf8')).toBe('replacement owner')
    expect(open(file, { readOnly: true }).seq).toBe(1)
  })

  it('leaves an uncertain close fail-closed and never retries an OS descriptor', () => {
    const { file, marker } = fixture()
    const store = open(file)
    const close = fs.closeSync
    const mocked = vi.spyOn(fs, 'closeSync').mockImplementationOnce((descriptor) => {
      close(descriptor)
      throw new Error('injected ambiguous close')
    })
    expect(() => store.close()).toThrow(/ownership marker was not removed/)
    store.dispose(); store.close()
    expect(mocked).toHaveBeenCalledOnce()
    expect(fs.existsSync(marker)).toBe(true)
    expect(() => open(file)).toThrow(/already owned/)
  })

  it('rejects file aliases it cannot safely serialize', () => {
    const { file, dir } = fixture()
    fs.writeFileSync(file, line(1) + '\n')
    const alias = join(dir, 'hardlink.jsonl')
    fs.linkSync(file, alias)
    expect(() => open(file)).toThrow(/single-link file/)
    expect(() => open(alias)).toThrow(/single-link file/)
    expect(open(alias, { readOnly: true }).seq).toBe(1)
  })

  it('canonicalizes parent directory junction/symlink aliases', () => {
    const { file, dir } = fixture()
    const alias = join(dir, 'alias')
    const target = join(dir, 'target')
    fs.mkdirSync(target)
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const owned = open(join(target, basename(file)))
    expect(() => open(join(alias, basename(file)))).toThrow(/already owned/)
    owned.append('through-canonical-parent')
    expect(() => open(join(alias, basename(file)))).toThrow(/already owned/)
  })
})

describe('failed-open rollback', () => {
  it('releases constructor ownership on complete corruption without altering history', () => {
    const { file, dir, marker } = fixture()
    const corrupt = line(1) + '\ncomplete garbage\n'
    fs.writeFileSync(file, corrupt)
    expect(() => open(file)).toThrow(/corrupt event store .* at line 2/)
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual(['events.jsonl'])
    fs.writeFileSync(file, line(1) + '\n')
    expect(open(file).append('fixed-by-fixture').seq).toBe(2)
  })

  it('releases constructor ownership on read failure', () => {
    const { file, marker } = fixture()
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('injected read denial'), { code: 'EACCES' }) })
    expect(() => open(file)).toThrow(/cannot read event store .*injected read denial/)
    expect(fs.existsSync(marker)).toBe(false)
    expect(open(file).seq).toBe(0)
  })

  it('rolls back marker initialization failure without creating the store', () => {
    const { file, dir } = fixture()
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected marker fsync failure') })
    expect(() => open(file)).toThrow(/cannot initialize event store ownership.*marker fsync failure/)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(open(file).seq).toBe(0)
  })

  it('releases ownership if tail repair fails and preserves quarantined evidence', () => {
    const { file, dir, marker } = fixture()
    const raw = line(1) + '\n{"seq":2'
    fs.writeFileSync(file, raw)
    vi.spyOn(fs, 'ftruncateSync').mockImplementationOnce(() => { throw new Error('injected tail repair failure') })
    expect(() => open(file)).toThrow(/injected tail repair failure/)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    const quarantine = fs.readdirSync(dir).find((name) => name.includes('corrupt-tail'))!
    expect(fs.readFileSync(join(dir, quarantine), 'utf8')).toBe('{"seq":2')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(open(file).append('after-recovery').seq).toBe(2)
  })

  it('surfaces BOTH open and cleanup failures while leaving the marker fail-closed', () => {
    const { file, marker } = fixture()
    fs.writeFileSync(file, 'complete garbage\n')
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('injected unlink failure') })
    let thrown: unknown
    try { open(file) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).message).toMatch(/ownership cleanup failed/)
    expect(String((thrown as AggregateError).errors[0])).toMatch(/corrupt event store/)
    expect((thrown as AggregateError).errors[1]).toBeInstanceOf(AggregateError)
    expect(fs.existsSync(marker)).toBe(true)
    expect(() => open(file)).toThrow(/already owned/)
  })
})

describe('explicit read-only snapshots', () => {
  it('reads alongside a writer without taking ownership, writes or live tailing', () => {
    const { file, marker } = fixture()
    const writer = open(file)
    writer.append('first')
    const create = vi.spyOn(fs, 'openSync')
    const mkdir = vi.spyOn(fs, 'mkdirSync')
    const write = vi.spyOn(fs, 'writeFileSync')
    const truncate = vi.spyOn(fs, 'ftruncateSync')
    const replay = open(file, { readOnly: true })
    expect(replay.readOnly).toBe(true)
    expect(replay.seq).toBe(1)
    expect(create).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(truncate).not.toHaveBeenCalled()
    expect(() => replay.append('forbidden')).toThrow(/read-only/)
    replay.dispose()
    expect(fs.existsSync(marker)).toBe(true)
    expect(() => open(file)).toThrow(/already owned/)
    const snapshot = open(file, { readOnly: true })
    writer.append('second')
    expect(snapshot.seq).toBe(1)
  })

  it('fails on incomplete EOF without quarantine, repair or a marker', () => {
    const { file, dir } = fixture()
    const raw = line(1) + '\n{"seq":2,"at":1,"kind":"torn'
    fs.writeFileSync(file, raw)
    expect(() => open(file, { readOnly: true })).toThrow(/incomplete event tail in read-only event store.*no bytes changed/)
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    expect(fs.readdirSync(dir)).toEqual(['events.jsonl'])
  })

  it('does not create missing directories/files or silently downgrade a writer', () => {
    const { dir, marker, file } = fixture()
    const nested = join(dir, 'missing', 'events.jsonl')
    const replay = open(nested, { readOnly: true })
    expect(replay.all()).toEqual([])
    expect(fs.readdirSync(dir)).toEqual([])
    fs.writeFileSync(marker, 'unreclaimed')
    expect(() => open(file)).toThrow(/refusing writable open/)
    expect(() => open(file, { readOnly: 'yes' as never })).toThrow(/must be a boolean/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('preserves legacy collision normalization, original bytes and strict-v2 refusal', () => {
    const { file } = fixture()
    const raw = line(1) + '\n' + line(1, 'distinct')
    fs.writeFileSync(file, raw)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(open(file, { readOnly: true }).all().map((event) => [event.seq, event.storedSeq])).toEqual([[1, undefined], [2, 1]])
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    const writer = open(file)
    expect(writer.append('v2').seq).toBe(3)
    expect(fs.readFileSync(file, 'utf8').startsWith(raw + '\n')).toBe(true)
    writer.close()
    fs.appendFileSync(file, line(1, 'legacy-after-v2') + '\n')
    expect(() => open(file, { readOnly: true })).toThrow(/non-increasing sequence/)
  })

  it('keeps durable publication and observer failure isolation', () => {
    const { file } = fixture()
    const store = open(file)
    vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('sink failure') })
    store.subscribe(() => { throw new Error('observer failure') })
    const seen = vi.fn(() => {
      const replay = open(file, { readOnly: true })
      expect(replay.seq).toBe(store.seq)
      replay.close()
    })
    store.subscribe(seen)
    expect(() => store.append('durable')).not.toThrow()
    expect(seen).toHaveBeenCalledOnce()
    expect(store.diagnostics[0]).toMatch(/observer failure/)
  })
})

describe('independent-process writers', () => {
  it('rejects a contender while an old owner is paused, then lets that owner resume', async () => {
    const { dir, file, marker } = fixture()
    const script = childProgram(dir)
    const ready = join(dir, 'ready.json')
    const control = join(dir, 'resume')
    const child = launchWriter(script, file, ready, control)
    await waitForFile(ready, child)
    expect(JSON.parse(fs.readFileSync(ready, 'utf8')).ok).toBe(true)
    // POSIX also exercises an actual OS stop/resume. Windows holds the writer at
    // an explicit pre-append barrier; no unsupported SIGSTOP or host calls.
    if (process.platform !== 'win32') process.kill(child.pid!, 'SIGSTOP')
    try {
      fs.utimesSync(marker, new Date(0), new Date(0))
      const before = fs.readFileSync(file, 'utf8')
      const rejected = runWriter(script, file, join(dir, 'contender.json'))
      expect(rejected.ok).toBe(false)
      expect(rejected.message).toMatch(/already owned.*no automatic stale takeover/)
      expect(() => open(file)).toThrow(/already owned/)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
    } finally {
      if (process.platform !== 'win32') process.kill(child.pid!, 'SIGCONT')
      fs.writeFileSync(control, 'resume')
    }
    await waitForFile(ready + '.done', child)
    expect(JSON.parse(fs.readFileSync(ready + '.done', 'utf8')).ok).toBe(true)
    await children[0].done
    expect(child.exitCode).toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
    const successor = open(file)
    expect(successor.all().map((event) => event.kind)).toEqual(['child/before-pause', 'child/after-resume'])
    expect(successor.append('successor').seq).toBe(3)
  }, 20000)

  it('does not reclaim the marker even after its independent owner exits', () => {
    const { dir, file, marker } = fixture()
    const script = childProgram(dir)
    expect(runWriter(script, file, join(dir, 'crashed.json'), 'crash').ok).toBe(true)
    fs.utimesSync(marker, new Date(0), new Date(0))
    const before = fs.readFileSync(file, 'utf8')
    expect(runWriter(script, file, join(dir, 'after-exit.json')).ok).toBe(false)
    expect(() => open(file)).toThrow(/no automatic stale takeover/)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(open(file, { readOnly: true }).seq).toBe(1)
  }, 20000)
})
