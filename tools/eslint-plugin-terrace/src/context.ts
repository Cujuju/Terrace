import { relative, sep } from 'node:path'
import type { Rule } from 'eslint'
import { analyze, type CommentNode, type FileAnalysis } from './analyze.ts'
import { budgetFor, EMPTY_BUDGET, type Budget } from './baseline.ts'

/** Tests inject a budget; a real run reads `.comment-budget.json` beside the config. */
export type RuleOptions = { budget?: Budget }

export const OPTIONS_SCHEMA = [
  {
    type: 'object',
    properties: { budget: { type: 'object' } },
    additionalProperties: false,
  },
]

export function budgetOf(context: Rule.RuleContext): Budget {
  const injected = (context.options[0] as RuleOptions | undefined)?.budget
  if (injected !== undefined) return injected
  return context.cwd === undefined ? EMPTY_BUDGET : budgetFor(context.cwd)
}

export function relativePathOf(context: Rule.RuleContext): string {
  return relative(context.cwd ?? '', context.filename).split(sep).join('/')
}

export function analyzeFile(context: Rule.RuleContext): FileAnalysis {
  const source = context.sourceCode
  return analyze(source.getText(), source.getAllComments() as unknown as CommentNode[])
}
