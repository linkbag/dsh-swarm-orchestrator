import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.registry.delete(swarmPlugin)
  for (const dir of dirs.splice(0)) {
    expect(dir.startsWith(join(tmpdir(), 'swarm-startup-hardening-'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('service startup publication', () => {
  it.each(['events.jsonl', 'runtime.json', 'duty-table.json'])('does not publish a half-initialized service when %s is refused', async (file) => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-startup-hardening-'))
    dirs.push(dir)
    writeFileSync(join(dir, file), 'complete but corrupt input\n', 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(swarmPlugin, { storageDir: dir })
    expect(ctx.get('swarm')).toBeUndefined()
  })

  it('refuses a valid envelope whose payload cannot be replayed before publication', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-startup-hardening-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({
      seq: 1, at: 1, kind: 'run/created', runId: 'r', data: { tasks: [null] },
    })}\n`, 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(swarmPlugin, { storageDir: dir })
    expect(ctx.get('swarm')).toBeUndefined()
  })

  it('publishes a service with a usable projection of valid loaded history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-startup-hardening-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({
      seq: 1, at: 1, kind: 'run/created', runId: 'r', data: { title: 'Loaded run', tasks: [{ id: 'a' }] },
    })}\n`, 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(swarmPlugin, { storageDir: dir })
    const service = ctx.get('swarm')
    expect(service).toBeDefined()
    expect(service?.snapshot().runs[0]).toMatchObject({ id: 'r', title: 'Loaded run', status: 'planning' })
  })
})
