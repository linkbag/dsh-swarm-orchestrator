import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { makeBuildReceipt, validateBuildReceipt } from '../scripts/build-receipt.mjs'

const ROOT = join(__dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const RECEIPT = join(ROOT, 'lib', 'build-receipt.json')
const owned: string[] = []
afterEach(() => {
  for (const root of owned.splice(0)) {
    expect(realpathSync(root)).toBe(root)
    expect(root.startsWith(realpathSync(tmpdir()) + sep + 'swarm-build-receipt-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-build-receipt-'))); owned.push(root)
  for (const dir of ['src', 'client', 'lib']) mkdirSync(join(root, dir))
  writeFileSync(join(root, 'package.json'), '{"name":"synthetic","version":"1"}')
  writeFileSync(join(root, 'src', 'index.ts'), 'source-original')
  writeFileSync(join(root, 'client', 'index.ts'), 'client-original')
  writeFileSync(join(root, 'lib', 'index.js'), 'host-built')
  writeFileSync(join(root, 'lib', 'client.js'), 'client-built')
  return root
}

describe('content-bound build receipts', () => {
  it('detects changed source even when size and mtime are restored', () => {
    const root = fixture()
    const receipt = makeBuildReceipt(root, 'full')
    const file = join(root, 'client', 'index.ts'), prior = statSync(file)
    writeFileSync(file, 'client-modified')
    utimesSync(file, prior.atime, prior.mtime)
    expect(validateBuildReceipt(root, receipt)).toContain('input changed: client/index.ts')
  })
  it('detects output tampering, missing outputs and new unrecorded source', () => {
    const root = fixture(), receipt = makeBuildReceipt(root, 'full')
    expect(validateBuildReceipt(root, receipt)).toEqual([])
    writeFileSync(join(root, 'lib', 'client.js'), 'tampered')
    writeFileSync(join(root, 'src', 'new.ts'), 'new')
    expect(validateBuildReceipt(root, receipt)).toEqual(expect.arrayContaining(['output changed: lib/client.js', 'input changed: src/new.ts']))
  })
  it('does not certify a client-only build as a fresh host build', () => {
    const root = fixture()
    expect(validateBuildReceipt(root, makeBuildReceipt(root, 'client-only'))).toContain('full host/client build receipt required')
  })
})

describe.skipIf(!existsSync(BUNDLE))('built host/client artifacts (explicitly skipped on a source-only checkout)', () => {
  it('matches source, lock/toolchain and output hashes, rather than mtime', () => {
    expect(existsSync(RECEIPT), 'Run npm run build to produce a complete receipt').toBe(true)
    const receipt: unknown = JSON.parse(readFileSync(RECEIPT, 'utf8'))
    expect(validateBuildReceipt(ROOT, receipt), 'Stale or unverified artifact: run npm run build; this does not verify the loaded GUI generation').toEqual([])
  })
  it('contains no leftover hardcoded dark fills', () => {
    expect(readFileSync(BUNDLE, 'utf8')).not.toContain('rgba(20, 22, 26')
  })
})
