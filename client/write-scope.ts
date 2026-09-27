// Pure, DOM-free formatting for a task's declared write scope, so the detail panel's
// behaviour can be unit-tested (the client has no DOM harness — same reason
// client/badge.ts is pure).
//
// Why this exists: the roster carries strings, but a config-authored scope can be an
// object (e.g. {path, glob}). Rendering it naively printed "[object Object]" in the
// task detail panel (observed live in the operator's screenshot), and a non-array
// payload threw outright. Both are display bugs, so they are pinned by tests here.

const KEY_ORDER = ['path', 'glob', 'pattern', 'scope', 'file'] as const

/** One entry → a readable label. Never throws; never yields "[object Object]". */
function labelOf(entry: unknown): string {
  if (typeof entry === 'string') return entry
  if (entry === null || entry === undefined) return ''
  if (typeof entry !== 'object') return String(entry)
  const record = entry as Record<string, unknown>
  let sawKnownKey = false
  for (const key of KEY_ORDER) {
    const value = record[key]
    if (value === undefined) continue
    sawKnownKey = true
    if (typeof value === 'string' && value.length > 0) return value
  }
  // A known-keyed entry whose values are all empty (e.g. {path: ''}) has nothing worth
  // showing — dumping its JSON would be noise. An entry with no known key at all still
  // falls through, because its shape is the only useful thing to display.
  if (sawKnownKey) return ''
  try {
    const json = JSON.stringify(entry)
    return typeof json === 'string' && json.length > 0 ? json : '[unprintable write scope]'
  } catch {
    // A circular structure or a throwing toJSON: show a marker rather than break
    // the panel. Never a bare "[object Object]".
    return '[unprintable write scope]'
  }
}

/**
 * Format a declared write scope for display. Always returns an array of non-empty
 * strings. A non-array input is treated as a single entry, so a malformed payload
 * cannot throw; an unprintable entry degrades to a marker instead of "[object Object]".
 */
export function formatWriteScope(writes: unknown): string[] {
  const entries = Array.isArray(writes)
    ? writes
    : writes === undefined || writes === null
      ? []
      : [writes]
  const out: string[] = []
  for (const entry of entries) {
    const label = labelOf(entry)
    if (label.length > 0) out.push(label)
  }
  return out
}
