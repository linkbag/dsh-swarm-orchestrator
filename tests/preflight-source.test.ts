// J21 source resolution: which document the effort preflight reads, and what it
// concludes when that document is missing, stale or unrecognizable.
//
// Live trigger (2026-09-26): DSH moved the deployment's settings out of
// `$DSH_HOME/settings.yaml` into the active profile and renamed the old file
// (`settings.yaml.imported`). The preflight kept looking for the file, found
// nothing, and validated NOTHING while still looking healthy — an unsupported
// effort pin would have surfaced only as a child dying ~40 ms after
// `agent-started`. These tests pin the two rules that fix it: prefer the live
// settings service, and never turn "I could not read anything" into a verdict.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as swarmPlugin from '../src/index.js'
import { SwarmService } from '../src/service.js'
import {
  checkEffortSupport,
  parseEffortSupportFromEntries,
  resolveEffortSupport,
  type SettingsEntryValue,
} from '../src/preflight.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** A live llm-pi-ai entry shaped like `ctx.settings.describe()` reports it. */
function piAiEntry(models: Array<Record<string, unknown>>): SettingsEntryValue {
  return { ns: 'llm-pi-ai', value: { providers: { xiaomi: { models } } } }
}

function model(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id.toUpperCase(), contextWindow: 1000, maxTokens: 100, input: ['text'], ...extra }
}

describe('J21 live source: the settings service value', () => {
  it('reads declared levels, and keeps a map-less model\'s pin (absence is unknown)', () => {
    const support = parseEffortSupportFromEntries([
      piAiEntry([
        model('mimo-v2.6-pro'),
        model('glm-5.3', { reasoningEfforts: { high: 'high', max: 'max' } }),
      ]),
    ])
    expect([...support.supported]).toEqual(['glm-5.3'])
    expect([...support.declaredWithoutMap]).toEqual(['mimo-v2.6-pro'])
    expect([...support.declaredLevels.get('glm-5.3') ?? []]).toEqual(['high', 'max'])

    // Absence of a map (the production mimo shape) is UNKNOWN, so the pin is kept: the
    // adapter may resolve the model through the installed catalog, and dropping a pin on
    // a guess is a silent downgrade.
    expect(checkEffortSupport('mimo-v2.6-pro', 'max', support).incompatible).toBe(false)
    // A DECLARED map is positive evidence in both directions: its own levels pass, and a
    // level it does not declare is still stripped.
    expect(checkEffortSupport('glm-5.3', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('glm-5.3', 'medium', support).incompatible).toBe(true)
  })

  it('collects `reasoningEfforts: false`, an empty map and unknown levels as UNJUDGED', () => {
    const support = parseEffortSupportFromEntries([
      piAiEntry([
        model('no-reasoning', { reasoningEfforts: false }),
        model('empty-map', { reasoningEfforts: {} }),
        model('unknown-levels', { reasoningEfforts: { turbo: 'turbo' } }),
      ]),
    ])
    expect(support.supported.size).toBe(0)
    expect([...support.declaredWithoutMap].sort()).toEqual(['empty-map', 'no-reasoning', 'unknown-levels'])
    // Collected for the log line, and nothing more: none of these can strip a pin.
    expect(checkEffortSupport('no-reasoning', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('empty-map', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('unknown-levels', 'max', support).incompatible).toBe(false)
  })

  it('ignores models outside the validating root (the deepseek adapter)', () => {
    const support = parseEffortSupportFromEntries([
      { ns: 'llm-deepseek', value: { providers: { 'deepseek-official': { models: [model('deepseek-flash')] } } } },
    ])
    expect(support.supported.size + support.declaredWithoutMap.size + support.declaredLevels.size).toBe(0)
    expect(checkEffortSupport('deepseek-flash', 'max', support).incompatible).toBe(false)
  })

  it('accepts the package name as well as the entry id for the root match', () => {
    const support = parseEffortSupportFromEntries([
      { ns: '@deepseek-ai/dsh-llm-pi-ai', value: { providers: { zai: { models: [model('glm-5.3')] } } } },
    ])
    expect([...support.declaredWithoutMap]).toEqual(['glm-5.3'])
  })

  it('takes the default-model pair as proof of its own level, without inventing a level set', () => {
    const support = parseEffortSupportFromEntries([
      { ns: 'agent-default-model', value: { provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoningEffort: 'max' } },
    ])
    // Still SUPPORTED: the pair's level is proven first-hand, so the model is not simply
    // map-less-and-unknown in the log's count.
    expect([...support.supported]).toEqual(['mimo-v2.6-pro'])
    // But it creates NO declared level set, because presence in `declaredLevels` is what
    // licenses exclusion — and proof of `max` is not evidence against `high`. The pair
    // used to invent `{max}` here, which on the deployment's own default model
    // (`zai/glm-5.3`, which declares no map at all) stripped a legitimate `high` pin and
    // reported a warning claiming a map existed.
    expect(support.declaredLevels.has('mimo-v2.6-pro')).toBe(false)
    expect(checkEffortSupport('mimo-v2.6-pro', 'max', support).incompatible).toBe(false)
    expect(checkEffortSupport('mimo-v2.6-pro', 'high', support).incompatible).toBe(false)
  })

  it('lets the proven pair WIDEN a declared map, and stays order-independent', () => {
    const entries: SettingsEntryValue[] = [
      piAiEntry([model('glm-5.3', { reasoningEfforts: { high: 'high' } })]),
      { ns: 'agent-default-model', value: { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'max' } },
    ]
    for (const order of [entries, [...entries].reverse()]) {
      const support = parseEffortSupportFromEntries(order)
      // The MAP supplies the exclusion set; the pair adds the level the deployment really
      // runs, which the map omits (so the map is incomplete, not wrong). A level neither
      // names stays excluded — that is the remaining positive-evidence path.
      expect([...support.declaredLevels.get('glm-5.3') ?? []].sort()).toEqual(['high', 'max'])
      expect(checkEffortSupport('glm-5.3', 'high', support).incompatible).toBe(false)
      expect(checkEffortSupport('glm-5.3', 'max', support).incompatible).toBe(false)
      expect(checkEffortSupport('glm-5.3', 'medium', support).incompatible).toBe(true)
    }
  })

  it('never invents support from an unrecognizable shape', () => {
    const cyclic: Record<string, unknown> = { id: 'cyclic' }
    cyclic.self = cyclic
    const support = parseEffortSupportFromEntries([
      { ns: 'llm-pi-ai', value: 'not an object' },
      { ns: 'llm-pi-ai', value: [null, 42, 'x', cyclic] },
      { ns: 'llm-pi-ai', value: { providers: { xiaomi: { models: [{ id: 'id-only' }] } } } },
      null as never,
      undefined as never,
    ])
    expect(support.supported.size).toBe(0)
    expect(support.declaredLevels.size).toBe(0)
    // `id-only` lacks every model field, so it is not a model entry at all — and a
    // shape we do not recognize must leave the model UNJUDGED, not declared.
    expect(support.declaredWithoutMap.size).toBe(0)
    expect(checkEffortSupport('mimo-v2.6-pro', 'max', support).incompatible).toBe(false)
  })
})

describe('J21 source resolution order', () => {
  const declaredFile = {
    path: 'C:/fixture/settings.yaml',
    text: 'llm-pi-ai:\n  providers:\n    zai:\n      models:\n        - id: glm-4.7\n',
  }

  it('prefers the live service and does not consult the file', () => {
    const resolved = resolveEffortSupport({
      service: { label: 'settings service', entries: [piAiEntry([model('mimo-v2.6-pro')])] },
      files: [declaredFile],
    })
    expect(resolved.source).toBe('settings service')
    expect(resolved.consulted).toEqual(['settings service'])
    expect([...resolved.support?.declaredWithoutMap ?? []]).toEqual(['mimo-v2.6-pro'])
  })

  it('falls back to the legacy file when the service declares nothing', () => {
    const resolved = resolveEffortSupport({
      service: { label: 'settings service', entries: [{ ns: 'agent-default-model', value: { provider: 'x', model: 'y' } }] },
      files: [declaredFile],
    })
    expect(resolved.source).toBe('C:/fixture/settings.yaml')
    expect(resolved.consulted).toEqual(['settings service', 'C:/fixture/settings.yaml'])
    expect([...resolved.support?.declaredWithoutMap ?? []]).toEqual(['glm-4.7'])
  })

  it('judges nothing when no source declares anything — an empty parse is not "everything supported"', () => {
    const resolved = resolveEffortSupport({
      service: { label: 'settings service (absent)' },
      files: [{ path: 'C:/stale/settings.yaml.imported', text: 'this: [is not: valid\nyaml at all' }],
    })
    expect(resolved.support).toBeUndefined()
    expect(resolved.consulted).toEqual(['settings service (absent)', 'C:/stale/settings.yaml.imported'])
    // The consequence that matters: the check stays silent, it does not start
    // approving every pin because it failed to read the deployment.
    expect(checkEffortSupport('xiaomi/mimo-v2.6-pro', 'max', resolved.support).incompatible).toBe(false)
  })
})

describe('J21 service wiring: source selection and the once-only log', () => {
  async function bootWith(settings: unknown, home: string): Promise<{ service: SwarmService; ctx: Context }> {
    process.env.DSH_HOME = home
    const dir = mkdtempSync(join(tmpdir(), 'swarm-preflight-'))
    dirs.push(dir)
    const ctx = new Context()
    ctx.reflect.provide('subagents', { start: () => new Promise(() => {}) } as never)
    if (settings !== undefined) ctx.reflect.provide('settings', settings as never)
    await ctx.plugin(swarmPlugin, {
      storageDir: dir,
      maxConcurrent: 5,
      maxRetries: 2,
      reviewLoops: 3,
      requireArchitectReview: false,
      workspaceRunPolicy: 'off',
      retryBackoffBaseMs: 0,
      circuitBreakerThreshold: 0,
    })
    const traced = ctx.get('swarm') as Record<symbol, unknown> | undefined
    const service = traced?.[Symbol.for('cordis.original')] as SwarmService | undefined
    if (service === undefined) throw new Error('swarm service not registered')
    return { service, ctx }
  }

  const read = (service: SwarmService): unknown =>
    (service as unknown as { effortSupport(): unknown }).effortSupport()

  it('reads the live service, caches it, and reports the map-less count in its once-only log', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-home-'))
    dirs.push(home)
    const describe = vi.fn(() => [
      {
        ns: 'llm-pi-ai',
        value: {
          providers: {
            xiaomi: { models: [model('mimo-v2.6-pro')] },
            zai: { models: [model('glm-5.3', { reasoningEfforts: { max: 'max' } })] },
          },
        },
      },
    ])
    const { service, ctx } = await bootWith({ describe }, home)

    // The logger exporter is the real sink the service writes to (same observation the
    // INACTIVE test uses), and a high threshold exports every level for `swarm`.
    const messages: Array<{ name: string; type: string; args: unknown[] }> = []
    const dispose = ctx.logger.exporter({
      levels: { swarm: 9 },
      export: (message) => { messages.push(message as unknown as { name: string; type: string; args: unknown[] }) },
    })
    try {
      const first = read(service) as {
        supported: ReadonlySet<string>
        declaredWithoutMap: ReadonlySet<string>
      } | undefined
      expect([...first?.supported ?? []]).toEqual(['glm-5.3'])
      expect([...first?.declaredWithoutMap ?? []]).toEqual(['mimo-v2.6-pro'])
      read(service)
      read(service)
      // Once per service instance: this is what makes the line single rather than one
      // per dispatch.
      expect(describe).toHaveBeenCalledTimes(1)

      // The uncertainty is REPORTED, not silent: how many models were read, how many
      // declare levels, and how many rest on a missing map (pins therefore left in
      // place). The counts are the whole point — they are what an operator reads to
      // decide whether the preflight is doing anything.
      const info = messages.filter((m) => m.name === 'swarm' && m.type === 'info')
      expect(info.length).toBe(1)
      expect(String(info[0]?.args[0])).toContain('effort preflight active')
      expect(String(info[0]?.args[0])).toContain('declared without an effort map')
      expect(String(info[0]?.args[0])).toContain('pins left in place')
      expect(info[0]?.args[1]).toBe('settings service')
      expect(info[0]?.args.slice(2)).toEqual([2, 1, 1])
    } finally {
      await dispose()
    }
  })

  it('is inactive (but not silent) when neither source declares anything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-home-'))
    dirs.push(home)
    writeFileSync(join(home, 'settings.yaml'), 'not: a settings document\n  broken: [\n')
    const { service, ctx } = await bootWith(undefined, home)

    // The logger service's exporter is the real sink every named logger writes to,
    // so this observes the actual production log line rather than a spy on a facade
    // object `ctx.logger(name)` recreates per call.
    const messages: Array<{ name: string; type: string; args: unknown[] }> = []
    const dispose = ctx.logger.exporter({
      // Per-name threshold: WARN(2) and below are exported for the swarm logger.
      levels: { swarm: 3 },
      export: (message) => { messages.push(message as unknown as { name: string; type: string; args: unknown[] }) },
    })
    try {
      expect(read(service)).toBeUndefined()
      read(service)
      read(service)
      const warnings = messages.filter((m) => m.name === 'swarm' && m.type === 'warn')
      expect(warnings.length).toBe(1)
      expect(String(warnings[0]?.args[0])).toContain('effort preflight INACTIVE')
      expect(String(warnings[0]?.args[0])).toContain('consulted: %s')
      expect((warnings[0]?.args[1] ?? '')).toContain('settings service')
    } finally {
      await dispose()
    }
  })
})
