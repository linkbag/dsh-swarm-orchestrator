import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertAllowedKeys, isPlainRecord } from './limits.js'
import type { SwarmEventRecord } from './types.js'

function record(value: unknown, previousSeq: number): SwarmEventRecord {
  if (!isPlainRecord(value)
    || !Number.isSafeInteger(value.seq) || (value.seq as number) <= previousSeq
    || typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at < 0
    || typeof value.kind !== 'string' || value.kind.length === 0 || value.kind.length > 256
    || (value.runId !== undefined && typeof value.runId !== 'string')
    || (value.taskId !== undefined && typeof value.taskId !== 'string')
    || (value.data !== undefined && !isPlainRecord(value.data))
    || (value.storeVersion !== undefined && value.storeVersion !== 2)) {
    throw new Error('invalid event envelope or non-increasing sequence')
  }
  assertAllowedKeys(value, ['seq', 'at', 'kind', 'runId', 'taskId', 'data', 'storeVersion'], 'event envelope')
  return value as unknown as SwarmEventRecord
}

/** Only a syntactically incomplete object at EOF is a repairable torn append. */
function isPartialObject(text: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError) || !text.trimStart().startsWith('{')) return false
  if (/Unexpected end of JSON input|Unterminated string in JSON/.test(error.message)) return true
  // Node 22 also reports an expected delimiter at exactly the end of input.
  const position = /\bat position (\d+)\b/.exec(error.message)
  return position !== null && Number(position[1]) === text.length && /Expected /.test(error.message)
}

/**
 * Single-writer append-only JSONL source of truth. Appends are synchronous and
 * fsync'd before publishing a sequence or notifying observers. This guarantees
 * file-content durability, not cross-process writer serialization or directory
 * entry durability after power loss. Complete corrupt records are never dropped.
 */
export class EventStore {
  private events: SwarmEventRecord[] = []
  private readonly listeners = new Set<(event: SwarmEventRecord) => void>()
  private nextSeq = 1
  private needsSeparator = false
  private failed: string | undefined
  /** Observable normal-load repairs/observer failures; never silence storage loss. */
  readonly diagnostics: string[] = []

  constructor(readonly file: string) {
    this.load()
  }

  private load(): void {
    let raw: Buffer
    try {
      raw = readFileSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`cannot read event store ${this.file}: ${String(error)}`, { cause: error })
    }
    let previousSeq = 0
    let previousPersisted = ''
    let strictSequences = false
    let legacyAdjusted = 0
    let firstLegacyLine = 0
    let start = 0
    let lineNumber = 0
    let repairOffset: number | undefined
    const loaded: SwarmEventRecord[] = []
    while (start < raw.length) {
      lineNumber += 1
      const newline = raw.indexOf(10, start)
      const end = newline === -1 ? raw.length : newline
      const text = raw.subarray(start, end).toString('utf8')
      if (text.trim().length > 0) {
        try {
          // Reject invalid UTF-8 in a complete record instead of replacing bytes.
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(start, end))
          const persisted = record(JSON.parse(decoded), 0)
          const persistedJSON = JSON.stringify(persisted)
          // Old writers produced real, distinct events with colliding/reset seqs.
          // Physical append order remains authoritative. Preserve every record and
          // its original cursor without ever rewriting the historical bytes.
          if (persisted.storeVersion === 2) strictSequences = true
          let event = persisted
          if (persisted.seq <= previousSeq) {
            if (strictSequences || persistedJSON === previousPersisted || !Number.isSafeInteger(previousSeq + 1)) {
              throw new Error('invalid event envelope or non-increasing sequence')
            }
            event = { ...persisted, seq: previousSeq + 1, storedSeq: persisted.seq }
            if (legacyAdjusted++ === 0) firstLegacyLine = lineNumber
          }
          loaded.push(event)
          previousPersisted = persistedJSON
          previousSeq = event.seq
        } catch (error) {
          let partial = isPartialObject(text, error)
          // A torn multibyte string can fail UTF-8 decoding before JSON parsing.
          if (!partial && error instanceof TypeError) {
            try { JSON.parse(text) } catch (parseError) { partial = isPartialObject(text, parseError) }
          }
          if (newline === -1 && partial) repairOffset = start
          else throw new Error(`corrupt event store ${this.file} at line ${lineNumber}: ${String(error)}`, { cause: error })
        }
      }
      if (newline === -1) break
      start = newline + 1
    }
    if (repairOffset !== undefined) {
      // Preserve the exact rejected bytes before removing ONLY the partial tail.
      // This path runs on normal load; development tests use their own temp files.
      const quarantine = `${this.file}.corrupt-tail-${Date.now()}-${randomUUID()}`
      const quarantined = openSync(quarantine, 'wx', 0o600)
      try {
        writeFileSync(quarantined, raw.subarray(repairOffset))
        fsyncSync(quarantined)
      } finally {
        closeSync(quarantined)
      }
      const descriptor = openSync(this.file, 'r+')
      try {
        ftruncateSync(descriptor, repairOffset)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      const diagnostic = `repaired incomplete event tail in ${this.file}; quarantined ${raw.length - repairOffset} bytes to ${quarantine}`
      this.diagnostics.push(diagnostic)
      console.warn(diagnostic)
    } else {
      this.needsSeparator = raw.length > 0 && raw[raw.length - 1] !== 10
    }
    if (legacyAdjusted > 0) {
      const diagnostic = `replayed ${legacyAdjusted} legacy sequence collisions in ${this.file} from line ${firstLegacyLine} with monotonic cursors; original storedSeq values and source bytes preserved`
      this.diagnostics.push(diagnostic)
      console.warn(diagnostic)
    }
    if (!Number.isSafeInteger(previousSeq + 1)) throw new Error(`event store ${this.file} exhausted its safe sequence range`)
    this.events = loaded
    this.nextSeq = previousSeq + 1
  }

  get seq(): number {
    return this.nextSeq - 1
  }

  all(): readonly SwarmEventRecord[] {
    return this.events
  }

  append(kind: string, fields: Omit<SwarmEventRecord, 'seq' | 'at' | 'kind' | 'storeVersion' | 'storedSeq'> = {}): SwarmEventRecord {
    if (this.failed !== undefined) throw new Error(this.failed)
    // Authoritative envelope fields win even if an untyped caller spoofs them.
    const input = record({ ...fields, storeVersion: 2, seq: this.nextSeq, at: Date.now(), kind }, this.seq)
    const serialized = JSON.stringify(input)
    // Publish the exact JSON snapshot that is persisted, not caller-owned data
    // with undefined/functions/toJSON behavior that will differ during replay.
    const event = record(JSON.parse(serialized), this.seq)
    const line = `${this.needsSeparator ? '\n' : ''}${serialized}\n`
    mkdirSync(dirname(this.file), { recursive: true })
    const descriptor = openSync(this.file, 'a', 0o600)
    let durable = false
    try {
      const previousLength = fstatSync(descriptor).size
      try {
        appendFileSync(descriptor, line, 'utf8')
        fsyncSync(descriptor)
        durable = true
      } catch (error) {
        try {
          // Windows append handles have FILE_APPEND_DATA but not the write
          // permission required for ftruncate. Use a separate r+ handle for
          // rollback; the original append handle remains closed in finally.
          const rollback = openSync(this.file, 'r+')
          try {
            ftruncateSync(rollback, previousLength)
            fsyncSync(rollback)
          } finally {
            closeSync(rollback)
          }
        } catch (rollbackError) {
          this.failed = `event store ${this.file} needs reload after failed append rollback: ${String(rollbackError)}`
        }
        throw new Error(`cannot append event store ${this.file}: ${String(error)}${this.failed !== undefined ? `; ${this.failed}` : ''}`, { cause: error })
      }
    } finally {
      try { closeSync(descriptor) } catch (error) {
        // The bytes may already be durable: never retry this sequence on the
        // same object when a post-commit close leaves publication uncertain.
        if (durable) this.failed = `event store ${this.file} needs reload after failed append close: ${String(error)}`
        throw error
      }
    }
    // Publish only after the append and durability barrier succeeded.
    this.needsSeparator = false
    this.nextSeq += 1
    this.events.push(event)
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) {
        let detail: string
        try { detail = String(error).slice(0, 2048) } catch { detail = 'unprintable observer error' }
        const diagnostic = `event store listener failed at seq ${event.seq}: ${detail}`
        // Bound observer diagnostics even if a broken stream fails repeatedly.
        if (this.diagnostics.length < 100) this.diagnostics.push(diagnostic)
        // A diagnostic sink failure must not retroactively fail a committed event.
        try { console.warn(diagnostic) } catch { /* diagnostic remains observable */ }
      }
    }
    return event
  }

  subscribe(listener: (event: SwarmEventRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
