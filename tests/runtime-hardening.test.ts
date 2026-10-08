import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUNTIME_LIMITS } from '../src/domain/limits.js'
import { RuntimeStore, validateRuntimeOverrides, type RuntimeOverrides } from '../src/domain/runtime-store.js'

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }))

const PREFIX = 'swarm-hardening-storage-runtime-'
const cleanups: string[] = []
function tempStore(): { store: RuntimeStore; dir: string; file: string } {
  const dir = fs.mkdtempSync(join(tmpdir(), PREFIX))
  cleanups.push(dir)
  const file = join(dir, 'runtime.json')
  return { store: new RuntimeStore(file), dir, file }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of cleanups.splice(0)) {
    expect(dir.startsWith(join(tmpdir(), PREFIX))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('runtime hardening', () => {
  it('starts empty, accepts all shared defaults and persists independent copies', () => {
    const { store, file } = tempStore()
    expect(store.get()).toEqual({})
    const defaults = Object.fromEntries(Object.entries(RUNTIME_LIMITS).map(([key, bounds]) => [key, bounds.default])) as RuntimeOverrides
    const saved = store.save(defaults)
    expect(saved).toEqual(defaults)
    saved.maxConcurrent = 1
    defaults.maxConcurrent = 2
    expect(store.get().maxConcurrent).toBe(50)
    const copy = store.get()
    copy.maxConcurrent = 3
    expect(new RuntimeStore(file).get().maxConcurrent).toBe(50)
    expect(store.get().maxConcurrent).toBe(50)
  })

  it.each(Object.entries(RUNTIME_LIMITS))('validates both integer boundaries for %s', (key, bounds) => {
    expect(validateRuntimeOverrides({ [key]: bounds.min })).toEqual({ [key]: bounds.min })
    expect(validateRuntimeOverrides({ [key]: bounds.max })).toEqual({ [key]: bounds.max })
    for (const value of [bounds.min - 1, bounds.max + 1, bounds.min + 0.5, NaN, Infinity, '1', null, true]) {
      expect(() => validateRuntimeOverrides({ [key]: value })).toThrow(/must be an integer/)
    }
  })

  it.each([
    { maxConcurrent: 1000000 }, { maxConcurrent: 0 },
    { maxTotalConcurrentAgents: 0 }, { maxTotalConcurrentAgents: 129 },
    { maxRetries: 6 }, { reviewLoops: 1.5 }, { evidenceTimeoutMs: 0 },
    { staleTimeoutSeconds: 0 }, { circuitBreakerCooldownMs: 0 },
  ])('rejects hostile values before any file or in-memory change: %j', (value) => {
    const { store, file } = tempStore()
    store.save({ maxConcurrent: 2 })
    const before = fs.readFileSync(file, 'utf8')
    expect(() => store.save(value)).toThrow(/must be an integer/)
    expect(store.get()).toEqual({ maxConcurrent: 2 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('preserves only explicitly permitted zero values', () => {
    const zeroes: RuntimeOverrides = {
      spawnStaggerMs: 0, retryBackoffBaseMs: 0, circuitBreakerThreshold: 0,
      nudgeAfterMinutes: 0, spawnTimeoutSeconds: 0, maxRetries: 0, reviewLoops: 0,
    }
    const { store, file } = tempStore()
    store.save(zeroes)
    expect(new RuntimeStore(file).get()).toEqual(zeroes)
  })

  it('rejects unknown keys, unsafe prototypes and accessors without invoking getters', () => {
    let accessed = false
    const accessor = Object.defineProperty({}, 'maxConcurrent', { enumerable: true, get() { accessed = true; return 2 } })
    for (const value of [[], null, { unsupported: 1 }, Object.create({ maxConcurrent: 2 }), JSON.parse('{"__proto__":{"maxConcurrent":2}}'), accessor]) {
      expect(() => validateRuntimeOverrides(value)).toThrow()
    }
    expect(accessed).toBe(false)
  })

  it.each(['{"maxConcurrent":1000000}', '{"maxTotalConcurrentAgents":0}', '{"maxConcurrent":1.5}', '{"unsupported":1}', '[]', 'not JSON'])('surfaces invalid legacy disk settings rather than widening to defaults: %s', (raw) => {
    const { file } = tempStore()
    fs.writeFileSync(file, raw)
    expect(() => new RuntimeStore(file)).toThrow(/invalid runtime overrides/)
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  })

  it('surfaces read failures rather than falling back to an empty policy', () => {
    const { file } = tempStore()
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('injected read failure'), { code: 'EACCES' }) })
    expect(() => new RuntimeStore(file)).toThrow(/cannot read runtime overrides .*injected read failure/)
  })

  it.each(['rename', 'fsync'])('keeps old memory and disk when atomic %s fails, and removes temporary files', (fault) => {
    const { store, file, dir } = tempStore()
    store.save({ maxConcurrent: 2 })
    const before = fs.readFileSync(file, 'utf8')
    if (fault === 'rename') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('injected rename failure') })
    else vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected fsync failure') })
    expect(() => store.save({ maxConcurrent: 3 })).toThrow(/injected/)
    expect(store.get()).toEqual({ maxConcurrent: 2 })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(dir)).toEqual(['runtime.json'])
    expect(store.save({ maxConcurrent: 4 })).toEqual({ maxConcurrent: 4 })
  })
})
