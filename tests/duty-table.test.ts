import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDutyTable, DutyTableStore, validateDutyTable } from '../src/domain/duty-table.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }))
const PREFIX = 'swarm-hardening-storage-duty-'
function tempStore(): { store: DutyTableStore; dir: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), PREFIX))
  return { store: new DutyTableStore(join(dir, 'duty-table.json')), dir }
}

describe('duty table', () => {
  const cleanups: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of cleanups.splice(0)) {
      expect(dir.startsWith(join(tmpdir(), PREFIX))).toBe(true)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ships four builtin roles with personas and no pinned models', () => {
    const table = defaultDutyTable()
    expect(Object.keys(table.roles).sort()).toEqual(['architect', 'builder', 'integrator', 'reviewer'])
    for (const role of Object.values(table.roles)) {
      expect(role.persona).toBeTruthy()
      expect(role.fallbacks).toEqual([])
    }
  })

  it('resolveChain is empty (inherit default) when no model pinned', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    expect(store.resolveChain('builder')).toEqual([])
  })

  it('resolveChain returns primary then fallbacks', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const next = structuredClone(store.get())
    next.roles.builder = {
      ...next.roles.builder,
      provider: 'zai', model: 'glm-5.3',
      fallbacks: [{ provider: 'zai', model: 'glm-5.2' }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    }
    store.save(next)
    expect(store.resolveChain('builder')).toEqual([
      { provider: 'zai', model: 'glm-5.3' },
      { provider: 'zai', model: 'glm-5.2' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    ])
  })

  it('save persists and reloads', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const next = structuredClone(store.get())
    next.roles.reviewer = { ...next.roles.reviewer, provider: 'zai', model: 'glm-5.1' }
    store.save(next)
    const reopened = new DutyTableStore(join(dir, 'duty-table.json'))
    expect(reopened.resolveChain('reviewer')).toEqual([{ provider: 'zai', model: 'glm-5.1' }])
  })

  it('rejects saves while a manual override lock is active, and can clear the lock explicitly', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const locked = structuredClone(store.get())
    locked.override = { enabled: true, note: 'pinned today', at: Date.now() }
    store.save(locked)
    expect(() => store.save(structuredClone(defaultDutyTable()))).toThrow(/locked/)
    const clearing = structuredClone(store.get())
    clearing.override = { enabled: false, note: 'unlocked', at: Date.now() }
    store.save(clearing)
    // lock cleared: ordinary saves work again
    store.save(structuredClone(defaultDutyTable()))
  })

  it.each([
    { maxConcurrent: 0 }, { maxConcurrent: 1000000 }, { maxConcurrent: 1.5 },
    { spawnTimeoutSeconds: -1 }, { spawnTimeoutSeconds: 86401 },
    { maxTokens: 0 }, { maxTokens: 262145 }, { maxTokens: 1.5 },
    { persona: 'x'.repeat(32769) }, { provider: 'provider-only' },
    { toolFilter: {} }, { toolFilter: { allow: [] } }, { toolFilter: { deny: [] } },
    { toolFilter: { allow: [''] } }, { toolFilter: { deny: ['known', 'known'] } },
    { toolFilter: { allow: Array.from({ length: 257 }, (_, i) => `tool-${i}`) } },
    { fallbacks: Array.from({ length: 17 }, () => ({ provider: 'p', model: 'm' })) },
    { effortFallbacks: Array.from({ length: 17 }, (_, i) => `effort-${i}`) },
    { unexpected: true },
  ])('rejects invalid role limits/pins/filters without changing the stored table: %j', (patch) => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    store.save(store.get())
    const file = join(dir, 'duty-table.json')
    const before = fs.readFileSync(file, 'utf8')
    const old = store.get()
    const next = store.get()
    Object.assign(next.roles.builder, patch)
    expect(() => store.save(next)).toThrow()
    expect(store.get()).toEqual(old)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('retains valid bounded policy and explicit timer off semantics', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const next = store.get()
    Object.assign(next.roles.builder, {
      maxConcurrent: 64, spawnTimeoutSeconds: 0, maxTokens: 262144,
      toolFilter: { allow: ['read', 'write'], deny: ['shell'] },
    })
    store.save(next)
    expect(new DutyTableStore(join(dir, 'duty-table.json')).role('builder')).toMatchObject({
      maxConcurrent: 64, spawnTimeoutSeconds: 0, maxTokens: 262144,
      toolFilter: { allow: ['read', 'write'], deny: ['shell'] },
    })
  })

  it('whitespace-only provider/model pins inherit rather than emitting a blank model', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const next = store.get()
    next.roles.builder.provider = ' '
    next.roles.builder.model = ' '
    store.save(next)
    expect(store.resolveChain('builder')).toEqual([])
  })

  it('returned table, roles and model chains cannot mutate active settings', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    const next = store.get()
    Object.assign(next.roles.builder, { provider: 'p', model: 'm', toolFilter: { allow: ['read'] } })
    store.save(next)
    next.roles.builder.model = 'caller-mutation'
    const table = store.get()
    table.roles.builder.model = 'snapshot-mutation'
    const role = store.role('builder')!
    role.toolFilter!.allow!.push('unexpected')
    const chain = store.resolveChain('builder')
    chain[0].model = 'chain-mutation'
    expect(store.role('builder')).toMatchObject({ model: 'm', toolFilter: { allow: ['read'] } })
    expect(store.resolveChain('builder')).toEqual([{ provider: 'p', model: 'm' }])
  })

  it('rejects unsafe role keys, inherited policy and getters without invoking them', () => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    expect(store.role('constructor')).toBeUndefined()
    expect(store.role('__proto__')).toBeUndefined()
    for (const id of ['__proto__', 'constructor', 'prototype', 'has space']) {
      const table = defaultDutyTable()
      table.roles = JSON.parse(`{${JSON.stringify(id)}:${JSON.stringify({ ...table.roles.builder, id })}}`)
      expect(() => validateDutyTable(table)).toThrow(/unsafe role id/)
    }
    const inherited = defaultDutyTable()
    inherited.roles = Object.create({ builder: inherited.roles.builder })
    expect(() => validateDutyTable(inherited)).toThrow(/plain object/)
    let accessed = false
    const accessor = defaultDutyTable()
    Object.defineProperty(accessor.roles.builder, 'maxConcurrent', { enumerable: true, get() { accessed = true; return 1 } })
    expect(() => validateDutyTable(accessor)).toThrow(/plain object/)
    expect(accessed).toBe(false)
  })

  it('surfaces corrupt/invalid legacy policy instead of silently using permissive roles', () => {
    const { dir } = tempStore()
    cleanups.push(dir)
    const file = join(dir, 'duty-table.json')
    const next = defaultDutyTable()
    next.roles.builder.toolFilter = { allow: [] }
    const raw = JSON.stringify(next)
    fs.writeFileSync(file, raw)
    expect(() => new DutyTableStore(file)).toThrow(/invalid duty table .*1\.\.256 strings/)
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
    fs.writeFileSync(file, 'not JSON')
    expect(() => new DutyTableStore(file)).toThrow(/invalid duty table/)
  })

  it('surfaces disk read failures', () => {
    const { dir } = tempStore()
    cleanups.push(dir)
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('injected read failure'), { code: 'EACCES' }) })
    expect(() => new DutyTableStore(join(dir, 'duty-table.json'))).toThrow(/cannot read duty table .*injected read failure/)
  })

  it.each(['rename', 'fsync'])('keeps old settings and removes temporary snapshots on %s failure', (fault) => {
    const { store, dir } = tempStore()
    cleanups.push(dir)
    store.save(store.get())
    const file = join(dir, 'duty-table.json')
    const before = fs.readFileSync(file, 'utf8')
    const old = store.get()
    const next = store.get()
    Object.assign(next.roles.builder, { provider: 'p', model: 'm' })
    if (fault === 'rename') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('injected rename failure') })
    else vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected fsync failure') })
    expect(() => store.save(next)).toThrow(/injected/)
    expect(store.get()).toEqual(old)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(dir)).toEqual(['duty-table.json'])
    expect(store.save(next).roles.builder.model).toBe('m')
  })
})
