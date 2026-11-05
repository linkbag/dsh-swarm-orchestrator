import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { checkArtifacts, validateArtifactContract, type ArtifactCheck } from '../src/artifacts.js'
import { validateDag } from '../src/domain/dag.js'
import type { ArtifactContract, RoleConfig, Run, Task, TaskSpec } from '../src/domain/types.js'
import { buildTaskPrompt } from '../src/dispatch/spawn.js'
import { DEFAULT_POLICY, taskPolicy, validatePolicy, type TaskPolicy } from '../src/policy.js'

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const MAX_BYTES = 16 * 1024 * 1024
const PREFIX = 'swarm-artifacts-owned-'
interface Fixture { root: string; workspace: string; outside: string; dev: number; ino: number }
const owned: Fixture[] = []

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), PREFIX)))
  const info = lstatSync(root)
  const entry = { root, workspace: join(root, 'workspace'), outside: join(root, 'outside'), dev: info.dev, ino: info.ino }
  owned.push(entry)
  mkdirSync(entry.workspace)
  mkdirSync(entry.outside)
  return entry
}

// The default Vitest global setup owns an isolated DSH_HOME. These tests import
// only pure modules and read/write only the exact fixture directories below.
afterEach(() => {
  for (const entry of owned.splice(0)) {
    expect(dirname(entry.root)).toBe(realpathSync(tmpdir()))
    expect(basename(entry.root).startsWith(PREFIX)).toBe(true)
    const info = lstatSync(entry.root)
    expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true)
    expect([info.dev, info.ino]).toEqual([entry.dev, entry.ino])
    expect(realpathSync(entry.root)).toBe(entry.root)
    rmSync(entry.root, { recursive: true, force: true })
    expect(existsSync(entry.root)).toBe(false)
  }
})

function check(workspace: string, ...artifacts: ArtifactContract[]): ArtifactCheck {
  return checkArtifacts({ artifacts }, workspace)
}

function rejected(result: ArtifactCheck, path: string, reason?: RegExp): void {
  expect(result.valid).toBe(false)
  expect(result.records).toHaveLength(1)
  expect(result.records[0]).toMatchObject({ path, valid: false })
  // Invalid readable bytes retain identity; an unreadable/missing artifact has
  // no fabricated hash. Validity is a separate field, never inferred from sha256.
  if (result.records[0].sha256 !== undefined) expect(result.records[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.records[0].reason).toEqual(expect.any(String))
  if (reason !== undefined) expect(result.records[0].reason).toMatch(reason)
  expect(result.issues).toEqual([`${path}: ${result.records[0].reason}`])
}

const contract = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ path: 'result.json', format: 'json', ...patch })

describe('artifact contract validation', () => {
  it.each(['json', 'jsonl', 'text', 'binary'])('accepts the %s format and bounded optional contracts', (format) => {
    expect(() => validateArtifactContract(contract({ format, sha256: 'a'.repeat(64), requiredKeys: ['id'], schemaVersion: 1, minRecords: 0, maxBytes: MAX_BYTES }))).not.toThrow()
  })

  it('accepts boundary lengths, string versions and data-only null-prototype objects', () => {
    const value = Object.assign(Object.create(null), contract({ path: 'x'.repeat(4096), requiredKeys: Array(128).fill('k'.repeat(128)), schemaVersion: 'v1', minRecords: 100000, maxBytes: 1 }))
    expect(() => validateArtifactContract(value)).not.toThrow()
  })

  it.each([
    ['null', null], ['array', []], ['string', 'result.json'], ['class instance', new Date(0)],
    ['missing path', { format: 'json' }], ['missing format', { path: 'result.json' }],
    ['empty path', contract({ path: '' })], ['non-string path', contract({ path: 1 })],
    ['NUL path', contract({ path: 'bad\0path' })], ['long path', contract({ path: 'x'.repeat(4097) })],
    ['unknown format', contract({ format: 'csv' })], ['wrong format type', contract({ format: 1 })],
    ['unknown field', contract({ optional: true })],
    ['short sha256', contract({ sha256: 'a'.repeat(63) })], ['uppercase sha256', contract({ sha256: 'A'.repeat(64) })],
    ['non-hex sha256', contract({ sha256: 'z'.repeat(64) })], ['non-string sha256', contract({ sha256: 12 })],
    ['non-array keys', contract({ requiredKeys: 'id' })], ['non-string key', contract({ requiredKeys: [1] })],
    ['empty key', contract({ requiredKeys: [''] })], ['long key', contract({ requiredKeys: ['x'.repeat(129)] })],
    ['too many keys', contract({ requiredKeys: Array(129).fill('id') })],
    ['null schema', contract({ schemaVersion: null })], ['object schema', contract({ schemaVersion: {} })],
    ['NaN schema', contract({ schemaVersion: NaN })], ['infinite schema', contract({ schemaVersion: Infinity })],
    ...[-1, 0.5, 100001, NaN, Infinity, '1', null].map((minRecords): [string, unknown] => [`invalid minRecords ${String(minRecords)}`, contract({ minRecords })]),
    ...[0, -1, 0.5, MAX_BYTES + 1, NaN, Infinity, '1', null].map((maxBytes): [string, unknown] => [`invalid maxBytes ${String(maxBytes)}`, contract({ maxBytes })]),
  ])('rejects %s before filesystem access', (_label, value) => {
    expect(() => validateArtifactContract(value)).toThrow()
  })

  it('rejects inherited, symbolic, hidden and accessor fields without invoking getters', () => {
    let reads = 0
    const accessor = Object.defineProperty(contract(), 'sha256', { enumerable: true, get() { reads += 1; throw new Error('getter must not run') } })
    const inherited = Object.create({ path: 'result.json', format: 'json' })
    const hidden = Object.defineProperty(contract(), 'hidden', { value: 1, enumerable: false })
    const symbolic = { ...contract(), [Symbol('hidden')]: true }
    for (const value of [accessor, inherited, hidden, symbolic]) expect(() => validateArtifactContract(value)).toThrow(/artifact contract must be an object/)
    expect(reads).toBe(0)
  })
})

describe('bounded structural artifact checks', () => {
  it('returns deterministic empty evidence without running command evidence', () => {
    const { workspace } = fixture()
    const empty = { valid: true, issues: [], digest: sha256('[]'), records: [] }
    expect(checkArtifacts(undefined, workspace)).toEqual(empty)
    expect(checkArtifacts({ commands: ['THIS IS NOT A SHELL INVOCATION'] }, workspace)).toEqual(empty)
  })

  it('checks own required keys and the exact schema version, retaining the byte hash', () => {
    const { workspace } = fixture()
    const bytes = '{"version":1,"id":null,"__proto__":"data"}\n'
    writeFileSync(join(workspace, 'result.json'), bytes)
    const result = check(workspace, { path: 'result.json', format: 'json', requiredKeys: ['id', '__proto__'], schemaVersion: 1, sha256: sha256(bytes) })
    const records = [{ path: 'result.json', sha256: sha256(bytes), valid: true }]
    expect(result).toEqual({ valid: true, issues: [], digest: sha256(JSON.stringify(records)), records })
    rejected(check(workspace, { path: 'result.json', format: 'json', requiredKeys: ['toString'] }), 'result.json', /required keys missing/)
    rejected(check(workspace, { path: 'result.json', format: 'json', schemaVersion: '1' }), 'result.json', /schema version mismatch/)
  })

  it.each(['null', '[]', '42', '"text"', '{"nested":{"id":1}}'])('does not treat %s as an object with the required top-level key', (bytes) => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'result.json'), bytes)
    rejected(check(workspace, { path: 'result.json', format: 'json', requiredKeys: ['id'] }), 'result.json', /required keys missing/)
  })

  it('accepts a string schema version and rejects absent or mismatched versions', () => {
    const { workspace } = fixture()
    for (const [bytes, valid] of [['{"version":"v1","id":1}', true], ['{"version":"v2","id":1}', false], ['{"id":1}', false]] as const) {
      writeFileSync(join(workspace, 'result.json'), bytes)
      expect(check(workspace, { path: 'result.json', format: 'json', schemaVersion: 'v1' }).valid).toBe(valid)
    }
  })

  it('counts nonblank JSONL records across LF/CRLF and checks every record', () => {
    const { workspace } = fixture()
    const bytes = '{"version":1,"id":1}\r\n\n \t\r\n{"version":1,"id":2}\n'
    const base: ArtifactContract = { path: 'rows.jsonl', format: 'jsonl', requiredKeys: ['id'], schemaVersion: 1, minRecords: 2 }
    writeFileSync(join(workspace, base.path), bytes)
    expect(check(workspace, base).valid).toBe(true)
    rejected(check(workspace, { ...base, minRecords: 3 }), base.path, /insufficient records/)
    writeFileSync(join(workspace, base.path), '{"version":1,"id":1}\n{"version":1}\n')
    rejected(check(workspace, base), base.path, /required keys missing/)
    writeFileSync(join(workspace, base.path), '{"version":1,"id":1}\n{"version":2,"id":2}\n')
    rejected(check(workspace, base), base.path, /schema version mismatch/)
  })

  it.each([
    { format: 'json' as const, bytes: '{not-json}' },
    { format: 'jsonl' as const, bytes: '{"id":1}\nnot-json\n' },
  ])('rejects malformed $format without throwing or returning a successful hash', ({ format, bytes }) => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'malformed'), bytes)
    rejected(check(workspace, { path: 'malformed', format }), 'malformed')
  })

  it.each(['text', 'json', 'jsonl'] as const)('requires valid UTF-8 for %s, not replacement decoding', (format) => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'invalid-utf8'), Buffer.from([0xc3, 0x28, 0xff]))
    rejected(check(workspace, { path: 'invalid-utf8', format }), 'invalid-utf8', /encoded data.*utf-8/i)
  })

  it('hashes arbitrary binary bytes and treats legacy files as binary, not UTF-8', () => {
    const { workspace } = fixture()
    const bytes = Buffer.from([0, 0xff, 0xc3, 0x28, 0x80])
    writeFileSync(join(workspace, 'result.bin'), bytes)
    const result = check(workspace, { path: 'result.bin', format: 'binary', sha256: sha256(bytes) })
    expect(result.valid).toBe(true)
    expect(result.records).toEqual([{ path: 'result.bin', sha256: sha256(bytes), valid: true }])
    expect(checkArtifacts({ files: ['result.bin'] }, workspace)).toEqual(result)
    rejected(check(workspace, { path: 'result.bin', format: 'binary', sha256: '0'.repeat(64) }), 'result.bin', /sha256 mismatch/)
  })

  it.each(['text', 'jsonl'] as const)('rejects whitespace-only %s by default but permits explicit zero records', (format) => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'blank'), ' \r\n\t\n')
    rejected(check(workspace, { path: 'blank', format }), 'blank', /insufficient records/)
    expect(check(workspace, { path: 'blank', format, minRecords: 0 }).valid).toBe(true)
  })

  it.each(['text', 'json', 'jsonl', 'binary'] as const)('rejects physically empty %s even with minRecords zero', (format) => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'empty'), '')
    rejected(check(workspace, { path: 'empty', format, minRecords: 0 }), 'empty', /empty or exceeds maxBytes/)
    rejected(checkArtifacts({ files: ['empty'] }, workspace), 'empty', /empty or exceeds maxBytes/)
  })

  it('bounds bytes rather than Unicode characters and accepts the exact size ceiling', () => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'unicode.txt'), 'é')
    expect(check(workspace, { path: 'unicode.txt', format: 'text', maxBytes: 2 }).valid).toBe(true)
    rejected(check(workspace, { path: 'unicode.txt', format: 'text', maxBytes: 1 }), 'unicode.txt', /empty or exceeds maxBytes/)
    writeFileSync(join(workspace, 'binary'), Buffer.from([0, 1, 2, 3]))
    expect(check(workspace, { path: 'binary', format: 'binary', maxBytes: 4 }).valid).toBe(true)
    rejected(check(workspace, { path: 'binary', format: 'binary', maxBytes: 3 }), 'binary', /empty or exceeds maxBytes/)
  })

  it('uses the 1 MiB default contract limit and a bounded 16 MiB legacy file limit', () => {
    const { workspace } = fixture()
    const path = join(workspace, 'large.bin')
    writeFileSync(path, Buffer.alloc(1024 * 1024, 0x61))
    expect(check(workspace, { path: 'large.bin', format: 'binary' }).valid).toBe(true)
    truncateSync(path, 1024 * 1024 + 1)
    rejected(check(workspace, { path: 'large.bin', format: 'binary' }), 'large.bin', /exceeds maxBytes/)
    expect(checkArtifacts({ files: ['large.bin'] }, workspace).valid).toBe(true)
    // Sparse extension is rejected by metadata before allocating/reading 16 MiB.
    truncateSync(path, MAX_BYTES + 1)
    rejected(check(workspace, { path: 'large.bin', format: 'binary', maxBytes: MAX_BYTES }), 'large.bin', /exceeds maxBytes/)
    rejected(checkArtifacts({ files: ['large.bin'] }, workspace), 'large.bin', /exceeds maxBytes/)
  })

  it('reports missing files, directories and invalid contracts without stopping other checks', () => {
    const { workspace } = fixture()
    mkdirSync(join(workspace, 'directory'))
    rejected(check(workspace, { path: 'missing', format: 'binary' }), 'missing', /ENOENT/)
    rejected(check(workspace, { path: 'directory', format: 'binary' }), 'directory', /regular non-linked file/)
    writeFileSync(join(workspace, 'valid.txt'), 'valid')
    const result = check(workspace,
      { path: 'valid.txt', format: 'text', maxBytes: 0 },
      { path: 'missing', format: 'binary' },
      { path: 'valid.txt', format: 'text' },
    )
    expect(result.valid).toBe(false)
    expect(result.records.map((record) => record.valid)).toEqual([false, false, true])
    expect(result.records[0].reason).toMatch(/invalid artifact maxBytes/)
    expect(result.issues).toHaveLength(2)
    expect(result.digest).toBe(sha256(JSON.stringify(result.records)))
  })

  it('rejects absolute paths, lexical escapes, the workspace itself and NUL paths', () => {
    const { workspace, outside } = fixture()
    writeFileSync(join(outside, 'data.bin'), 'outside-owned-fixture')
    for (const path of [join(outside, 'data.bin'), '../outside/data.bin', '.', 'sub/..', 'bad\0path']) {
      rejected(check(workspace, { path, format: 'binary' }), path, /workspace-relative|escapes workspace|invalid artifact path/)
    }
  })

  it('rejects a leaf file symlink instead of following it', ({ skip }) => {
    const { workspace } = fixture()
    const target = join(workspace, 'target.bin')
    const alias = join(workspace, 'alias.bin')
    writeFileSync(target, 'owned target')
    try { symlinkSync(target, alias, 'file') }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') skip('Windows file symlinks require Developer Mode or privilege; directory junction coverage remains active')
      throw error
    }
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    rejected(check(workspace, { path: 'alias.bin', format: 'binary' }), 'alias.bin', /regular non-linked file/)
  })

  it('rejects a symlink/junction ancestor resolving outside the workspace', () => {
    const { workspace, outside } = fixture()
    writeFileSync(join(outside, 'data.bin'), 'outside-owned-fixture')
    const alias = join(workspace, 'outside-alias')
    symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    rejected(check(workspace, { path: 'outside-alias/data.bin', format: 'binary' }), 'outside-alias/data.bin', /resolves outside workspace/)
  })

  it('rejects both hardlink aliases, including legacy file evidence', () => {
    const { workspace } = fixture()
    writeFileSync(join(workspace, 'original.bin'), 'owned data')
    linkSync(join(workspace, 'original.bin'), join(workspace, 'alias.bin'))
    expect(lstatSync(join(workspace, 'original.bin')).nlink).toBe(2)
    for (const path of ['original.bin', 'alias.bin']) {
      rejected(check(workspace, { path, format: 'binary' }), path, /regular non-linked file/)
      rejected(checkArtifacts({ files: [path] }, workspace), path, /regular non-linked file/)
    }
  })

  it('binds readable invalid artifacts to bytes rather than just the repeated error message', () => {
    const { workspace } = fixture()
    const path = join(workspace, 'invalid.json')
    const evidence: ArtifactContract = { path: 'invalid.json', format: 'json', requiredKeys: ['required'] }
    writeFileSync(path, '{"wrong":1}')
    const first = check(workspace, evidence)
    writeFileSync(path, '{"wrong":2}')
    const second = check(workspace, evidence)
    expect(first.valid).toBe(false)
    expect(second.valid).toBe(false)
    expect(second.records[0].reason).toBe(first.records[0].reason)
    expect(first.records[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(second.records[0].sha256).not.toBe(first.records[0].sha256)
    expect(second.digest).not.toBe(first.digest)
  })

  it('keeps digests stable for unchanged bytes and changes them for byte edits or artifact identity', () => {
    const { workspace } = fixture()
    const path = join(workspace, 'result.json')
    const evidence: ArtifactContract = { path: 'result.json', format: 'json', requiredKeys: ['id'] }
    writeFileSync(path, '{"id":1}')
    const first = check(workspace, evidence)
    expect(check(workspace, evidence)).toEqual(first)
    writeFileSync(path, '{"id":1}')
    expect(check(workspace, evidence).digest).toBe(first.digest)
    writeFileSync(path, '{ "id":1 }')
    const edited = check(workspace, evidence)
    expect(edited.valid).toBe(true)
    expect(edited.digest).not.toBe(first.digest)
    expect(edited.records[0].sha256).not.toBe(first.records[0].sha256)
    writeFileSync(join(workspace, 'other.json'), '{ "id":1 }')
    const renamed = check(workspace, { ...evidence, path: 'other.json' })
    expect(renamed.records[0].sha256).toBe(edited.records[0].sha256)
    expect(renamed.digest).not.toBe(edited.digest)
    rejected(check(workspace, { ...evidence, sha256: first.records[0].sha256 }), evidence.path, /sha256 mismatch/)
  })
})

const taskSpec = (patch: Partial<TaskSpec> = {}): TaskSpec => ({ id: 'build', subject: 'Build', description: 'Scoped regression fixture', role: 'builder', ...patch })

describe('advisory and required policy contracts', () => {
  it('starts with frozen advisory defaults and returns fresh policy values', () => {
    expect(DEFAULT_POLICY).toEqual({ version: 1, evidence: 'advisory', review: 'warn', isolation: 'advisory' })
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true)
    const first = taskPolicy({})
    first.evidence = 'required'
    expect(taskPolicy({})).toEqual(DEFAULT_POLICY)
  })

  it('lets task policy strengthen but never lower the run floor, without mutating input', () => {
    const policy: TaskPolicy = Object.freeze({ version: 1, evidence: 'required', review: 'strict', isolation: 'strict' })
    const override = Object.freeze({ evidence: 'advisory' as const, review: 'off' as const })
    expect(taskPolicy({ policy })).toEqual(policy)
    expect(taskPolicy({ policy }, { policy: override })).toEqual(policy)
    expect(taskPolicy({ policy: { ...DEFAULT_POLICY, review: 'off' } }, { policy: { evidence: 'required', review: 'strict' } })).toEqual({ version: 1, evidence: 'required', review: 'strict', isolation: 'advisory' })
    expect(policy.evidence).toBe('required')
    expect(override).toEqual({ evidence: 'advisory', review: 'off' })
  })

  it.each(['advisory', 'required'] as const)('validates %s policy and structural evidence independently of file existence', (evidence) => {
    expect(() => validatePolicy({ ...DEFAULT_POLICY, evidence })).not.toThrow()
    expect(() => validatePolicy({ evidence }, true)).not.toThrow()
    const task = taskSpec({ policy: { evidence }, evidence: { artifacts: [{ path: 'not-created.json', format: 'json', requiredKeys: ['id'], schemaVersion: 1 }] } })
    expect(validateDag([task])).toEqual({ valid: true, errors: [] })
    const invalid = { ...task, evidence: { artifacts: [{ path: 'not-created.json', format: 'json', maxBytes: 0 }] } } as TaskSpec
    expect(validateDag([invalid])).toEqual({ valid: false, errors: ['invalid artifact maxBytes'] })
  })

  it.each([
    null, [], new Date(0), {}, { ...DEFAULT_POLICY, version: 2 }, { ...DEFAULT_POLICY, version: '1' },
    { ...DEFAULT_POLICY, evidence: 'optional' }, { ...DEFAULT_POLICY, evidence: null },
    { ...DEFAULT_POLICY, review: 'required' }, { ...DEFAULT_POLICY, isolation: 'off' },
    { ...DEFAULT_POLICY, unknown: true },
  ])('rejects malformed or unsupported full policies: %j', (policy) => {
    expect(() => validatePolicy(policy)).toThrow()
  })

  it('permits partial task overrides but never a task-owned version or invalid enum', () => {
    expect(() => validatePolicy({}, true)).not.toThrow()
    expect(() => validatePolicy({ review: 'off' }, true)).not.toThrow()
    for (const policy of [{ version: 1 }, { evidence: 'optional' }, { review: 'required' }, { isolation: 'off' }, { unknown: true }]) {
      expect(() => validatePolicy(policy, true)).toThrow()
      expect(validateDag([taskSpec({ policy: policy as TaskSpec['policy'] })]).valid).toBe(false)
    }
  })

  it('rejects inherited or accessor policies without evaluating them', () => {
    let reads = 0
    const accessor = Object.defineProperty({ version: 1 }, 'evidence', { enumerable: true, get() { reads += 1; return 'required' } })
    for (const policy of [Object.create(DEFAULT_POLICY), accessor]) expect(() => validatePolicy(policy)).toThrow(/plain object/)
    expect(reads).toBe(0)
  })

  it('restates the effective task evidence mode and structural contract in the prompt', () => {
    const run: Run = { id: 'policy-run', title: 'Policy fixture', spec: 'No live agents', status: 'running', createdAt: 1, updatedAt: 1, taskIds: ['build'], policy: { ...DEFAULT_POLICY, evidence: 'required' } }
    const role: RoleConfig = { id: 'builder', label: 'Builder', description: 'Fixture only', fallbacks: [] }
    const task: Task = { ...taskSpec(), runId: run.id, status: 'running', attempts: 1, updatedAt: 1 }
    const evidence = { artifacts: [{ path: 'result.json', format: 'json' as const, requiredKeys: ['id'], schemaVersion: 1 }] }
    expect(buildTaskPrompt(run, task, role, { evidence })).toContain('artifact checks are required')
    const advisory = buildTaskPrompt(run, { ...task, policy: { evidence: 'advisory' } }, role, { evidence })
    expect(advisory).toContain('artifact checks are required')
    expect(advisory).toContain(`Structural artifact contract: ${JSON.stringify(evidence.artifacts[0])}`)
  })
})
