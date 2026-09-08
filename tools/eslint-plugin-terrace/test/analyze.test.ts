import { describe, expect, it } from 'vitest'
import { parseForESLint } from '@typescript-eslint/parser'
import { analyze, COMMENT_WORD_CAP, type CommentNode, type Violation } from '../src/analyze.ts'

function run(source: string): Violation[] {
  const { ast } = parseForESLint(source, { comment: true, loc: true, range: true })
  return analyze(source, (ast.comments ?? []) as unknown as CommentNode[])
}

function kinds(source: string): string[] {
  return run(source).map((violation) => violation.kind)
}

const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index}`).join(' ')

describe('word cap', () => {
  it('passes a block exactly at the cap', () => {
    expect(kinds(`// ${words(COMMENT_WORD_CAP)}\nexport const a = 1\n`)).toEqual([])
  })

  it('fails a block one word over the cap', () => {
    expect(kinds(`// ${words(COMMENT_WORD_CAP + 1)}\nexport const a = 1\n`)).toEqual(['over-cap'])
  })

  it('reports the word count it counted', () => {
    const [violation] = run(`// ${words(40)}\nexport const a = 1\n`)
    expect(violation?.words).toBe(40)
  })

  it('joins comments on consecutive lines into one block', () => {
    const source = `// ${words(20)}\n// ${words(20)}\nexport const a = 1\n`
    expect(kinds(source)).toEqual(['over-cap'])
  })

  it('splits blocks separated by a blank line', () => {
    const source = `// ${words(20)}\n\n// ${words(20)}\nexport const a = 1\n`
    expect(kinds(source)).toEqual([])
  })

  it('splits blocks separated by code', () => {
    const source = `// ${words(20)}\nexport const a = 1\n// ${words(20)}\nexport const b = 2\n`
    expect(kinds(source)).toEqual([])
  })

  it('keeps a trailing comment out of the block above it', () => {
    const source = `// ${words(20)}\nexport const a = 1 // ${words(20)}\n`
    expect(kinds(source)).toEqual([])
  })

  it('counts a JSDoc block without its gutter asterisks', () => {
    const source = `/**\n * ${words(15)}\n * ${words(14)}\n */\nexport const a = 1\n`
    expect(run(source)).toEqual([])
  })

  it('ignores comment-shaped text inside a string', () => {
    expect(kinds(`export const a = '// ${words(40)}'\n`)).toEqual([])
  })
})

describe('banned decision-record prose', () => {
  const cases: [string, string][] = [
    ['iso-date', '// Fixed at 1 until 2026-08-21, when the cell stopped being a world unit.'],
    ['owner', '// The sea reads flat here (owner, 2026-08-26: "no difference at all").'],
    ['history', '// The drag used to be a chain of per-cell intents, one per cell crossed.'],
    ['history', '// Rejected: a linear step-down needs a step size nothing else fixes.'],
    ['measurement', '// SIXTY-FOUR, measured rather than assumed, on a live world.'],
    ['was-now', '// The first press was 67 mana and is now 14, after pricing the core.'],
    ['digit-row', '// 400 300 225 169 127'],
  ]

  for (const [id, comment] of cases) {
    it(`flags ${id}`, () => {
      expect(kinds(`${comment}\nexport const a = 1\n`)).toContain(`banned:${id}`)
    })
  }

  const allowed: [string, string][] = [
    ['an owner field', '// One loop per (owner, url), faded to a weight rather than positioned.'],
    ['used in order to', '// The raycaster is only used to unproject the pointer into world space.'],
    ['a rejected input', '// How far past its footprint a model may reach before it is rejected.'],
    ['measuring as a verb', '// Live one-shot count, which the voice cap is measured against.'],
    ['a quoted term', '// The whole "already playing" test, here rather than in the caller.'],
  ]

  for (const [what, comment] of allowed) {
    it(`allows ${what}`, () => {
      expect(kinds(`${comment}\nexport const a = 1\n`)).toEqual([])
    })
  }
})


