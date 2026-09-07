import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseForESLint } from '@typescript-eslint/parser'
import { describe, expect, it } from 'vitest'
import type { CommentNode } from '../src/analyze.ts'
import { commentsOf } from '../src/comments.ts'
import { findLintedFiles } from '../src/targets.ts'

/** Parsing the tree twice, once through the ESLint parser, is the slow half. */
const WHOLE_TREE_TIMEOUT_MS = 120_000

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function viaEslint(source: string, path: string): CommentNode[] {
  const { ast } = parseForESLint(source, {
    comment: true,
    loc: true,
    range: true,
    ecmaFeatures: { jsx: path.endsWith('.tsx') },
  })
  return (ast.comments ?? []) as unknown as CommentNode[]
}

const shape = (comments: CommentNode[]): string[] =>
  comments.map((comment) => `${comment.loc.start.line}:${comment.loc.start.column} ${comment.type} ${comment.value}`)

describe('comment extraction agrees with the ESLint parser', () => {
  const tricky: [string, string][] = [
    ['a regex holding slashes', 'export const a = /a\\/\\/b/.test("x") // real\n'],
    ['a string holding a marker', 'export const a = "// not a comment" // real\n'],
    ['a template holding a marker', 'export const a = `/* not */ ${1}` /* real */\n'],
    ['a division that is not a regex', 'export const a = 1 / 2 / 3 // real\n'],
    ['a trailing comment after the last token', 'export const a = 1\n// last\n'],
    ['a comment between decorated members', 'export class A {\n  // one\n  b = 1 // two\n}\n'],
  ]

  for (const [what, source] of tricky) {
    it(`matches on ${what}`, () => {
      expect(shape(commentsOf(source, 'probe.ts'))).toEqual(shape(viaEslint(source, 'probe.ts')))
    })
  }

  it('matches on every file the budget covers', { timeout: WHOLE_TREE_TIMEOUT_MS }, () => {
    const disagreed: string[] = []
    for (const path of findLintedFiles(ROOT)) {
      const source = readFileSync(join(ROOT, path), 'utf8')
      if (shape(commentsOf(source, path)).join('\n') !== shape(viaEslint(source, path)).join('\n')) {
        disagreed.push(path)
      }
    }
    expect(disagreed).toEqual([])
  })
})
