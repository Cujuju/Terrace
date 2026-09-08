import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { findBudgetFile } from '../src/baseline.ts'
import { commentBudget } from '../src/rules/comment-budget.ts'

const tester = new RuleTester({ languageOptions: { parser } })

const LONG = `// ${Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ')}`
const DATED = '// Fixed at 1 until 2026-08-21, when the cell stopped being a world unit.'
const CODE = 'export const a = 1'

const budget = (exempt: string[]) => ({ budget: { exempt }, root: '/repo' })

describe('comment-budget', () => {
  it('reports an over-cap block and a banned pattern', () => {
    tester.run('comment-budget', commentBudget, {
      valid: [{ code: `// short and true\n${CODE}\n`, filename: '/repo/src/a.ts', options: [budget([])] }],
      invalid: [
        {
          code: `${LONG}\n${CODE}\n`,
          filename: '/repo/src/a.ts',
          options: [budget([])],
          errors: [{ messageId: 'overCap' }],
        },
        {
          code: `${DATED}\n${CODE}\n`,
          filename: '/repo/src/a.ts',
          options: [budget([])],
          errors: [{ messageId: 'banned' }],
        },
      ],
    })
  })

  it('says nothing about a file on the exemption list', () => {
    tester.run('comment-budget', commentBudget, {
      valid: [
        { code: `${LONG}\n${DATED}\n${CODE}\n`, filename: '/repo/src/legacy.ts', options: [budget(['src/legacy.ts'])] },
      ],
      invalid: [],
    })
  })

  it('exempts by exact path, not by name', () => {
    tester.run('comment-budget', commentBudget, {
      valid: [],
      invalid: [
        {
          code: `${LONG}\n${CODE}\n`,
          filename: '/repo/other/legacy.ts',
          options: [budget(['src/legacy.ts'])],
          errors: [{ messageId: 'overCap' }],
        },
      ],
    })
  })

  it('reports every violation in a touched file, not just the first', () => {
    tester.run('comment-budget', commentBudget, {
      valid: [],
      invalid: [
        {
          code: `${LONG}\n${CODE}\n\n${DATED}\n${CODE}\n`,
          filename: '/repo/src/a.ts',
          options: [budget([])],
          errors: [{ messageId: 'overCap' }, { messageId: 'banned' }],
        },
      ],
    })
  })
})

describe('budget discovery', () => {
  it('walks up to the repo root from a nested directory', () => {
    const found = findBudgetFile(new URL('../src/rules', import.meta.url).pathname)
    expect(found?.endsWith('/.comment-budget.json')).toBe(true)
  })

  it('returns nothing above any repo', () => {
    expect(findBudgetFile('/')).toBeUndefined()
  })
})
