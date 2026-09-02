import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDutyTable, DutyTableStore } from '../src/domain/duty-table.js'

function tempStore(): { store: DutyTableStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-duty-'))
  return { store: new DutyTableStore(join(dir, 'duty-table.json')), dir }
}

describe('duty table', () => {
  const cleanups: string[] = []
  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
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
})
