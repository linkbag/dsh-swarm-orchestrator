import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Config, type SwarmConfig } from '../src/config.js'

describe('config schema', () => {
  it('parses defaults for an empty config', () => {
    const parsed = Config({} as SwarmConfig)
    expect(parsed.maxConcurrent).toBe(5)
    expect(parsed.staleTimeoutSeconds).toBe(14400)
    expect(parsed.maxRetries).toBe(2)
    expect(parsed.reviewLoops).toBe(3)
    expect(parsed.storageDir).toContain(join('storages', 'swarm'))
  })

  it('accepts explicit overrides', () => {
    const parsed = Config({ maxConcurrent: 8, storageDir: 'D:/tmp/swarm-test' } as Partial<SwarmConfig> as SwarmConfig)
    expect(parsed.maxConcurrent).toBe(8)
    expect(parsed.storageDir).toBe('D:/tmp/swarm-test')
  })
})
