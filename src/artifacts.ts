import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { assertAllowedKeys, isPlainRecord } from './domain/limits.js'
import type { ArtifactContract, TaskEvidence } from './domain/types.js'

const MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_BYTES = 1024 * 1024
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

export function validateArtifactContract(value: unknown): asserts value is ArtifactContract {
  if (!isPlainRecord(value)) throw new Error('artifact contract must be an object')
  assertAllowedKeys(value, ['path', 'format', 'sha256', 'requiredKeys', 'schemaVersion', 'minRecords', 'maxBytes'], 'artifact')
  if (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 4096 || value.path.includes('\0')) throw new Error('invalid artifact path')
  if (!['json', 'jsonl', 'text', 'binary'].includes(value.format as string)) throw new Error('invalid artifact format')
  if (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))) throw new Error('invalid artifact sha256')
  if (value.requiredKeys !== undefined && (!Array.isArray(value.requiredKeys) || value.requiredKeys.length > 128 || value.requiredKeys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 128))) throw new Error('invalid artifact requiredKeys')
  if (value.schemaVersion !== undefined && typeof value.schemaVersion !== 'string' && (typeof value.schemaVersion !== 'number' || !Number.isFinite(value.schemaVersion))) throw new Error('invalid artifact schemaVersion')
  for (const [key, max] of [['maxBytes', MAX_BYTES], ['minRecords', 100000]] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < (key === 'maxBytes' ? 1 : 0) || (value[key] as number) > max)) throw new Error('invalid artifact ' + key)
  }
}

export interface ArtifactCheck {
  valid: boolean
  issues: string[]
  digest: string
  records: Array<{ path: string; sha256?: string; valid: boolean; reason?: string }>
}

/** Bounded, deterministic structural validation; never a clinical/semantic verdict. */
export function checkArtifacts(evidence: TaskEvidence | undefined, workspace: string): ArtifactCheck {
  const records: ArtifactCheck['records'] = []
  const contracts: ArtifactContract[] = [
    ...(evidence?.files ?? []).map((path): ArtifactContract => ({ path, format: 'binary', maxBytes: MAX_BYTES, minRecords: 1 })),
    ...(evidence?.artifacts ?? []),
  ]
  for (const contract of contracts) {
    let sha256: string | undefined
    try {
      validateArtifactContract(contract)
      if (isAbsolute(contract.path)) throw new Error('path must be workspace-relative')
      const root = realpathSync(workspace)
      const file = resolve(root, contract.path)
      const rel = relative(root, file)
      if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('path escapes workspace')
      const info = lstatSync(file)
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('artifact must be a regular non-linked file')
      const actual = realpathSync(file)
      const actualRel = relative(root, actual)
      if (actualRel === '..' || actualRel.startsWith('..' + sep) || isAbsolute(actualRel)) throw new Error('artifact resolves outside workspace')
      const maxBytes = contract.maxBytes ?? DEFAULT_BYTES
      if (info.size === 0 || info.size > maxBytes) throw new Error('artifact is empty or exceeds maxBytes')
      const fd = openSync(file, 'r')
      let bytes: Buffer
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('artifact changed during validation')
        const buffer = Buffer.alloc(maxBytes + 1)
        let used = 0
        while (used < buffer.length) {
          const count = readSync(fd, buffer, used, buffer.length - used, null)
          if (count === 0) break
          used += count
        }
        bytes = buffer.subarray(0, used)
        const after = fstatSync(fd)
        if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('artifact changed during validation')
      } finally { closeSync(fd) }
      sha256 = digest(bytes)
      if (contract.sha256 !== undefined && sha256 !== contract.sha256) throw new Error('sha256 mismatch')
      const text = contract.format === 'binary' ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const values: unknown[] = contract.format === 'binary' ? [bytes] : contract.format === 'json' ? [JSON.parse(text)]
        : contract.format === 'jsonl' ? text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown)
          : text.trim().length > 0 ? [text] : []
      if (values.length < (contract.minRecords ?? 1)) throw new Error('insufficient records')
      if (contract.requiredKeys !== undefined || contract.schemaVersion !== undefined) {
        for (const value of values) {
          if (!isPlainRecord(value) || contract.requiredKeys?.some((key) => !Object.hasOwn(value, key)) === true) throw new Error('required keys missing')
          if (contract.schemaVersion !== undefined && value.version !== contract.schemaVersion) throw new Error('schema version mismatch')
        }
      }
      records.push({ path: contract.path, sha256, valid: true })
    } catch (error) {
      records.push({ path: contract.path, ...(sha256 !== undefined ? { sha256 } : {}), valid: false, reason: error instanceof Error ? error.message : 'artifact validation failed' })
    }
  }
  return { valid: records.every((item) => item.valid), issues: records.filter((item) => !item.valid).map((item) => item.path + ': ' + item.reason), digest: digest(JSON.stringify(records)), records }
}
