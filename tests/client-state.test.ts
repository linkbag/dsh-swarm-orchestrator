import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Board, BoardRole, BoardRun, BoardTask } from '../client/board-store.js'
import { normalizeWorkspace, resolveBoardSelection, selectionAfterSuccessfulAction, toggleTask, visibleRuns, type TaskKey } from '../client/board-selection.js'
import { RequestOwner } from '../client/request-owner.js'
import { acceptSaved, configKey, createDraft, dutyDraft, editDraft, isDirty, keepDraft, parseRuntimeDraft, receiveLive, reloadDraft, RUNTIME_FIELDS, runtimeDraft } from '../client/settings-draft.js'
import { RUNTIME_LIMITS } from '../client/runtime-limits.js'
import { agentIdentity, reviewLabel, reviewState } from '../client/review-state.js'
import { EN_DICT, ZH_DICT, t } from '../client/locale.js'
import { isHostStale } from '../client/version.js'
import { SwarmTab } from '../client/SwarmTab.js'
import { RuntimeSettings } from '../client/RuntimeSettings.js'

const role: BoardRole = { id: 'builder', label: 'Builder', description: 'Build', provider: 'p', model: 'old', fallbacks: [] }
const run: BoardRun = { id: 'run-a', title: 'A', spec: 'Spec', status: 'running', createdAt: 1, updatedAt: 2, taskIds: ['t'], dispatch: { cwd: 'D:\\Work\\A' } }
const task: BoardTask = { runId: 'run-a', id: 't', subject: 'Current subject', description: 'Current brief', role: 'builder', status: 'reviewing', attempts: 1, updatedAt: 2, reviewBy: 'reviewer', humanReview: true }
function board(patch: Partial<Board> = {}): Board {
  return { service: 'swarm', version: '0.6.30', seq: 1, at: 2, roles: { builder: role }, runs: [run], tasks: [task], ...patch }
}
const source = (name: string): string => readFileSync(fileURLToPath(new URL(`../client/${name}`, import.meta.url)), 'utf8')

// No new DOM dependency: pure-state tests exercise transitions; server markup
// verifies common render surfaces, not a real browser event dispatch.
describe('draft ownership and live-config conflicts', () => {
  it('compares reordered keys and undefined fields without creating conflicts', () => {
    expect(configKey({ a: 1, b: { z: 2, x: undefined } })).toBe(configKey({ b: { z: 2 }, a: 1 }))
  })

  it('keeps dirty duty-table edits through progress-only snapshots and metadata changes', () => {
    const live = board({ override: { enabled: true, note: 'lock', at: 1, setBy: 'dashboard' } })
    let state = createDraft(dutyDraft(live))
    state = editDraft(state, { ...state.value, roles: { builder: { ...role, model: 'draft' } } })
    const progressed = structuredClone(live)
    progressed.seq = 100
    progressed.at = 500
    progressed.tasks[0].lastNote = 'progress'
    progressed.override = { ...live.override!, at: 300, setBy: 'another-author' }
    state = receiveLive(state, dutyDraft(progressed))
    expect(state.value.roles.builder.model).toBe('draft')
    expect(state.conflict).toBe(false)
    expect(isDirty(state)).toBe(true)
  })

  it('keeps dirty runtime text, including invalid entries, through progress snapshots', () => {
    let state = createDraft(runtimeDraft({ maxConcurrent: 3 }))
    state = editDraft(state, { ...state.value, maxConcurrent: 'not-a-number' })
    state = receiveLive(state, runtimeDraft({ maxConcurrent: 3 }))
    expect(state.value.maxConcurrent).toBe('not-a-number')
    expect(state.conflict).toBe(false)
    expect(() => parseRuntimeDraft(state.value)).toThrow('maxConcurrent must be an integer')
  })

  it('observed live changes require explicit Keep or Reload, even if live later reverts', () => {
    const initial = { setting: 'old' }
    let state = editDraft(createDraft(initial), { setting: 'local' })
    state = receiveLive(state, { setting: 'external' })
    expect(state.value).toEqual({ setting: 'local' })
    expect(state.conflict).toBe(true)
    const kept = keepDraft(state)
    expect(kept.baseline).toEqual({ setting: 'external' })
    expect(kept.value).toEqual({ setting: 'local' })
    expect(kept.conflict).toBe(false)
    expect(isDirty(kept)).toBe(true)
    expect(receiveLive(kept, { setting: 'external' }).conflict).toBe(false)
    const reloaded = reloadDraft(state)
    expect(reloaded.value).toEqual({ setting: 'external' })
    expect(reloaded.conflict).toBe(false)
    expect(isDirty(reloaded)).toBe(false)
    state = receiveLive(state, initial)
    expect(state.conflict).toBe(true)
    expect(reloadDraft(state).value).toEqual(initial)
  })

  it('clean drafts adopt live settings without modifying their source objects', () => {
    const next = { setting: 'new', nested: { number: 2 } }
    const state = receiveLive(createDraft({ setting: 'old', nested: { number: 1 } }), next)
    expect(state.value).toEqual(next)
    state.value.nested.number = 10
    expect(next.nested.number).toBe(2)
    expect(state.baseline.nested.number).toBe(2)
  })

  it('a save acknowledgement only replaces its captured draft revision', () => {
    const initial = { setting: 'old' }
    const submitted = editDraft(createDraft(initial), { setting: 'submitted' })
    const revision = submitted.revision
    const editedAgain = editDraft(submitted, { setting: 'newer local' })
    const result = acceptSaved(editedAgain, revision, { setting: 'normalized saved' }, submitted.latest)
    expect(result.value).toEqual({ setting: 'newer local' })
    expect(result.baseline).toEqual({ setting: 'normalized saved' })
    expect(isDirty(result)).toBe(true)
  })

  it('a POST acknowledgement cannot dismiss live changes observed while it was pending', () => {
    const submitted = editDraft(createDraft({ setting: 'old' }), { setting: 'submitted' })
    const changed = receiveLive(submitted, { setting: 'external newer' })
    const result = acceptSaved(changed, submitted.revision, submitted.value, submitted.latest)
    expect(result.value).toEqual(submitted.value)
    expect(result.latest).toEqual({ setting: 'external newer' })
    expect(result.conflict).toBe(true)
    expect(reloadDraft(result).value).toEqual({ setting: 'external newer' })
    const reverted = receiveLive(changed, submitted.latest)
    expect(acceptSaved(reverted, submitted.revision, submitted.value, submitted.latest).conflict).toBe(true)
  })

  it('does not hide a genuine live reversion behind the pre-save fingerprint', () => {
    const submitted = editDraft(createDraft({ setting: 'old' }), { setting: 'submitted' })
    const saved = acceptSaved(submitted, submitted.revision, submitted.value, submitted.latest)
    expect(isDirty(saved)).toBe(false)
    expect(receiveLive(saved, submitted.latest).value).toEqual({ setting: 'old' })
    const edited = editDraft(saved, { setting: 'next edit' })
    expect(receiveLive(edited, submitted.latest).conflict).toBe(true)
  })
})

describe('shared runtime policy and capability authority', () => {
  it('exposes all shared runtime keys with exactly the same bounds and defaults', () => {
    expect(RUNTIME_FIELDS.map((field) => field.key).sort()).toEqual(Object.keys(RUNTIME_LIMITS).sort())
    expect(RUNTIME_FIELDS.map((field) => field.key)).toEqual(expect.arrayContaining(['maxRetries', 'reviewLoops', 'evidenceTimeoutMs']))
    for (const field of RUNTIME_FIELDS) {
      expect({ min: field.min, max: field.max, default: field.default }).toEqual(RUNTIME_LIMITS[field.key])
      expect(EN_DICT[field.labelKey]).toBeDefined()
      expect(ZH_DICT[field.hintKey]).toBeDefined()
      expect(parseRuntimeDraft({ [field.key]: String(field.min) })[field.key]).toBe(field.min)
      expect(parseRuntimeDraft({ [field.key]: String(field.max) })[field.key]).toBe(field.max)
      for (const bad of [String(field.min - 1), String(field.max + 1), '1.5', 'Infinity', 'NaN', 'x']) {
        expect(() => parseRuntimeDraft({ [field.key]: bad }), `${field.key}: ${bad}`).toThrow()
      }
    }
    expect(parseRuntimeDraft({ maxConcurrent: '  ', maxRetries: '0', reviewLoops: '0' })).toEqual({ maxRetries: 0, reviewLoops: 0 })
  })

  it('does not silently omit one invalid field while claiming the rest was saved', () => {
    expect(() => parseRuntimeDraft({ maxConcurrent: '4', evidenceTimeoutMs: '999' })).toThrow('evidenceTimeoutMs')
  })

  it('renders every runtime control and shared-default hint', () => {
    const markup = renderToStaticMarkup(createElement(RuntimeSettings, { board: board() }))
    for (const field of RUNTIME_FIELDS) {
      expect(markup).toContain(t(field.labelKey))
      expect(markup).toContain(`default ${field.default}`)
    }
    expect(markup).not.toContain('{default}')
  })

  it('treats an explicit capabilities list, including [], as authoritative', () => {
    expect(isHostStale('99.99.99', [])).toBe(true)
    expect(isHostStale('99.99.99', ['some-future-action'])).toBe(true)
    expect(isHostStale('0.0.1', ['run-curation'])).toBe(false)
    expect(isHostStale('0.6.30')).toBe(false)
    expect(isHostStale('0.6.19')).toBe(true)
    expect(isHostStale(undefined)).toBe(false)
  })

  it('explains explicit missing capability without inventing a version/restart cause', () => {
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, { initialBoard: board({ capabilities: [], version: '99.0.0' }) }))
    expect(markup).toContain('does not advertise run management')
    expect(markup).not.toContain('restart DSH')
  })

  it('ties saved indicators to the acknowledged config, not later live changes', () => {
    for (const name of ['RuntimeSettings.tsx', 'DutyTableEditor.tsx']) {
      expect(source(name)).toContain('savedAt.config === configKey(state.value)')
    }
    expect(source('settings-draft.ts')).not.toContain('ignoredLive')
  })

  it('keeps English and Chinese hardening text in lockstep', () => {
    expect(Object.keys(EN_DICT).sort()).toEqual(Object.keys(ZH_DICT).sort())
  })
})

describe('selection and cancellation are key/lifetime owned', () => {
  it('resolves the current snapshot task rather than the previously clicked object', () => {
    const stale = { ...task, subject: 'Obsolete subject', description: 'Obsolete brief' }
    const next = board({ tasks: [{ ...task, lastNote: 'latest progress' }] })
    const resolved = resolveBoardSelection(next, next.runs, run.id, stale)
    expect(resolved.task).toBe(next.tasks[0])
    expect(resolved.task?.subject).toBe('Current subject')
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, { initialBoard: next, initialSelectedTask: stale }))
    expect(markup).toContain('Current brief')
    expect(markup).not.toContain('Obsolete brief')
  })

  it('never keeps a foreign run/task selection when runs or scope change', () => {
    const other = { ...run, id: 'run-b', status: 'completed', dispatch: { cwd: 'D:\\Work\\B' } }
    const next = board({ runs: [run, other] })
    expect(resolveBoardSelection(next, next.runs, other.id, task).task).toBeNull()
    expect(resolveBoardSelection(next, [other], run.id, task)).toEqual({ run: other, task: null })
    expect(resolveBoardSelection(board({ tasks: [] }), [run], run.id, task).task).toBeNull()
    expect(resolveBoardSelection(null, [], run.id, task)).toEqual({ run: null, task: null })
  })

  it('opens/toggles selection by both run and task ids', () => {
    const selected = { runId: 'run-a', id: 't' }
    expect(toggleTask(null, selected)).toEqual(selected)
    expect(toggleTask(selected, selected)).toBeNull()
    expect(toggleTask(selected, { runId: 'run-b', id: 't' })).toEqual({ runId: 'run-b', id: 't' })
  })

  it('closes only the successfully approved task, never rejects or a foreign selection', () => {
    const key: TaskKey = { runId: 'run-a', id: 't' }
    expect(selectionAfterSuccessfulAction(key, { action: 'review', verdict: 'approve', runId: key.runId, taskId: key.id })).toBeNull()
    expect(selectionAfterSuccessfulAction(key, { action: 'review', verdict: 'reject', runId: key.runId, taskId: key.id })).toBe(key)
    expect(selectionAfterSuccessfulAction(key, { action: 'review', verdict: 'approve', runId: 'run-b', taskId: key.id })).toBe(key)
    expect(selectionAfterSuccessfulAction(key, { action: 'retry-task', runId: key.runId, taskId: key.id })).toBe(key)
    // Markup cannot dispatch clicks: this additional source pin verifies the
    // tested transition is only reached after await succeeds and still owns UI.
    expect(source('SwarmTab.tsx')).toMatch(/await boardStore\(\)\.action\(body, request\.signal\)\s+if \(!request\.owns\(\)\) return\s+setSelectedTaskKey\(\(current\) => selectionAfterSuccessfulAction\(current, body\)\)/)
  })

  it('cancels old catalog/workspace/action ownership before a newer result or reset', () => {
    const owner = new RequestOwner()
    const first = owner.begin()
    expect(first.owns()).toBe(true)
    const newer = owner.begin()
    expect(first.signal.aborted).toBe(true)
    expect(first.owns()).toBe(false)
    expect(newer.owns()).toBe(true)
    owner.cancel(); owner.cancel()
    expect(newer.signal.aborted).toBe(true)
    expect(newer.owns()).toBe(false)
    expect(owner.begin().owns()).toBe(true)
  })

  it('keeps sessionless scope global and hides the previous workspace while resolving', () => {
    const other = { ...run, id: 'run-b', dispatch: { cwd: 'D:\\Work\\B' } }
    const next = board({ runs: [run, other] })
    const pending = { sessionId: 'old', cwd: run.dispatch!.cwd!, loading: false, error: null }
    expect(visibleRuns(next, 'workspace', 'new', pending)).toEqual([])
    expect(visibleRuns(next, 'workspace', undefined, pending)).toEqual(next.runs)
    expect(visibleRuns(next, 'workspace', 'new', { sessionId: 'new', cwd: 'd:/work/a/', loading: false, error: null })).toEqual([run])
    expect(visibleRuns(next, 'workspace', 'new', { sessionId: 'new', cwd: null, loading: false, error: 'lookup failed' })).toEqual(next.runs)
    expect(normalizeWorkspace('/Work/A')).not.toBe(normalizeWorkspace('/work/a'))
  })
})

describe('honest review and common error/freshness display', () => {
  it.each([
    [{ status: 'completed', reviewed: true }, 'approved'],
    [{ status: 'completed', reviewed: true, reviewExhausted: true }, 'exhausted'],
    [{ status: 'completed', reviewed: true, reviewUnavailable: true }, 'unavailable'],
    [{ status: 'completed', reviewed: false }, 'skipped'],
    [{ status: 'completed', reviewed: true, attemptRevoked: true }, 'invalidated'],
    [{ status: 'reviewing', humanReview: true }, 'human-pending'],
    [{ status: 'reviewing', humanReview: false }, 'pending'],
    [{ status: 'running', reviewed: true, humanReview: false }, 'changes-requested'],
  ])('does not confuse a recorded verdict with approval: %j', (patch, expected) => {
    expect(reviewState({ ...task, ...patch } as BoardTask)).toBe(expected)
  })

  it('recognizes human reviewGate and does not invent approval for completed ungated tasks', () => {
    expect(reviewState({ ...task, reviewBy: undefined, humanReview: false, reviewGate: 'human' })).toBe('human-pending')
    expect(reviewState({ ...task, status: 'completed', reviewBy: undefined, humanReview: false })).toBe('not-requested')
  })

  it('shows builder and reviewer agent identity separately without replacing the builder', () => {
    const reviewed: BoardTask = { ...task, status: 'completed', reviewed: true, humanReview: false,
      agent: { label: 'build-child', provider: 'p', model: 'build-model', effort: 'high' },
      reviewerAgent: { label: 'review-child', provider: 'q', model: 'review-model', effort: 'low' },
      fileWarnings: ['Unexpected file touched'], evidenceOutcomes: [{ path: 'result.txt', status: 'passed' }],
    }
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, { initialBoard: board({ tasks: [reviewed] }), initialView: 'flow', initialSelectedTask: reviewed }))
    expect(markup).toContain('build-child')
    expect(markup).toContain('p/build-model')
    expect(markup).toContain('review-child')
    expect(markup).toContain('q/review-model')
    expect(markup).toContain('Unexpected file touched')
    expect(markup).toContain('Evidence outcomes')
    expect(agentIdentity(reviewed.agent, '?')).toBe('build-child · p/build-model · high')
  })

  it.each(['board', 'flow', 'roster'] as const)('shows action failure and board freshness/error in sessionless %s scope', (view) => {
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, {
      initialBoard: board(), initialView: view, initialSync: 'reconnecting', initialError: 'snapshot fetch failed', initialActionError: 'action refused',
    }))
    expect(markup).toContain('reconnecting · last snapshot')
    expect(markup).toContain('snapshot fetch failed')
    expect(markup).toContain('action refused')
    expect(markup.match(/role="alert"/g)).toHaveLength(2)
  })

  it('does not count unavailable run-report reviews as passed or hide them from the total', () => {
    const completed: BoardRun = { ...run, status: 'completed', report: {
      completedAt: 10, durationMs: 1000, taskCount: 3, byStatus: { completed: 3 },
      stats: { fallbacks: 0, retries: 0, reviewsPassed: 1, reviewsRejected: 0, reviewsUnavailable: 2 }, tasks: [],
    } }
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, { initialBoard: board({ runs: [completed] }) }))
    expect(markup).toContain('1/3 reviews passed')
    expect(markup).toContain('2 review(s) unavailable — not approved')
  })

  it('shows a failed first fetch even without a snapshot or session', () => {
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, { initialError: 'network failed' }))
    expect(markup).toContain('network failed')
    expect(markup).toContain('No board snapshot available')
    expect(markup).toContain('Retry refresh')
  })

  it.each(['unavailable', 'exhausted'] as const)('does not render approved ticks for %s review', (flag) => {
    const failedReview: BoardTask = { ...task, status: 'completed', humanReview: false, reviewed: true, ...(flag === 'unavailable' ? { reviewUnavailable: true } : { reviewExhausted: true }) }
    const markup = renderToStaticMarkup(createElement<NonNullable<Parameters<typeof SwarmTab>[0]>>(SwarmTab, { initialBoard: board({ tasks: [failedReview] }), initialSelectedTask: failedReview }))
    expect(markup).toContain(reviewLabel(failedReview, t))
    expect(markup).not.toContain('✓✓')
    expect(markup).not.toContain('review approved')
  })

  it('renders the shared status even when the global badge has no runs', () => {
    const entry = source('index.ts')
    expect(entry).toContain("view.text || t('header.title')")
    expect(entry).toContain('latestError = error')
    expect(entry).toContain('latestSync = sync')
    expect(entry).not.toContain('if (board !== null) render(board)')
    expect(entry).toContain("badge.style.display = 'block'")
    expect(source('ToolDispatchCard.tsx')).toContain('review: task')
    expect(source('ToolDispatchCard.tsx')).not.toContain("t('card.reviewedBy'")
  })
})
