import { describe, expect, it } from 'vitest'
import { validateDag } from '../src/domain/dag.js'
import { DAG_LIMITS } from '../src/domain/limits.js'
import type { TaskSpec } from '../src/domain/types.js'

const task = (id: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ id, subject: id, description: '', role: 'builder', ...patch })
const validate = (input: unknown) => validateDag(input as TaskSpec[])

describe('bounded DAG validation', () => {
  it('accepts valid tasks with bounded models, write scopes and evidence contracts', () => {
    expect(validateDag([
      task('a', { writes: ['src/a.ts'], evidence: { files: ['src/a.ts'], commands: ['npm test'] }, model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
      task('b', { blockedBy: ['a'], reviewBy: 'reviewer', reviewGate: 'human' }),
    ])).toEqual({ valid: true, errors: [] })
  })

  it('validates a maximum-depth chain iteratively and detects a bounded deep cycle', () => {
    const tasks = Array.from({ length: DAG_LIMITS.tasks }, (_, i) => task(`t-${i}`, i > 0 ? { blockedBy: [`t-${i - 1}`] } : {}))
    expect(validateDag(tasks).valid).toBe(true)
    tasks[0].blockedBy = [tasks.at(-1)!.id]
    const result = validateDag(tasks)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatch(/dependency cycle/)
    expect(result.errors[0].length).toBeLessThan(256)
  })

  it('rejects unbounded chains before reading any task object', () => {
    let accessed = false
    const hostile = Object.defineProperty({}, 'id', { enumerable: true, get() { accessed = true; throw new Error('must not read') } })
    expect(validate(Array(20000).fill(hostile))).toEqual({ valid: false, errors: [`a run may have at most ${DAG_LIMITS.tasks} tasks`] })
    expect(accessed).toBe(false)
  })

  it.each([null, undefined, 3, {}, 'tasks', [], [null], [3], [[]], Array(2)])('returns invalid rather than throwing for a malformed task shape: %j', (input) => {
    expect(() => validate(input)).not.toThrow()
    expect(validate(input).valid).toBe(false)
  })

  it('contains inaccessible array/task properties and never invokes task getters', () => {
    let accessed = false
    const accessor = Object.defineProperty(task('a'), 'description', { enumerable: true, get() { accessed = true; return '' } })
    expect(validate([accessor]).valid).toBe(false)
    expect(accessed).toBe(false)
    const hostile = new Proxy([], { get() { throw new Error('inaccessible array') } })
    expect(validate(hostile)).toEqual({ valid: false, errors: ['task DAG cannot be read safely'] })
  })

  it.each([
    [task('a'), task('a')],
    [task('a', { blockedBy: ['missing'] })],
    [task('a', { blockedBy: ['a'] })],
    [task('a', { blockedBy: ['b', 'b'] }), task('b')],
    [task('constructor')], [task('__proto__')], [task('space here')],
  ].map((tasks) => ({ tasks })))('rejects duplicate, unsafe and invalid dependency identifiers', ({ tasks }) => {
    expect(validateDag(tasks).valid).toBe(false)
  })

  it.each([
    { id: 'x'.repeat(DAG_LIMITS.idChars + 1) },
    { subject: 'x'.repeat(DAG_LIMITS.subjectChars + 1) },
    { description: 'x'.repeat(DAG_LIMITS.descriptionChars + 1) },
    { subject: '   ' }, { description: '\0' },
    { blockedBy: 'a' }, { blockedBy: [null] },
    { blockedBy: Array.from({ length: DAG_LIMITS.blockersPerTask + 1 }, (_, i) => `t-${i}`) },
    { writes: [3] }, { writes: Array.from({ length: DAG_LIMITS.pathsPerTask + 1 }, (_, i) => `path-${i}`) },
    { writes: ['x'.repeat(DAG_LIMITS.pathChars + 1)] },
    { model: [] }, { model: { provider: 'p' } }, { model: { provider: 'p', model: 'm', unknown: 1 } },
    { evidence: [] }, { evidence: { commands: [null] } }, { evidence: { unexpected: true } },
    { evidence: { commands: Array.from({ length: DAG_LIMITS.evidenceCommands + 1 }, (_, i) => `cmd-${i}`) } },
    { evidence: { files: Array.from({ length: DAG_LIMITS.evidenceFiles + 1 }, (_, i) => `file-${i}`) } },
    { evidence: { commands: ['x'.repeat(DAG_LIMITS.commandChars + 1)] } },
    { reviewGate: 'other' }, { reviewBy: {} }, { unknown: true },
  ])('rejects malformed/oversized task fields before traversal', (patch) => {
    expect(validate([{ ...task('a'), ...patch }]).valid).toBe(false)
  })

  it('caps aggregate dependency edges and text before graph construction', () => {
    const dependencies = Array.from({ length: 64 }, (_, i) => `t-${i}`)
    const dense = Array.from({ length: 65 }, (_, i) => task(`t-${i}`, { blockedBy: dependencies }))
    expect(validateDag(dense)).toEqual({ valid: false, errors: [`a run may have at most ${DAG_LIMITS.edges} dependency edges`] })
    const large = Array.from({ length: 40 }, (_, i) => task(`t-${i}`, { description: 'x'.repeat(DAG_LIMITS.descriptionChars) }))
    expect(validateDag(large)).toEqual({ valid: false, errors: [`task text exceeds ${DAG_LIMITS.totalChars} characters per run`] })
  })

  it('returns bounded diagnostics when every submitted task is invalid', () => {
    const result = validate(Array.from({ length: DAG_LIMITS.tasks }, () => ({})))
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(DAG_LIMITS.errors)
  })
})
