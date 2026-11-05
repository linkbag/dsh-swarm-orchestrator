import { createHash } from 'node:crypto'

/**
 * LOCAL application orchestration, not another runtime scheduler. The caller owns
 * dispatch/capacity, cancellation and quiescent cleanup, original-source access,
 * source-byte/hash verification, budgets, qualified review and durable storage.
 * `execute` runs ONE selected stage; a DSH workflow/static DAG may own dispatch,
 * never both for the same item. This module neither reads files nor enforces
 * filesystem/network isolation. A source-read request omits generated answers;
 * that data shape is NOT a certified blind-reader security boundary.
 *
 * Checkpoints must live outside transient workflow scripts. The adapter must
 * atomically CAS and durably acknowledge one complete record, under exclusive
 * storage ownership. A thrown/ambiguous write poisons this instance: reopen from
 * that authority, never infer acceptance from output files or automatically
 * resend running work. Digests detect content changes, not malicious forgery.
 * Accounting is caller-reported; correction limits are not a certified request,
 * token or spend cap. Source acquisition and qualified approval stay external.
 */
export type WorkItemValue = null | boolean | number | string | WorkItemValue[] | { [key: string]: WorkItemValue }
export type WorkItemStage = 'deterministic' | 'extraction' | 'source-read' | 'comparison'
export type WorkItemProvenance = 'deterministic-native' | 'model-produced' | 'deterministic-fallback' | 'operator-supplied'
export interface WorkItemDefinition {
  id: string
  /** Original-source descriptors, including caller-verified locators/digests. */
  source: WorkItemValue
  /** Original narrow question/inputs, NOT a generated extractor answer. */
  input: WorkItemValue
  /** Frozen qualified-review selection; workers can only escalate this. */
  requiresQualifiedReview: boolean
}
export interface WorkItemManifest {
  version: 1
  runId: string
  sourceManifestHash: string
  inputManifestHash: string
  items: WorkItemDefinition[]
}
export interface WorkItemValidatorIdentity { id: string; version: string; digest: string }
export interface WorkItemAccounting {
  /** Null is unknown, never zero. Counts cover this attempt, including rework. */
  requests: number | null
  inputTokens: number | null
  outputTokens: number | null
  sourceActions: number | null
}
export interface WorkItemAttempt {
  id: string
  runId: string
  itemId: string
  stage: WorkItemStage
  number: number
  sourceManifestHash: string
  inputManifestHash: string
}
interface WorkItemRequestBase { attempt: WorkItemAttempt; item: WorkItemDefinition }
/** Only the item's own comparison receives both branch artifacts. */
export type WorkItemRequest =
  | (WorkItemRequestBase & { stage: 'deterministic' | 'source-read' })
  | (WorkItemRequestBase & { stage: 'extraction'; native: WorkItemArtifact })
  | (WorkItemRequestBase & { stage: 'comparison'; native: WorkItemArtifact; extraction: WorkItemArtifact; sourceRead: WorkItemArtifact })
export interface WorkItemOutput {
  kind: 'output'
  attempt: WorkItemAttempt
  value: WorkItemValue
  provenance: WorkItemProvenance
  accounting: WorkItemAccounting
  /** Escalation only. A structural validator cannot issue qualified approval. */
  qualifiedReview?: boolean
}
export interface WorkItemFailure {
  kind: 'failed' | 'held'
  attempt: WorkItemAttempt
  reason: string
  accounting: WorkItemAccounting
}
export type WorkItemOutcome = WorkItemOutput | WorkItemFailure
export type WorkItemValidation = { valid: true } | { valid: false; reason: string }
export interface WorkItemValidator {
  identity: WorkItemValidatorIdentity
  /** Trusted, version/digest-pinned STRUCTURAL validation, not domain approval. */
  validate(request: WorkItemRequest, output: WorkItemOutput): WorkItemValidation | Promise<WorkItemValidation>
}
export interface WorkItemArtifact { output: WorkItemOutput; digest: string; validator: WorkItemValidatorIdentity }
export interface WorkItemAttemptRecord {
  attempt: WorkItemAttempt
  outcome: 'running' | 'accepted' | 'invalid' | 'failed' | 'held' | 'interrupted'
  provenance: WorkItemProvenance | 'failure-status-only' | null
  accounting: WorkItemAccounting
  outputDigest: string | null
  validation: WorkItemValidation | null
  reason: string | null
}
export interface WorkItemStageState {
  status: 'pending' | 'running' | 'accepted' | 'failed' | 'held'
  attempts: WorkItemAttemptRecord[]
  artifact: WorkItemArtifact | null
  reason: string | null
}
export interface WorkItemState {
  id: string
  corrections: number
  stages: Record<WorkItemStage, WorkItemStageState>
}
export interface WorkItemCheckpoint {
  version: 1
  revision: number
  manifest: WorkItemManifest
  validator: WorkItemValidatorIdentity
  maxCorrections: number
  items: WorkItemState[]
  digest: string
}
export interface WorkItemCheckpointAdapter {
  load(runId: string): Promise<WorkItemCheckpoint | null>
  /** Null means create-only. True must mean DURABLE; false means CAS conflict. */
  compareAndSet(runId: string, expectedRevision: number | null, next: WorkItemCheckpoint): Promise<boolean>
}
export interface WorkItemReady { itemId: string; stage: WorkItemStage }
export interface WorkItemCommit { applied: boolean; disposition: 'committed' | 'duplicate' | 'stale' }
export type WorkItemStatus = 'pending' | 'running' | 'validated' | 'failed' | 'held' | 'qualified-hold'
export interface WorkItemSummary {
  denominator: number
  itemIds: string[]
  states: Record<WorkItemStatus, number>
  coverage: { native: number; extraction: number; sourceRead: number; compared: number; pairedNonfallback: number; deterministicFallback: number; failureOnly: number }
  attempts: number
  reworkAttempts: number
  corrections: number
  /** Started attempts only; complete does NOT certify provider coverage/budgets. */
  accounting: Record<keyof WorkItemAccounting, { known: number; unknownAttempts: number; complete: boolean }>
}

const STAGES: WorkItemStage[] = ['deterministic', 'extraction', 'source-read', 'comparison']
const METRICS: (keyof WorkItemAccounting)[] = ['requests', 'inputTokens', 'outputTokens', 'sourceActions']
const PROVENANCE: WorkItemProvenance[] = ['deterministic-native', 'model-produced', 'deterministic-fallback', 'operator-supplied']
const UNKNOWN: WorkItemAccounting = { requests: null, inputTokens: null, outputTokens: null, sourceActions: null }
const HASH = /^sha256:[a-f0-9]{64}$/
const COMMITTED: WorkItemCommit = { applied: true, disposition: 'committed' }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('unexpected work-item field')
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw new Error(`invalid ${label}`)
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('invalid work-item integer')
}
function canonical(value: unknown, depth = 0, ancestors = new Set<object>()): string {
  if (depth > 64) throw new Error('work-item JSON is too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('work-item data must be finite, acyclic JSON')
  if (!Array.isArray(value) && !record(value)) throw new Error('work-item data must be plain JSON')
  ancestors.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new Error('work-item JSON cannot contain accessors')
  let result: string
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('work-item JSON cannot contain sparse/custom arrays')
    result = `[${value.map((entry) => canonical(entry, depth + 1, ancestors)).join(',')}]`
  } else {
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(descriptors[key].value, depth + 1, ancestors)}`).join(',')}}`
  }
  ancestors.delete(value)
  if (result.length > 8 * 1024 * 1024) throw new Error('work-item JSON exceeds 8 MiB')
  return result
}
/** Canonical JSON SHA-256. Source bytes behind locators remain caller-verified. */
export function digestWorkItemValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}
function copy<T>(value: T): T { return JSON.parse(canonical(value)) as T }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function identity(value: WorkItemValidatorIdentity): WorkItemValidatorIdentity {
  const result = copy(value)
  if (!record(result)) throw new Error('invalid work-item validator identity')
  keys(result, ['id', 'version', 'digest'])
  text(result.id, 'validator id'); text(result.version, 'validator version')
  if (!HASH.test(result.digest)) throw new Error('invalid validator digest')
  return freeze(result)
}
function accounting(value: unknown): WorkItemAccounting {
  if (!record(value)) throw new Error('missing work-item accounting')
  keys(value, METRICS)
  for (const metric of METRICS) if (value[metric] !== null) integer(value[metric], 0)
  return value as unknown as WorkItemAccounting
}

/** Captures ordered IDs and original inputs, defensively copied/deep-frozen. */
export function createWorkItemManifest(runId: string, definitions: readonly WorkItemDefinition[]): WorkItemManifest {
  text(runId, 'run id')
  const items = copy(definitions)
  if (!Array.isArray(items) || items.length === 0 || items.length > 10000) throw new Error('a manifest needs 1..10000 items')
  const ids = new Set<string>()
  for (const item of items) {
    if (!record(item)) throw new Error('invalid work-item definition')
    keys(item, ['id', 'source', 'input', 'requiresQualifiedReview'])
    text(item.id, 'item id')
    if (ids.has(item.id) || typeof item.requiresQualifiedReview !== 'boolean' || !('source' in item) || !('input' in item)) throw new Error('duplicate/invalid frozen work item')
    ids.add(item.id)
  }
  return freeze({
    version: 1,
    runId,
    sourceManifestHash: digestWorkItemValue(items.map(({ id, source }) => ({ id, source }))),
    inputManifestHash: digestWorkItemValue(items.map(({ id, input, requiresQualifiedReview }) => ({ id, input, requiresQualifiedReview }))),
    items: [...items],
  })
}
function seal(checkpoint: Omit<WorkItemCheckpoint, 'digest'>): WorkItemCheckpoint {
  return freeze({ ...checkpoint, digest: digestWorkItemValue(checkpoint) })
}
function emptyCheckpoint(manifest: WorkItemManifest, validator: WorkItemValidatorIdentity, maxCorrections: number): WorkItemCheckpoint {
  const pending = (): WorkItemStageState => ({ status: 'pending', attempts: [], artifact: null, reason: null })
  return seal({
    version: 1, revision: 0, manifest, validator, maxCorrections,
    items: manifest.items.map(({ id }) => ({
      id, corrections: 0,
      stages: { deterministic: pending(), extraction: pending(), 'source-read': pending(), comparison: pending() },
    })),
  })
}
function binding(checkpoint: WorkItemCheckpoint, itemId: string, stage: WorkItemStage, number: number): WorkItemAttempt {
  return {
    id: JSON.stringify([checkpoint.manifest.runId, itemId, stage, number]), runId: checkpoint.manifest.runId, itemId, stage, number,
    sourceManifestHash: checkpoint.manifest.sourceManifestHash, inputManifestHash: checkpoint.manifest.inputManifestHash,
  }
}
function same(a: unknown, b: unknown): boolean { return digestWorkItemValue(a) === digestWorkItemValue(b) }
function assertCheckpoint(state: WorkItemCheckpoint, manifest: WorkItemManifest, validator: WorkItemValidatorIdentity, maxCorrections: number): void {
  if (!record(state) || state.version !== 1) throw new Error('unsupported work-item checkpoint version')
  keys(state, ['version', 'revision', 'manifest', 'validator', 'maxCorrections', 'items', 'digest'])
  const { digest, ...body } = state
  if (digestWorkItemValue(body) !== digest) throw new Error('work-item checkpoint digest mismatch')
  if (!same(state.manifest, manifest)) throw new Error('frozen source/input manifest mismatch (including item IDs/order)')
  if (!same(state.validator, validator) || state.maxCorrections !== maxCorrections) throw new Error('work-item validator/policy mismatch')
  integer(state.revision, 0)
  if (!Array.isArray(state.items) || state.items.length !== manifest.items.length) throw new Error('frozen work-item denominator mismatch')
  for (let index = 0; index < state.items.length; index++) {
    const item = state.items[index]
    if (!record(item) || item.id !== manifest.items[index].id || !record(item.stages)) throw new Error('invalid checkpoint item')
    keys(item, ['id', 'corrections', 'stages']); keys(item.stages, STAGES)
    integer(item.corrections, 0, maxCorrections)
    for (const stage of STAGES) {
      const slot = item.stages[stage]
      if (!record(slot) || !['pending', 'running', 'accepted', 'failed', 'held'].includes(slot.status) || !Array.isArray(slot.attempts)) throw new Error('invalid checkpoint stage')
      keys(slot, ['status', 'attempts', 'artifact', 'reason'])
      for (let n = 0; n < slot.attempts.length; n++) {
        const attempt = slot.attempts[n]
        if (!record(attempt) || !same(attempt.attempt, binding(state, item.id, stage, n + 1))) throw new Error('invalid checkpoint attempt identity')
        keys(attempt, ['attempt', 'outcome', 'provenance', 'accounting', 'outputDigest', 'validation', 'reason'])
        if (!['running', 'accepted', 'invalid', 'failed', 'held', 'interrupted'].includes(attempt.outcome)) throw new Error('invalid checkpoint attempt outcome')
        accounting(attempt.accounting)
        if ((attempt.outcome === 'running') !== (slot.status === 'running' && n === slot.attempts.length - 1)) throw new Error('invalid running checkpoint attempt')
      }
      const last = slot.attempts.at(-1)
      if (slot.status === 'running' && !last) throw new Error('running checkpoint lacks attempt')
      if (slot.status === 'accepted') {
        const artifact = slot.artifact
        if (!artifact || !last || last.outcome !== 'accepted' || !same(artifact.validator, validator) || artifact.digest !== digestWorkItemValue(artifact.output) || artifact.digest !== last.outputDigest || !same(artifact.output.attempt, last.attempt) || last.validation?.valid !== true) throw new Error('unvalidated checkpoint artifact')
        parseOutcome(last.attempt, artifact.output)
      } else if (slot.artifact !== null || last?.outcome === 'accepted') throw new Error('invalid checkpoint acceptance')
      if (slot.attempts.length > 0 && stage !== 'deterministic' && item.stages.deterministic.status !== 'accepted') throw new Error('checkpoint skipped deterministic extraction')
      if (slot.attempts.length > 0 && stage === 'comparison' && (item.stages.extraction.status !== 'accepted' || item.stages['source-read'].status !== 'accepted')) throw new Error('checkpoint skipped per-item join')
    }
  }
}

/** Pure eligibility: no all-extractor barrier; a failed sibling is not an input. */
export function readyWorkItems(checkpoint: WorkItemCheckpoint): WorkItemReady[] {
  const ready: WorkItemReady[] = []
  for (const item of checkpoint.items) {
    const stages = item.stages
    if (stages.deterministic.status === 'pending') ready.push({ itemId: item.id, stage: 'deterministic' })
    if (stages.deterministic.status !== 'accepted') continue
    for (const stage of ['extraction', 'source-read'] as const) if (stages[stage].status === 'pending') ready.push({ itemId: item.id, stage })
    if (stages.extraction.status === 'accepted' && stages['source-read'].status === 'accepted' && stages.comparison.status === 'pending') ready.push({ itemId: item.id, stage: 'comparison' })
  }
  return ready
}
function requestFor(checkpoint: WorkItemCheckpoint, attempt: WorkItemAttempt): WorkItemRequest {
  const item = checkpoint.manifest.items.find((entry) => entry.id === attempt.itemId)!
  const stages = checkpoint.items.find((entry) => entry.id === attempt.itemId)!.stages
  const base = { attempt, item }
  if (attempt.stage === 'extraction') return freeze({ ...base, stage: 'extraction', native: stages.deterministic.artifact! })
  if (attempt.stage === 'comparison') return freeze({ ...base, stage: 'comparison', native: stages.deterministic.artifact!, extraction: stages.extraction.artifact!, sourceRead: stages['source-read'].artifact! })
  return freeze({ ...base, stage: attempt.stage })
}
function current(checkpoint: WorkItemCheckpoint, attempt: WorkItemAttempt): { item: WorkItemState; slot: WorkItemStageState; last: WorkItemAttemptRecord } | WorkItemCommit {
  const item = checkpoint.items.find((entry) => entry.id === attempt.itemId)
  const slot = item?.stages[attempt.stage]
  const last = slot?.attempts.at(-1)
  if (last && same(last.attempt, attempt) && slot!.status === 'running') return { item: item!, slot: slot!, last }
  const duplicate = slot?.attempts.some((entry) => same(entry.attempt, attempt) && entry.outcome !== 'running')
  return { applied: false, disposition: duplicate ? 'duplicate' : 'stale' }
}
function parseOutcome(attempt: WorkItemAttempt, raw: unknown): WorkItemOutcome {
  const value = copy(raw)
  if (!record(value)) throw new Error('worker result must be an output/failure envelope')
  if (!same(value.attempt, attempt)) throw new Error('worker result has a stale/wrong source, input or attempt binding')
  accounting(value.accounting)
  if (value.kind === 'failed' || value.kind === 'held') {
    keys(value, ['kind', 'attempt', 'reason', 'accounting']); text(value.reason, 'failure/hold reason')
  } else if (value.kind === 'output') {
    keys(value, ['kind', 'attempt', 'value', 'provenance', 'accounting', 'qualifiedReview'])
    if (!('value' in value) || !PROVENANCE.includes(value.provenance as WorkItemProvenance) || (value.qualifiedReview !== undefined && typeof value.qualifiedReview !== 'boolean')) throw new Error('invalid worker output envelope')
    if (attempt.stage === 'deterministic' && value.provenance !== 'deterministic-native') throw new Error('deterministic-first stage requires deterministic-native provenance')
  } else throw new Error('unknown worker result kind')
  return freeze(value as unknown as WorkItemOutcome)
}
function diagnostic(error: unknown): string { return (error instanceof Error ? error.message : 'unavailable').slice(0, 256) || 'unavailable' }
function correctOrHold(item: WorkItemState, slot: WorkItemStageState, limit: number, reason: string): void {
  slot.reason = reason
  if (item.corrections < limit) { item.corrections++; slot.status = 'pending' }
  else { slot.status = 'held'; slot.reason = `correction limit reached: ${reason}` }
}

/** No automatic loops, retries, background jobs, model/network or filesystem I/O. */
export class WorkItemCoordinator {
  private queue: Promise<void> = Promise.resolve()
  private poisoned = false
  private constructor(private state: WorkItemCheckpoint, private readonly adapter: WorkItemCheckpointAdapter, private readonly validator: WorkItemValidator) {}

  static async open(manifest: WorkItemManifest, options: { checkpoints: WorkItemCheckpointAdapter; validator: WorkItemValidator; maxCorrections: number }): Promise<WorkItemCoordinator> {
    const frozen = createWorkItemManifest(manifest.runId, manifest.items)
    if (!same(frozen, manifest)) throw new Error('invalid frozen source/input manifest')
    integer(options.maxCorrections, 0, 8)
    const validatorIdentity = identity(options.validator.identity)
    const validator: WorkItemValidator = { identity: validatorIdentity, validate: options.validator.validate.bind(options.validator) }
    const loaded = await options.checkpoints.load(frozen.runId)
    let state: WorkItemCheckpoint
    if (loaded === null) {
      state = emptyCheckpoint(frozen, validatorIdentity, options.maxCorrections)
      if (!await options.checkpoints.compareAndSet(frozen.runId, null, state)) throw new Error('checkpoint creation conflict; reopen')
    } else {
      state = copy(loaded)
      assertCheckpoint(state, frozen, validatorIdentity, options.maxCorrections)
      freeze(state)
    }
    return new WorkItemCoordinator(state, options.checkpoints, validator)
  }

  /** Immutable snapshot. Running attempts survive reopening and are NOT resent. */
  snapshot(): WorkItemCheckpoint { return this.state }
  ready(): WorkItemReady[] { return readyWorkItems(this.state) }

  private async change<T>(transition: (next: WorkItemCheckpoint) => { changed: boolean; result: T }): Promise<T> {
    const before = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await before
    try {
      if (this.poisoned) throw new Error('checkpoint authority uncertain; reopen before further work')
      const next = copy(this.state)
      const { changed, result } = transition(next)
      if (!changed) return result
      next.revision++
      const { digest: _oldDigest, ...body } = next
      const sealed = seal(body)
      try {
        if (!await this.adapter.compareAndSet(next.manifest.runId, this.state.revision, sealed)) throw new Error('checkpoint CAS conflict')
      } catch (error) {
        this.poisoned = true
        throw new Error(`checkpoint commit failed; reopen: ${diagnostic(error)}`)
      }
      this.state = sealed
      return result
    } finally { release() }
  }

  /** Durably records ownership BEFORE the caller starts the effect. */
  async start(itemId: string, stage: WorkItemStage): Promise<WorkItemRequest> {
    return this.change((next) => {
      if (!readyWorkItems(next).some((entry) => entry.itemId === itemId && entry.stage === stage)) throw new Error('work-item stage is not ready')
      const slot = next.items.find((item) => item.id === itemId)!.stages[stage]
      const attempt = binding(next, itemId, stage, slot.attempts.length + 1)
      slot.status = 'running'; slot.reason = null
      slot.attempts.push({ attempt, outcome: 'running', provenance: null, accounting: { ...UNKNOWN }, outputDigest: null, validation: null, reason: null })
      return { changed: true, result: requestFor(next, attempt) }
    })
  }

  /** Fenced again AFTER async validation; duplicates/stale attempts are no-ops. */
  async complete(attempt: WorkItemAttempt, raw: unknown): Promise<WorkItemCommit> {
    const token = freeze(copy(attempt))
    const active = current(this.state, token)
    if ('applied' in active) return active
    const request = requestFor(this.state, token)
    let outcome: WorkItemOutcome | null = null
    let validation: WorkItemValidation | null = null
    let problem: string | null = null
    let unavailable = false
    try { outcome = parseOutcome(token, raw) } catch (error) { problem = diagnostic(error) }
    if (outcome?.kind === 'output') {
      try {
        const checked = copy(await this.validator.validate(request, outcome))
        if (!record(checked) || typeof checked.valid !== 'boolean') throw new Error('malformed structural validator result')
        keys(checked, checked.valid ? ['valid'] : ['valid', 'reason'])
        if (!checked.valid) text(checked.reason, 'validation reason')
        validation = checked as unknown as WorkItemValidation
      } catch (error) { unavailable = true; problem = `structural validator unavailable: ${diagnostic(error)}` }
    }
    return this.change((next) => {
      const active = current(next, token)
      if ('applied' in active) return { changed: false, result: active }
      const { item, slot, last } = active
      last.accounting = outcome ? outcome.accounting : { ...UNKNOWN }
      last.provenance = outcome?.kind === 'output' ? outcome.provenance : 'failure-status-only'
      last.outputDigest = outcome?.kind === 'output' ? digestWorkItemValue(outcome) : null
      last.validation = validation
      if (unavailable) {
        last.outcome = 'held'; last.reason = problem; slot.status = 'held'; slot.reason = problem
      } else if (problem || (validation && !validation.valid)) {
        const reason = problem ?? (validation as { valid: false; reason: string }).reason
        last.outcome = 'invalid'; last.reason = reason
        correctOrHold(item, slot, next.maxCorrections, reason)
      } else if (outcome?.kind === 'output' && validation?.valid === true) {
        last.outcome = 'accepted'
        slot.status = 'accepted'; slot.reason = null
        slot.artifact = { output: outcome, digest: last.outputDigest!, validator: next.validator }
      } else if (outcome?.kind === 'failed' || outcome?.kind === 'held') {
        last.outcome = outcome.kind; last.reason = outcome.reason
        slot.status = outcome.kind; slot.reason = outcome.reason
      } else throw new Error('output cannot be accepted without structural validation')
      return { changed: true, result: COMMITTED }
    })
  }

  async execute(itemId: string, stage: WorkItemStage, worker: (request: WorkItemRequest) => unknown | Promise<unknown>): Promise<WorkItemCommit> {
    const request = await this.start(itemId, stage)
    let result: unknown
    try { result = await worker(request) } catch (error) {
      result = { kind: 'failed', attempt: request.attempt, reason: `worker failed: ${diagnostic(error)}`.slice(0, 512), accounting: { ...UNKNOWN } } satisfies WorkItemFailure
    }
    return this.complete(request.attempt, result)
  }

  /**
   * Explicit recovery only AFTER the owner has fenced/drained the old worker.
   * `quiescent: true` is a caller assertion, not an isolation/cleanup proof.
   * Retry consumes the SAME per-item correction budget; unknown usage is kept.
   * No automatic release of held or qualified-review work is provided here.
   */
  async reconcile(attempt: WorkItemAttempt, resolution: { quiescent: true; retry: boolean; reason: string; accounting: WorkItemAccounting }): Promise<WorkItemCommit> {
    const token = freeze(copy(attempt))
    const decision = copy(resolution)
    if (decision.quiescent !== true || typeof decision.retry !== 'boolean') throw new Error('quiescent reconciliation required')
    text(decision.reason, 'reconciliation reason'); accounting(decision.accounting)
    return this.change((next) => {
      const active = current(next, token)
      if ('applied' in active) return { changed: false, result: active }
      const { item, slot, last } = active
      last.outcome = 'interrupted'; last.provenance = 'failure-status-only'; last.reason = decision.reason; last.accounting = decision.accounting
      if (decision.retry) correctOrHold(item, slot, next.maxCorrections, decision.reason)
      else { slot.status = 'held'; slot.reason = decision.reason }
      return { changed: true, result: COMMITTED }
    })
  }
}

/** Pure, stable-denominator reporting. Validated NEVER means qualified-approved. */
export function summarizeWorkItems(checkpoint: WorkItemCheckpoint): WorkItemSummary {
  const summary: WorkItemSummary = {
    denominator: checkpoint.manifest.items.length, itemIds: checkpoint.manifest.items.map((item) => item.id),
    states: { pending: 0, running: 0, validated: 0, failed: 0, held: 0, 'qualified-hold': 0 },
    coverage: { native: 0, extraction: 0, sourceRead: 0, compared: 0, pairedNonfallback: 0, deterministicFallback: 0, failureOnly: 0 },
    attempts: 0, reworkAttempts: 0, corrections: 0,
    accounting: Object.fromEntries(METRICS.map((metric) => [metric, { known: 0, unknownAttempts: 0, complete: true }])) as WorkItemSummary['accounting'],
  }
  for (let index = 0; index < checkpoint.items.length; index++) {
    const item = checkpoint.items[index]
    const stages = STAGES.map((stage) => item.stages[stage])
    const { deterministic, extraction, 'source-read': sourceRead, comparison } = item.stages
    let status: WorkItemStatus = 'pending'
    if (comparison.status === 'accepted') status = checkpoint.manifest.items[index].requiresQualifiedReview || stages.some((stage) => stage.artifact?.output.qualifiedReview === true) ? 'qualified-hold' : 'validated'
    else if (stages.some((stage) => stage.status === 'held')) status = 'held'
    else if (stages.some((stage) => stage.status === 'failed')) status = 'failed'
    else if (stages.some((stage) => stage.status === 'running')) status = 'running'
    summary.states[status]++
    if (deterministic.artifact) summary.coverage.native++
    if (extraction.artifact) summary.coverage.extraction++
    if (sourceRead.artifact) summary.coverage.sourceRead++
    if (comparison.artifact) {
      summary.coverage.compared++
      if (extraction.artifact?.output.provenance === 'model-produced' && sourceRead.artifact?.output.provenance === 'model-produced') summary.coverage.pairedNonfallback++
    }
    if (stages.some((stage) => stage.artifact?.output.provenance === 'deterministic-fallback')) summary.coverage.deterministicFallback++
    if ((status === 'failed' || status === 'held') && !extraction.artifact && !sourceRead.artifact) summary.coverage.failureOnly++
    summary.corrections += item.corrections
    for (const stage of stages) {
      summary.reworkAttempts += Math.max(0, stage.attempts.length - 1)
      for (const attempt of stage.attempts) {
        summary.attempts++
        for (const metric of METRICS) {
          const tally = summary.accounting[metric]
          const amount = attempt.accounting[metric]
          if (amount === null) { tally.unknownAttempts++; tally.complete = false }
          else tally.known += amount
        }
      }
    }
  }
  return summary
}
