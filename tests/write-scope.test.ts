// The task detail panel showed "Write scope: [object Object]" in production (operator's
// screenshot, after the 0.6.25 fix shipped a naive inline version). The renderer now
// lives in client/write-scope.ts as a pure function so the shipped behaviour is pinned
// by tests instead of by inspection.
import { describe, expect, it } from 'vitest'
import { formatWriteScope } from '../client/write-scope.js'

describe('write-scope formatting (task detail panel)', () => {
  it('passes an array of strings through unchanged', () => {
    expect(formatWriteScope(['a.ts', 'b/c.ts'])).toEqual(['a.ts', 'b/c.ts'])
  })

  it('resolves an object entry through path/glob/pattern/scope/file, never "[object Object]"', () => {
    expect(
      formatWriteScope([
        { path: 'src/a.ts' },
        { glob: 'src/**/*.ts' },
        { pattern: 'p' },
        { scope: 's' },
        { file: 'f' },
      ]),
    ).toEqual(['src/a.ts', 'src/**/*.ts', 'p', 's', 'f'])
  })

  it('prefers path over the later keys when several are present', () => {
    expect(formatWriteScope([{ glob: 'g', path: 'p' }])).toEqual(['p'])
  })

  it('handles a mixed array', () => {
    expect(formatWriteScope(['plain.ts', { path: 'obj.ts' }, 7])).toEqual(['plain.ts', 'obj.ts', '7'])
  })

  it('accepts a bare string', () => {
    expect(formatWriteScope('solo.ts')).toEqual(['solo.ts'])
  })

  it('returns an empty list for undefined and null', () => {
    expect(formatWriteScope(undefined)).toEqual([])
    expect(formatWriteScope(null)).toEqual([])
  })

  it('does not throw on a non-array, which previously threw', () => {
    expect(formatWriteScope({ path: 'single.ts' })).toEqual(['single.ts'])
    expect(formatWriteScope(42)).toEqual(['42'])
    expect(formatWriteScope(true)).toEqual(['true'])
  })

  it('falls back to JSON for a nested object, and to a marker for a circular one', () => {
    expect(formatWriteScope([{ nested: { deep: 1 } }])).toEqual(['{"nested":{"deep":1}}'])
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(formatWriteScope([circular])).toEqual(['[unprintable write scope]'])
  })

  it('skips empty entries rather than rendering blank code chips', () => {
    expect(formatWriteScope(['', { path: '' }, null, undefined])).toEqual([])
  })

  it('never produces "[object Object]" for any supported shape', () => {
    const cases: unknown[] = [
      [{ path: 'p' }], [{ glob: 'g' }], [{}], [{ a: 1 }], [{ nested: { d: 1 } }],
      { path: 'q' }, { glob: 'r' }, {}, 42, true, 0, false, undefined, null,
    ]
    for (const input of cases) {
      for (const label of formatWriteScope(input)) {
        expect(label).not.toContain('[object Object]')
      }
    }
  })

  // Fail-before evidence. The pre-fix inline renderer in SwarmTab.tsx was, in effect,
  // `writes.map((f) => String(f))` — it printed exactly this for an object entry and
  // threw on a non-array. This test pins that the old behaviour really did fail the
  // expectations above, so the extraction is not a no-op refactor.
  describe('the pre-fix inline renderer failed these expectations', () => {
    const naive = (writes: unknown): string[] => (writes as unknown[]).map((f) => String(f))

    it('produced "[object Object]" for an object entry', () => {
      expect(naive([{ path: 'p' }])).toEqual(['[object Object]'])
      expect(naive([{ path: 'p' }])).not.toEqual(formatWriteScope([{ path: 'p' }]))
    })

    it('threw on a non-array payload', () => {
      expect(() => naive({ path: 'p' })).toThrow()
    })
  })
})
