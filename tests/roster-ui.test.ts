import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import type { Board, BoardRole } from '../client/board-store.js'
import { DutyTableEditor, roleDisplayLabel } from '../client/DutyTableEditor.js'
import { EN_DICT, ZH_DICT, initLocale, type Translate } from '../client/locale.js'

/** The Chinese role names the operator asked for. */
const ZH_ROLE_NAMES = { architect: '架构设计', builder: '干活出工', reviewer: '测试复查', integrator: '整合收拢' } as const
const BUILTIN_ROLES = ['architect', 'builder', 'reviewer', 'integrator'] as const

const zhTranslate: Translate = (key, vars) => {
  let text = ZH_DICT[key] ?? EN_DICT[key] ?? key
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
  }
  return text
}

function role(id: string, label: string): BoardRole {
  return { id, label, description: `${label} description`, fallbacks: [] }
}

function board(roles: BoardRole[]): Board {
  return { service: 'swarm', version: '0.6.33', seq: 1, at: 2, roles: Object.fromEntries(roles.map((entry) => [entry.id, entry])), runs: [], tasks: [] }
}

describe('roster role names follow the interface language', () => {
  it('ships a translated name for every built-in role in both languages', () => {
    for (const id of BUILTIN_ROLES) {
      expect(EN_DICT[`roster.role.${id}`], id).toBeDefined()
      expect(EN_DICT[`roster.role.${id}`], id).not.toBe('')
      expect(ZH_DICT[`roster.role.${id}`], id).toBe(ZH_ROLE_NAMES[id])
    }
    expect(Object.keys(EN_DICT).sort()).toEqual(Object.keys(ZH_DICT).sort())
  })

  it('localizes a shipped label but never overwrites a customized one', () => {
    expect(roleDisplayLabel(role('architect', 'Architect'), zhTranslate)).toBe('架构设计')
    expect(roleDisplayLabel(role('builder', ''), zhTranslate)).toBe('干活出工')
    expect(roleDisplayLabel(role('reviewer', '首席评审'), zhTranslate)).toBe('首席评审')
    expect(roleDisplayLabel(role('doc-writer', 'Doc writer'), zhTranslate)).toBe('Doc writer')
  })

  it('renders the localized header without rewriting the editable label', () => {
    initLocale({ register: () => () => { }, bind: () => (key: string) => ZH_DICT[key] ?? EN_DICT[key] ?? key })
    const markup = renderToStaticMarkup(createElement(DutyTableEditor, {
      board: board(BUILTIN_ROLES.map((id) => role(id, EN_DICT[`roster.role.${id}`] ?? id))),
      onSaved: () => { },
    }))
    for (const id of BUILTIN_ROLES) {
      expect(markup, id).toContain(ZH_ROLE_NAMES[id])
      expect(markup, id).toContain(`<kbd>${id}</kbd>`)
    }
    // The label input under 人设与描述 still shows the stored configuration value,
    // so saving the roster cannot silently rewrite the shipped English label.
    expect(markup).toContain('value="Architect"')
  })
})

describe('runtime tuning aligns with the role cards', () => {
  it('gives the runtime section the same inline padding as the roster', () => {
    const css = readFileSync(new URL('../client/swarm.css', import.meta.url), 'utf8')
    const roster = /\.dsh-swarm-roster \{[^}]*\}/.exec(css)?.[0] ?? ''
    const runtime = /\.dsh-swarm-runtime \{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(roster).toContain('padding: 14px 16px')
    // 16px inline padding = the left border of the role cards in the grid above.
    expect(runtime).toContain('padding: 12px 16px 4px')
  })
})
