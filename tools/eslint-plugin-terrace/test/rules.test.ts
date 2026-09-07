import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import { describe, expect, it } from 'vitest'
import { parseForESLint } from '@typescript-eslint/parser'
import { analyze, type CommentNode } from '../src/analyze.ts'
import type { Budget } from '../src/baseline.ts'
import { commentBudget } from '../src/rules/comment-budget.ts'
import { commentRatio } from '../src/rules/comment-ratio.ts'

const tester = new RuleTester({ languageOptions: { parser } })

const LONG = `// ${Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ')}`
const DATED = '// Fixed at 1 until 2026-08-21, when the cell stopped being a world unit.'
const CODE = 'export const a = 1'

function fingerprintOf(source: string): string {
  const { ast } = parseForESLint(source, { comment: true, loc: true, range: true })
  return analyze(source, (ast.comments ?? []) as unknown as CommentNode[]).violations[0]!.fingerprint
}

function budget(files: Budget['files'], newFileRatioCeiling = 1): Budget {
  return { newFileRatioCeiling, files }
}

describe('comment-budget', () => {
  it('reports an over-cap block and a banned pattern, and honours the grandfather list', () => {
    const dated = `${DATED}\n${CODE}\n`
    tester.run('comment-budget', commentBudget, {
      valid: [
        { code: `// short and true\n${CODE}\n`, options: [{ budget: budget({}) }] },
        {
          code: dated,
          filename: 'legacy.ts',
          options: [{ budget: budget({ 'legacy.ts': { ratio: 1, grandfathered: [fingerprintOf(dated)] } }) }],
        },
      ],
      invalid: [
        { code: `${LONG}\n${CODE}\n`, options: [{ budget: budget({}) }], errors: [{ messageId: 'overCap' }] },
        { code: dated, options: [{ budget: budget({}) }], errors: [{ messageId: 'banned' }] },
        {
          code: dated,
          filename: 'legacy.ts',
          options: [{ budget: budget({ 'legacy.ts': { ratio: 1, grandfathered: ['0000deadbeef'] } }) }],
          errors: [{ messageId: 'banned' }],
        },
      ],
    })
  })

  it('grandfathers a violation that moved to another line', () => {
    const dated = `${DATED}\n${CODE}\n`
    tester.run('comment-budget', commentBudget, {
      valid: [
        {
          code: `${CODE}\n\n${DATED}\n${CODE}\n`,
          filename: 'legacy.ts',
          options: [{ budget: budget({ 'legacy.ts': { ratio: 1, grandfathered: [fingerprintOf(dated)] } }) }],
        },
      ],
      invalid: [],
    })
  })
})

describe('comment-ratio', () => {
  const dense = `// one\n// two\n// three\n${CODE}\n`

  it('holds a recorded file at its own ceiling', () => {
    tester.run('comment-ratio', commentRatio, {
      valid: [{ code: dense, filename: 'dense.ts', options: [{ budget: budget({ 'dense.ts': { ratio: 0.75, grandfathered: [] } }) }] }],
      invalid: [
        {
          code: dense,
          filename: 'dense.ts',
          options: [{ budget: budget({ 'dense.ts': { ratio: 0.5, grandfathered: [] } }) }],
          errors: [{ messageId: 'overCeiling' }],
        },
      ],
    })
  })

  it('holds an unrecorded file at the new-file ceiling', () => {
    tester.run('comment-ratio', commentRatio, {
      valid: [{ code: dense, filename: 'new.ts', options: [{ budget: budget({}, 0.75) }] }],
      invalid: [
        {
          code: dense,
          filename: 'new.ts',
          options: [{ budget: budget({}, 0.2) }],
          errors: [{ messageId: 'overNewFileCeiling' }],
        },
      ],
    })
  })

  it('does not fire on a file with no comments', () => {
    tester.run('comment-ratio', commentRatio, {
      valid: [{ code: `${CODE}\n`, filename: 'bare.ts', options: [{ budget: budget({}, 0) }] }],
      invalid: [],
    })
  })
})

describe('plugin surface', () => {
  it('exposes both rules with schemas that reject unknown options', () => {
    for (const rule of [commentBudget, commentRatio]) {
      expect(rule.meta?.schema).toEqual([
        { type: 'object', properties: { budget: { type: 'object' } }, additionalProperties: false },
      ])
    }
  })
})
