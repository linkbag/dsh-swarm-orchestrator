// The Swarm UI follows the DSH language preference through the client locale
// service. These tests pin the dictionary contract (en/zh parity — a missing
// key renders as a raw 'tab.board'-style key in one language and not the other,
// the ugliest possible failure), the interpolation, and the active-locale
// switching behavior of `t`.
import { describe, expect, it } from 'vitest'
import { EN_DICT, initLocale, statusT, t, ZH_DICT } from '../client/locale.js'

describe('swarm locale', () => {
  it('en and zh dictionaries carry identical key sets', () => {
    expect(Object.keys(ZH_DICT).sort()).toEqual(Object.keys(EN_DICT).sort())
  })

  it('zh values are non-empty and actually translated', () => {
    for (const [key, value] of Object.entries(ZH_DICT)) {
      expect(value.length, `empty zh value for ${key}`).toBeGreaterThan(0)
    }
    // Spot-check that surface strings really are Chinese, not English copies.
    expect(ZH_DICT['tab.board']).toMatch(/[\u4e00-\u9fff]/)
    expect(ZH_DICT['roster.save']).toMatch(/[\u4e00-\u9fff]/)
    expect(ZH_DICT['badge.last']).toMatch(/[\u4e00-\u9fff]/)
  })

  it('interpolates {var} slots', () => {
    expect(t('time.minutes', { n: 5 })).toBe('5m ago')
    expect(t('roster.catalogLive', { providers: 2, models: 7 })).toBe('2 provider(s) / 7 model(s) live')
  })

  it('translates known statuses and passes unknown ones through', () => {
    expect(statusT('completed')).toBe('completed')
    expect(statusT('mystery-state')).toBe('mystery-state')
  })

  it('falls back to the English dictionary when no locale service is bound', () => {
    expect(t('tab.board')).toBe('Board')
    expect(t('key.that.does.not.exist')).toBe('key.that.does.not.exist')
  })

  it("t() reads the active locale at call time — switching to 中文 re-translates", () => {
    let active: 'en' | 'zh' = 'zh'
    const dicts: Record<string, Record<string, string>> = {}
    const fake = {
      register(ns: string, tag: string, dict: Record<string, string>): () => void {
        dicts[`${ns}/${tag}`] = dict
        return () => {}
      },
      bind(ns: string): (key: string) => string {
        return (key: string) => dicts[`${ns}/${active}`]?.[key] ?? key
      },
    }
    initLocale(fake as never)

    // zh active: the picker labels come out Chinese.
    expect(t('tab.board')).toBe('看板')
    expect(t('run.endorse')).toBe('✓ 放行并启动')
    // Switch to English (Settings → Language): same bound function, new locale.
    active = 'en'
    expect(t('tab.board')).toBe('Board')
  })

  // Restore the module's unbound state for any test that runs after this file.
  it('resets to English after the locale-service test', () => {
    initLocale({
      register: () => () => {},
      bind: () => (key: string) => key,
    })
    expect(t('tab.board')).toBe('Board')
  })
})
