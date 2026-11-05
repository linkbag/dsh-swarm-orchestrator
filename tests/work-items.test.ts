import { describe, expect, it, vi } from 'vitest'
import {
  createWorkItemManifest, digestWorkItemValue, readyWorkItems, summarizeWorkItems, WorkItemCoordinator,
  type WorkItemAccounting, type WorkItemCheckpoint, type WorkItemCheckpointAdapter, type WorkItemDefinition,
  type WorkItemManifest, type WorkItemOutput, type WorkItemRequest, type WorkItemStage, type WorkItemValidation, type WorkItemValidator,
} from '../src/work-items.js'

// Synthetic, in-memory DURABILITY CONTRACT fake: no host, files, models or sources.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const ZERO: WorkItemAccounting = { requests: 0, inputTokens: 0, outputTokens: 0, sourceActions: 0 }
const USAGE: WorkItemAccounting = { requests: 1, inputTokens: 10, outputTokens: 5, sourceActions: 0 }
const UNKNOWN: WorkItemAccounting = { requests: null, inputTokens: null, outputTokens: null, sourceActions: null }
class Checkpoints implements WorkItemCheckpointAdapter {
  stored: WorkItemCheckpoint | null = null
  acknowledgements = 0
  failAfterWrite = false
  async load(): Promise<WorkItemCheckpoint | null> { return clone(this.stored) }
  async compareAndSet(_runId: string, revision: number | null, next: WorkItemCheckpoint): Promise<boolean> {
    if ((this.stored?.revision ?? null) !== revision) return false
    this.stored = clone(next)
    this.acknowledgements++
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new Error('synthetic lost durability acknowledgement') }
    return true
  }
}
function definitions(ids = ['a', 'b']): WorkItemDefinition[] {
  return ids.map((id) => ({
    id, source: { handle: `synthetic-local:${id}`, hash: digestWorkItemValue(`original-${id}`), missing: null },
    input: { question: `unresolved question ${id}`, nativeId: `native-${id}`, literal: '001.20' }, requiresQualifiedReview: false,
  }))
}
function manifest(ids = ['a', 'b']): WorkItemManifest { return createWorkItemManifest('synthetic-run', definitions(ids)) }
function output(request: WorkItemRequest, patch: Partial<WorkItemOutput> = {}): WorkItemOutput {
  return {
    kind: 'output', attempt: request.attempt,
    value: { itemId: request.item.id, sourceHash: request.attempt.sourceManifestHash, inputHash: request.attempt.inputManifestHash, schema: 1 },
    provenance: request.stage === 'deterministic' ? 'deterministic-native' : 'model-produced',
    accounting: request.stage === 'deterministic' ? { ...ZERO } : { ...USAGE }, ...patch,
  }
}
function validator(validate?: WorkItemValidator['validate']): WorkItemValidator {
  return {
    identity: { id: 'synthetic-shape', version: '1', digest: digestWorkItemValue('synthetic-shape-v1') },
    validate: validate ?? ((request, candidate) => {
      const value = candidate.value as Record<string, unknown>
      return value?.itemId === request.item.id && value.sourceHash === request.attempt.sourceManifestHash && value.inputHash === request.attempt.inputManifestHash && value.schema === 1
        ? { valid: true } : { valid: false, reason: 'synthetic schema/item/source binding invalid' }
    }),
  }
}
async function setup(ids = ['a', 'b'], maxCorrections = 1, checked = validator()) {
  const checkpoints = new Checkpoints()
  const frozen = manifest(ids)
  const coordinator = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections })
  return { checkpoints, frozen, checked, coordinator }
}
async function valid(coordinator: WorkItemCoordinator, itemId: string, stage: WorkItemStage, patch: Partial<WorkItemOutput> = {}) {
  return coordinator.execute(itemId, stage, (request) => output(request, patch))
}
async function finish(coordinator: WorkItemCoordinator, itemId: string) {
  for (const stage of ['deterministic', 'extraction', 'source-read', 'comparison'] as const) await valid(coordinator, itemId, stage)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('local work-item application orchestration', () => {
  it('captures immutable original values, ordered frozen IDs and independent manifest hashes', () => {
    const originals = definitions()
    const frozen = createWorkItemManifest('synthetic-run', originals)
    ;(originals[0].source as Record<string, unknown>).handle = 'changed-after-freeze'
    originals[0].input = 'changed question'
    expect(frozen.items[0].source).toMatchObject({ handle: 'synthetic-local:a', missing: null })
    expect(frozen.items[0].input).toMatchObject({ literal: '001.20', nativeId: 'native-a' })
    expect(Object.isFrozen(frozen.items[0].source)).toBe(true)
    expect(() => { frozen.items.push(definitions(['c'])[0]) }).toThrow()
    expect(digestWorkItemValue({ a: 1, b: [null, '001.20'] })).toBe(digestWorkItemValue({ b: [null, '001.20'], a: 1 }))
    const sourceChange = definitions(); sourceChange[0].source = { handle: 'different-original' }
    const changed = createWorkItemManifest('synthetic-run', sourceChange)
    expect(changed.sourceManifestHash).not.toBe(frozen.sourceManifestHash)
    expect(changed.inputManifestHash).toBe(frozen.inputManifestHash)
    expect(() => createWorkItemManifest('synthetic-run', definitions(['a', 'a']))).toThrow(/duplicate/)
    expect(() => digestWorkItemValue({ notJson: undefined })).toThrow(/JSON/)
  })

  it.each(['source', 'input', 'id', 'order', 'denominator', 'review-selection'] as const)('refuses resume after frozen %s mismatch', async (change) => {
    const { checkpoints, checked, coordinator } = await setup()
    await valid(coordinator, 'a', 'deterministic')
    const items = definitions()
    if (change === 'source') items[0].source = { handle: 'wrong-source', hash: digestWorkItemValue('wrong') }
    if (change === 'input') items[0].input = { question: 'easier question' }
    if (change === 'id') items[0].id = 'replacement'
    if (change === 'order') items.reverse()
    if (change === 'denominator') items.pop()
    if (change === 'review-selection') items[0].requiresQualifiedReview = true
    const before = checkpoints.acknowledgements
    await expect(WorkItemCoordinator.open(createWorkItemManifest('synthetic-run', items), { checkpoints, validator: checked, maxCorrections: 1 })).rejects.toThrow(/manifest mismatch/)
    expect(checkpoints.acknowledgements).toBe(before)
  })

  it('pins validator version/digest and correction policy; refuses corrupt/future checkpoints', async () => {
    const { checkpoints, checked, frozen } = await setup(['a'])
    await expect(WorkItemCoordinator.open(frozen, { checkpoints, validator: { ...checked, identity: { ...checked.identity, version: '2' } }, maxCorrections: 1 })).rejects.toThrow(/validator\/policy mismatch/)
    await expect(WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 2 })).rejects.toThrow(/validator\/policy mismatch/)
    const saved = clone(checkpoints.stored!)
    checkpoints.stored!.items.pop()
    await expect(WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 1 })).rejects.toThrow(/checkpoint digest mismatch/)
    checkpoints.stored = saved
    ;(checkpoints.stored as { version: number }).version = 2
    await expect(WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 1 })).rejects.toThrow(/unsupported.*version/)
  })

  it('requires deterministic-first acceptance, then enables both branches from original-source readiness', async () => {
    const { coordinator } = await setup(['a'])
    expect(coordinator.ready()).toEqual([{ itemId: 'a', stage: 'deterministic' }])
    await expect(coordinator.start('a', 'source-read')).rejects.toThrow(/not ready/)
    await valid(coordinator, 'a', 'deterministic')
    expect(readyWorkItems(coordinator.snapshot())).toEqual([{ itemId: 'a', stage: 'extraction' }, { itemId: 'a', stage: 'source-read' }])
    const extractor = await coordinator.start('a', 'extraction') // no answer yet
    expect(extractor.stage).toBe('extraction')
    if (extractor.stage === 'extraction') expect(extractor.native.output.provenance).toBe('deterministic-native')
    const reader = await coordinator.start('a', 'source-read')
    expect(Object.keys(reader).sort()).toEqual(['attempt', 'item', 'stage'])
    expect(reader.item).toEqual(coordinator.snapshot().manifest.items[0])
    expect(reader).not.toHaveProperty('native')
    expect(reader).not.toHaveProperty('extraction')
    await coordinator.complete(reader.attempt, output(reader))
    expect(coordinator.ready()).not.toContainEqual({ itemId: 'a', stage: 'comparison' })
    await coordinator.complete(extractor.attempt, output(extractor))
    const comparison = await coordinator.start('a', 'comparison')
    expect(comparison.stage).toBe('comparison')
    if (comparison.stage === 'comparison') {
      expect(comparison.extraction.output.attempt.itemId).toBe('a')
      expect(comparison.sourceRead.output.attempt.itemId).toBe('a')
    }
  })

  it('starts each own-item comparison without waiting for all extractors or unrelated failures', async () => {
    const { coordinator } = await setup(['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) await valid(coordinator, id, 'deterministic')
    const b = await coordinator.start('b', 'extraction')
    await coordinator.execute('c', 'extraction', (request) => ({ kind: 'failed', attempt: request.attempt, reason: 'synthetic unavailable', accounting: UNKNOWN }))
    await valid(coordinator, 'a', 'extraction')
    await valid(coordinator, 'a', 'source-read')
    expect(coordinator.ready()).toContainEqual({ itemId: 'a', stage: 'comparison' })
    expect(coordinator.ready()).not.toContainEqual({ itemId: 'b', stage: 'comparison' })
    await valid(coordinator, 'a', 'comparison')
    expect(summarizeWorkItems(coordinator.snapshot()).states).toMatchObject({ validated: 1, running: 1, failed: 1 })
    expect(coordinator.snapshot().items[1].stages.extraction.attempts[0].attempt).toEqual(b.attempt)
  })

  it('keeps failed/held branches in the denominator without blocking unrelated ready items', async () => {
    const { coordinator } = await setup(['failed', 'held', 'healthy'])
    for (const id of ['failed', 'held']) {
      await valid(coordinator, id, 'deterministic')
      await coordinator.execute(id, 'extraction', (request) => ({ kind: id === 'failed' ? 'failed' : 'held', attempt: request.attempt, reason: id, accounting: UNKNOWN }))
      expect(coordinator.ready()).toContainEqual({ itemId: id, stage: 'source-read' })
      expect(coordinator.ready()).not.toContainEqual({ itemId: id, stage: 'comparison' })
    }
    await finish(coordinator, 'healthy')
    const summary = summarizeWorkItems(coordinator.snapshot())
    expect(summary.denominator).toBe(3)
    expect(summary.itemIds).toEqual(['failed', 'held', 'healthy'])
    expect(summary.states).toMatchObject({ failed: 1, held: 1, validated: 1 })
    expect(summary.coverage.failureOnly).toBe(2)
    expect(coordinator.snapshot().items[0].stages.extraction.attempts[0].provenance).toBe('failure-status-only')
  })

  it('bounds structural correction, retains invalid attempts, and never redoes accepted sibling output', async () => {
    const { coordinator } = await setup(['a'], 1)
    await valid(coordinator, 'a', 'deterministic')
    await valid(coordinator, 'a', 'source-read')
    const acceptedReader = coordinator.snapshot().items[0].stages['source-read'].artifact
    await valid(coordinator, 'a', 'extraction', { value: { itemId: 'wrong' } })
    expect(coordinator.snapshot().items[0].stages.extraction.status).toBe('pending')
    expect(coordinator.ready()).toEqual([{ itemId: 'a', stage: 'extraction' }])
    await valid(coordinator, 'a', 'extraction')
    expect(coordinator.snapshot().items[0].stages['source-read'].artifact).toEqual(acceptedReader)
    await valid(coordinator, 'a', 'comparison')
    const summary = summarizeWorkItems(coordinator.snapshot())
    expect(summary.states.validated).toBe(1)
    expect(summary.corrections).toBe(1)
    expect(summary.reworkAttempts).toBe(1)
    expect(summary.attempts).toBe(5)
    expect(summary.accounting.requests).toEqual({ known: 4, unknownAttempts: 0, complete: true })
    expect(coordinator.snapshot().items[0].stages.extraction.attempts.map((attempt) => attempt.outcome)).toEqual(['invalid', 'accepted'])
    expect(coordinator.snapshot().items[0].stages.extraction.attempts[0].outputDigest).toMatch(/^sha256:/)
  })

  it('shares a single item correction budget across stages and explicitly holds exhaustion', async () => {
    const { coordinator } = await setup(['a'], 1)
    await valid(coordinator, 'a', 'deterministic')
    await valid(coordinator, 'a', 'extraction', { value: null })
    await valid(coordinator, 'a', 'extraction')
    await valid(coordinator, 'a', 'source-read', { value: null })
    const item = coordinator.snapshot().items[0]
    expect(item.corrections).toBe(1)
    expect(item.stages['source-read'].status).toBe('held')
    expect(item.stages['source-read'].reason).toMatch(/correction limit reached/)
    expect(coordinator.ready()).toEqual([])
    expect(summarizeWorkItems(coordinator.snapshot()).states.held).toBe(1)
    await expect(coordinator.start('a', 'source-read')).rejects.toThrow(/not ready/)
  })

  it.each(['wrong-binding', 'wrong-item', 'bad-provenance', 'missing-usage', 'non-json', 'negative-usage', 'approval-injection'] as const)('never accepts invalid %s output, even on first completion', async (bad) => {
    const { coordinator } = await setup(['a'], 0)
    const request = await coordinator.start('a', 'deterministic')
    const raw = clone(output(request)) as unknown as Record<string, unknown>
    if (bad === 'wrong-binding') raw.attempt = { ...request.attempt, sourceManifestHash: digestWorkItemValue('different-source') }
    if (bad === 'wrong-item') raw.value = { itemId: 'different-item', schema: 1 }
    if (bad === 'bad-provenance') raw.provenance = 'model-produced'
    if (bad === 'missing-usage') delete raw.accounting
    if (bad === 'non-json') raw.value = NaN
    if (bad === 'negative-usage') raw.accounting = { ...ZERO, requests: -1 }
    if (bad === 'approval-injection') raw.qualifiedApproved = true
    await coordinator.complete(request.attempt, raw)
    const stage = coordinator.snapshot().items[0].stages.deterministic
    expect(stage.status).toBe('held')
    expect(stage.artifact).toBeNull()
    expect(stage.attempts[0].outcome).toBe('invalid')
    expect(coordinator.ready()).toEqual([])
    expect(summarizeWorkItems(coordinator.snapshot()).coverage.native).toBe(0)
  })

  it.each(['throws', 'malformed', 'claims-approval'] as const)('holds unavailable/%s validators instead of accepting or using correction loops', async (mode) => {
    const checked = validator(() => {
      if (mode === 'throws') throw new Error('synthetic validator unavailable')
      return (mode === 'malformed' ? { valid: 'yes' } : { valid: true, qualifiedApproved: true }) as unknown as WorkItemValidation
    })
    const { coordinator, checkpoints, frozen } = await setup(['a'], 2, checked)
    await valid(coordinator, 'a', 'deterministic')
    const slot = coordinator.snapshot().items[0].stages.deterministic
    expect(slot.status).toBe('held')
    expect(slot.reason).toMatch(/structural validator unavailable/)
    expect(slot.artifact).toBeNull()
    expect(coordinator.snapshot().items[0].corrections).toBe(0)
    const restored = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 2 })
    expect(restored.ready()).toEqual([])
  })

  it('never treats an invalid comparison as a validated item, even with two accepted branches', async () => {
    const { coordinator, checkpoints, checked, frozen } = await setup(['a'], 0)
    for (const stage of ['deterministic', 'extraction', 'source-read'] as const) await valid(coordinator, 'a', stage)
    await valid(coordinator, 'a', 'comparison', { value: { itemId: 'a', schema: 'unsupported' } })
    const summary = summarizeWorkItems(coordinator.snapshot())
    expect(summary.states.validated).toBe(0)
    expect(summary.states.held).toBe(1)
    expect(summary.coverage).toMatchObject({ native: 1, extraction: 1, sourceRead: 1, compared: 0 })
    expect(coordinator.snapshot().items[0].stages.comparison.artifact).toBeNull()
    const restored = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 0 })
    expect(restored.ready()).toEqual([])
    expect(summarizeWorkItems(restored.snapshot()).states.held).toBe(1)
  })

  it.each([true, false])('keeps structural acceptance distinct from manifest/worker qualified hold (manifest=%s)', async (required) => {
    const items = definitions(['a']); items[0].requiresQualifiedReview = required
    const checkpoints = new Checkpoints()
    const coordinator = await WorkItemCoordinator.open(createWorkItemManifest('synthetic-run', items), { checkpoints, validator: validator(), maxCorrections: 0 })
    for (const stage of ['deterministic', 'extraction', 'source-read'] as const) await valid(coordinator, 'a', stage)
    await valid(coordinator, 'a', 'comparison', { qualifiedReview: !required }) // false cannot undo frozen selection
    expect(coordinator.snapshot().items[0].stages.comparison.status).toBe('accepted')
    const summary = summarizeWorkItems(coordinator.snapshot())
    expect(summary.states['qualified-hold']).toBe(1)
    expect(summary.states.validated).toBe(0)
    expect(summary.coverage.compared).toBe(1)
    expect(summary.states).not.toHaveProperty('approved')
    expect(coordinator.ready()).toEqual([])
    const restored = await WorkItemCoordinator.open(coordinator.snapshot().manifest, { checkpoints, validator: validator(), maxCorrections: 0 })
    expect(summarizeWorkItems(restored.snapshot()).states['qualified-hold']).toBe(1)
    expect(restored.ready()).toEqual([])
  })

  it('preserves native/model/fallback/failure-only provenance and explicit complete/unknown usage', async () => {
    const { coordinator } = await setup(['paired', 'fallback', 'failure', 'untouched'])
    await finish(coordinator, 'paired')
    await valid(coordinator, 'fallback', 'deterministic')
    await valid(coordinator, 'fallback', 'extraction', { provenance: 'deterministic-fallback', accounting: ZERO })
    await valid(coordinator, 'fallback', 'source-read')
    await valid(coordinator, 'fallback', 'comparison')
    await coordinator.execute('failure', 'deterministic', (request) => ({ kind: 'failed', attempt: request.attempt, reason: 'synthetic native failure', accounting: UNKNOWN }))
    const summary = summarizeWorkItems(coordinator.snapshot())
    expect(summary.denominator).toBe(4)
    expect(Object.values(summary.states).reduce((total, count) => total + count, 0)).toBe(4)
    expect(summary.states).toMatchObject({ validated: 2, failed: 1, pending: 1 })
    expect(summary.coverage).toEqual({ native: 2, extraction: 2, sourceRead: 2, compared: 2, pairedNonfallback: 1, deterministicFallback: 1, failureOnly: 1 })
    expect(summary.attempts).toBe(9)
    expect(summary.accounting.requests).toEqual({ known: 5, unknownAttempts: 1, complete: false })
    expect(summary.accounting.inputTokens).toEqual({ known: 50, unknownAttempts: 1, complete: false })
    expect(coordinator.snapshot().items[1].stages.extraction.artifact!.output.provenance).toBe('deterministic-fallback')
  })

  it('resumes interrupted work without redoing accepted items or implicitly replaying running work', async () => {
    const { coordinator, checkpoints, checked, frozen } = await setup(['accepted', 'interrupted'], 1)
    await finish(coordinator, 'accepted')
    await valid(coordinator, 'interrupted', 'deterministic')
    const accepted = clone(coordinator.snapshot().items[0])
    const old = await coordinator.start('interrupted', 'extraction')
    const restored = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 1 })
    expect(restored.ready()).toEqual([{ itemId: 'interrupted', stage: 'source-read' }])
    expect(restored.snapshot().items[0]).toEqual(accepted)
    await expect(restored.start('accepted', 'deterministic')).rejects.toThrow(/not ready/)
    await expect(restored.start('interrupted', 'extraction')).rejects.toThrow(/not ready/)
    await restored.reconcile(old.attempt, { quiescent: true, retry: true, reason: 'owner confirmed synthetic worker drained; accounting unknown', accounting: UNKNOWN })
    const replacement = await restored.start('interrupted', 'extraction')
    expect(replacement.attempt.number).toBe(2)
    expect(await restored.complete(old.attempt, output(old))).toEqual({ applied: false, disposition: 'duplicate' })
    expect(await restored.complete({ ...old.attempt, id: 'unrecognized-old-attempt', number: 999 }, output(old))).toEqual({ applied: false, disposition: 'stale' })
    await restored.complete(replacement.attempt, output(replacement))
    await valid(restored, 'interrupted', 'source-read')
    await valid(restored, 'interrupted', 'comparison')
    expect(restored.snapshot().items[0]).toEqual(accepted)
    const summary = summarizeWorkItems(restored.snapshot())
    expect(summary.denominator).toBe(2)
    expect(summary.states.validated).toBe(2)
    expect(summary.reworkAttempts).toBe(1)
    expect(summary.accounting.requests.unknownAttempts).toBe(1) // interruption did not refund/zero unknown spend
  })

  it('requires explicit quiescent reconciliation and holds retries beyond the correction budget', async () => {
    const { coordinator } = await setup(['a'], 0)
    const request = await coordinator.start('a', 'deterministic')
    await expect(coordinator.reconcile(request.attempt, { quiescent: false, retry: true, reason: 'not drained', accounting: UNKNOWN } as never)).rejects.toThrow(/quiescent/)
    expect(coordinator.snapshot().items[0].stages.deterministic.status).toBe('running')
    await coordinator.reconcile(request.attempt, { quiescent: true, retry: true, reason: 'drained but no correction budget', accounting: UNKNOWN })
    expect(coordinator.snapshot().items[0].stages.deterministic.status).toBe('held')
    expect(coordinator.ready()).toEqual([])
  })

  it('ignores duplicate/stale completions without extra durable transitions', async () => {
    const { coordinator, checkpoints } = await setup(['a'])
    const request = await coordinator.start('a', 'deterministic')
    await expect(coordinator.start('a', 'deterministic')).rejects.toThrow(/not ready/)
    const before = checkpoints.acknowledgements
    const results = await Promise.all([coordinator.complete(request.attempt, output(request)), coordinator.complete(request.attempt, output(request))])
    expect(results.map((result) => result.disposition).sort()).toEqual(['committed', 'duplicate'])
    expect(checkpoints.acknowledgements).toBe(before + 1)
    expect(await coordinator.complete(request.attempt, output(request, { value: 'conflicting duplicate' }))).toEqual({ applied: false, disposition: 'duplicate' })
    expect(checkpoints.acknowledgements).toBe(before + 1)
  })

  it('rechecks attempt authority after awaiting structural validation', async () => {
    const gate = deferred<WorkItemValidation>()
    const checked = validator(() => gate.promise)
    const { coordinator } = await setup(['a'], 1, checked)
    const request = await coordinator.start('a', 'deterministic')
    const completing = coordinator.complete(request.attempt, output(request))
    await coordinator.reconcile(request.attempt, { quiescent: true, retry: true, reason: 'synthetic revoked/drained during validation', accounting: UNKNOWN })
    const replacement = await coordinator.start('a', 'deterministic')
    gate.resolve({ valid: true })
    expect(await completing).toEqual({ applied: false, disposition: 'duplicate' })
    expect(coordinator.snapshot().items[0].stages.deterministic.artifact).toBeNull()
    expect(coordinator.snapshot().items[0].stages.deterministic.attempts.at(-1)!.attempt).toEqual(replacement.attempt)
  })

  it('CAS-fences two coordinators before effects and requires reopening a conflicted instance', async () => {
    const { coordinator, checkpoints, checked, frozen } = await setup(['a'])
    const competing = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 1 })
    await coordinator.start('a', 'deterministic')
    const effect = vi.fn()
    await expect(competing.execute('a', 'deterministic', effect)).rejects.toThrow(/checkpoint commit failed.*CAS conflict/)
    expect(effect).not.toHaveBeenCalled()
    await expect(competing.start('a', 'deterministic')).rejects.toThrow(/authority uncertain/)
    const restored = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 1 })
    expect(restored.ready()).toEqual([])
    expect(summarizeWorkItems(restored.snapshot()).accounting.requests).toEqual({ known: 0, unknownAttempts: 1, complete: false })
  })

  it('reopens the durable authority after an ambiguous acknowledgement, rather than rerunning accepted work', async () => {
    const { coordinator, checkpoints, checked, frozen } = await setup(['a'])
    const request = await coordinator.start('a', 'deterministic')
    checkpoints.failAfterWrite = true
    await expect(coordinator.complete(request.attempt, output(request))).rejects.toThrow(/lost durability acknowledgement/)
    expect(coordinator.snapshot().items[0].stages.deterministic.status).toBe('running')
    await expect(coordinator.start('a', 'source-read')).rejects.toThrow(/authority uncertain/)
    const restored = await WorkItemCoordinator.open(frozen, { checkpoints, validator: checked, maxCorrections: 1 })
    expect(restored.snapshot().items[0].stages.deterministic.status).toBe('accepted')
    expect(restored.ready()).toEqual([{ itemId: 'a', stage: 'extraction' }, { itemId: 'a', stage: 'source-read' }])
  })

  it('binds validation to an immutable copied output digest, not later mutable worker data', async () => {
    const gate = deferred<WorkItemValidation>()
    const checked = validator((_request, candidate) => {
      expect(Object.isFrozen(candidate.value)).toBe(true)
      return gate.promise
    })
    const { coordinator } = await setup(['a'], 0, checked)
    const request = await coordinator.start('a', 'deterministic')
    const raw = output(request)
    const originalDigest = digestWorkItemValue(raw)
    const completing = coordinator.complete(request.attempt, raw)
    raw.value = 'mutated after validation began'
    gate.resolve({ valid: true })
    await completing
    const artifact = coordinator.snapshot().items[0].stages.deterministic.artifact!
    expect(artifact.digest).toBe(originalDigest)
    expect(artifact.output.value).not.toBe(raw.value)
    expect(artifact.validator).toEqual(checked.identity)
  })

  it('records thrown worker failure with unknown usage instead of success or a hidden retry', async () => {
    const { coordinator } = await setup(['a'], 2)
    const worker = vi.fn(() => { throw new Error('synthetic stop') })
    await coordinator.execute('a', 'deterministic', worker)
    expect(worker).toHaveBeenCalledTimes(1)
    const slot = coordinator.snapshot().items[0].stages.deterministic
    expect(slot.status).toBe('failed')
    expect(slot.attempts[0]).toMatchObject({ outcome: 'failed', provenance: 'failure-status-only', accounting: UNKNOWN })
    expect(coordinator.ready()).toEqual([])
    expect(summarizeWorkItems(coordinator.snapshot()).accounting.requests.complete).toBe(false)
  })
})
