import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function canonicalWritableFile(file: string): string {
  const absolute = resolve(file)
  mkdirSync(dirname(absolute), { recursive: true })
  const canonical = join(realpathSync(dirname(absolute)), basename(absolute))
  try {
    const status = lstatSync(canonical)
    // Different hard-link names cannot share a pathname-based ownership marker.
    // Reject them (and file symlinks/special files) rather than claim fencing.
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error('writable event stores require a regular, non-symlink, single-link file')
    }
    return realpathSync(canonical)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical
    throw error
  }
}

/**
 * Dependency-free exclusive-create ownership for cooperating local writers.
 *
 * Every writer MUST use this protocol and the same stable filesystem namespace.
 * The marker is never expired, reclaimed by PID/liveness checks, or removed on
 * process exit. A paused owner therefore cannot lose ownership to a new writer.
 * Crashes (or exit without close) leave a marker and REQUIRE an operator to prove
 * ALL old writers stopped before manually removing it. Never remove a marker to
 * recover a merely slow, unreachable, or suspended process.
 *
 * This is NOT an OS advisory lock, a distributed lease, or a fence against raw
 * file writers, marker/directory deletion, namespace replacement, or filesystems
 * without atomic exclusive create. Symlinked parent directories are canonicalized;
 * file symlinks and existing hard links are refused. Store directories must not
 * be moved/replaced and new aliases/hard links must not be created while owned.
 * File-content fsync does not guarantee directory-entry power-loss durability.
 */
export class StoreOwnership {
  private identity: BigIntStats | undefined

  private constructor(
    readonly file: string,
    readonly marker: string,
    private descriptor: number | undefined,
  ) {}

  static acquire(file: string): StoreOwnership {
    let canonical: string
    try {
      canonical = canonicalWritableFile(file)
    } catch (error) {
      throw new Error(`cannot acquire exclusive event store ownership for ${file}: ${String(error)}`, { cause: error })
    }
    const marker = `${canonical}.owner`
    let descriptor: number
    try {
      descriptor = openSync(marker, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`event store ${canonical} is already owned or has an unreclaimed ownership marker ${marker}; refusing writable open (no automatic stale takeover)`, { cause: error })
      }
      throw new Error(`cannot acquire exclusive event store ownership for ${canonical}: ${String(error)}`, { cause: error })
    }
    const owner = new StoreOwnership(canonical, marker, descriptor)
    try {
      owner.identity = fstatSync(descriptor, { bigint: true })
      // Diagnostic metadata only. Neither PID nor nonce is a lease/fencing token.
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + '\n')
      fsyncSync(descriptor)
      owner.assertHeld()
      return owner
    } catch (error) {
      try { owner.close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `cannot initialize event store ownership for ${canonical}; ownership cleanup failed`, { cause: error })
      }
      throw new Error(`cannot initialize event store ownership for ${canonical}: ${String(error)}`, { cause: error })
    }
  }

  assertHeld(): void {
    if (this.descriptor === undefined || this.identity === undefined) {
      throw new Error(`event store ownership for ${this.file} is closed or unverified`)
    }
    const current = lstatSync(this.marker, { bigint: true })
    if (!current.isFile() || current.nlink !== 1n
      || current.dev !== this.identity.dev || current.ino !== this.identity.ino) {
      throw new Error(`event store ownership marker changed for ${this.file}; refusing storage access`)
    }
  }

  /** One-shot release; any uncertain cleanup leaves the marker fail-closed. */
  close(): void {
    if (this.descriptor === undefined) return
    const errors: unknown[] = []
    try { this.assertHeld() } catch (error) { errors.push(error) }
    const descriptor = this.descriptor
    // Never retry an ambiguous close against a descriptor number the OS may reuse.
    this.descriptor = undefined
    try { closeSync(descriptor) } catch (error) { errors.push(error) }
    if (errors.length === 0) {
      try { unlinkSync(this.marker) } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `cannot release event store ownership for ${this.file}; ownership marker was not removed; verify all writers stopped before manual recovery`)
    }
  }
}
