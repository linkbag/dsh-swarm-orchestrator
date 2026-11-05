import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { EventStore } from '../src/domain/event-store.js'
import { EventWorkItemCheckpoints } from '../src/work-item-store.js'
import { createWorkItemManifest, digestWorkItemValue, WorkItemCoordinator, summarizeWorkItems, type WorkItemValidator } from '../src/work-items.js'

const fixtures: Array<{ root: string; stores: EventStore[] }> = []
afterEach(() => {
  for (const { root, stores } of fixtures.splice(0)) {
    for (const store of stores) store.close()
    expect(realpathSync(root)).toBe(root)
    expect(root.startsWith(realpathSync(tmpdir()) + sep + 'swarm-item-store-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-item-store-')))
  const store = new EventStore(join(root, 'events.jsonl'))
  const fixture = { root, stores: [store] }; fixtures.push(fixture)
  const manifest = createWorkItemManifest('synthetic-run', ['a', 'b'].map((id) => ({ id, source: { handle: `synthetic:${id}`, hash: digestWorkItemValue(id) }, input: { question: id }, requiresQualifiedReview: false })))
  const validator: WorkItemValidator = { identity: { id: 'synthetic', version: '1', digest: digestWorkItemValue('validator') }, validate: () => ({ valid: true }) }
  return { fixture, store, manifest, validator, adapter: new EventWorkItemCheckpoints(store) }
}

describe('durable per-item checkpoint adapter', () => {
  it('resumes the frozen journal without rerunning accepted work, and joins only its own item', async () => {
    const r = setup()
    const options = { checkpoints: r.adapter, validator: r.validator, maxCorrections: 1 }
    const first = await WorkItemCoordinator.open(r.manifest, options)
    await first.execute('a', 'deterministic', (request) => ({ kind: 'output', attempt: request.attempt, value: { schema: 1 }, provenance: 'deterministic-native', accounting: { requests: 0, inputTokens: 0, outputTokens: 0, sourceActions: 0 } }))
    const snapshot = first.snapshot()
    r.store.close()
    const resumedStore = new EventStore(join(r.fixture.root, 'events.jsonl'))
    r.fixture.stores.push(resumedStore)
    const resumed = await WorkItemCoordinator.open(r.manifest, { ...options, checkpoints: new EventWorkItemCheckpoints(resumedStore) })
    expect(resumed.snapshot()).toEqual(snapshot)
    expect(resumed.ready()).toContainEqual({ itemId: 'a', stage: 'source-read' })
    expect(resumed.ready()).toContainEqual({ itemId: 'a', stage: 'extraction' })
    expect(resumed.ready()).toContainEqual({ itemId: 'b', stage: 'deterministic' })
    expect(resumed.ready()).not.toContainEqual({ itemId: 'a', stage: 'deterministic' })
    expect(summarizeWorkItems(resumed.snapshot()).denominator).toBe(2)
  })

  it('serializes CAS across independently opened coordinators sharing the append authority', async () => {
    const r = setup()
    const options = { checkpoints: r.adapter, validator: r.validator, maxCorrections: 0 }
    const first = await WorkItemCoordinator.open(r.manifest, options)
    const stale = await WorkItemCoordinator.open(r.manifest, { ...options, checkpoints: new EventWorkItemCheckpoints(r.store) })
    await first.start('a', 'deterministic')
    await expect(stale.start('a', 'deterministic')).rejects.toThrow(/CAS conflict/)
    const latest = await r.adapter.load(r.manifest.runId)
    expect(latest?.revision).toBe(1)
    expect(latest?.items[0].stages.deterministic.attempts).toHaveLength(1)
    const reader = new EventStore(join(r.fixture.root, 'events.jsonl'), { readOnly: true }); r.fixture.stores.push(reader)
    expect(await new EventWorkItemCheckpoints(reader).load(r.manifest.runId)).toEqual(latest)
    await expect(new EventWorkItemCheckpoints(reader).compareAndSet(r.manifest.runId, null, first.snapshot())).resolves.toBe(false)
  })
})
