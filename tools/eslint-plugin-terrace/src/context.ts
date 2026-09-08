import { dirname, relative, sep } from 'node:path'
import type { Rule } from 'eslint'
import { analyze, type CommentNode, type Violation } from './analyze.ts'
import { budgetFor, type Budget } from './baseline.ts'

/** Tests inject a budget and a root; a real run walks up for `.comment-budget.json`. */
export type RuleOptions = { budget?: Budget; root?: string }

export const OPTIONS_SCHEMA = [
  {
    type: 'object',
    properties: { budget: { type: 'object' }, root: { type: 'string' } },
    additionalProperties: false,
  },
]

export function isExempt(context: Rule.RuleContext): boolean {
  const options = (context.options[0] as RuleOptions | undefined) ?? {}
  const found = budgetFor(dirname(context.filename))
  const budget = options.budget ?? found.budget
  const root = options.root ?? found.root
  return budget.exempt.includes(relative(root, context.filename).split(sep).join('/'))
}

export function violationsOf(context: Rule.RuleContext): Violation[] {
  const source = context.sourceCode
  return analyze(source.getText(), source.getAllComments() as unknown as CommentNode[])
}
