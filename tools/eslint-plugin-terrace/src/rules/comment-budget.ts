import type { Rule } from 'eslint'
import { COMMENT_WORD_CAP } from '../analyze.ts'
import { fileBudget } from '../baseline.ts'
import { analyzeFile, budgetOf, OPTIONS_SCHEMA, relativePathOf } from '../context.ts'

const DECISIONS = 'docs/decisions/<arc>.md'

export const commentBudget: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Cap a comment block at 30 words and keep decision-record prose out of the source.',
    },
    schema: OPTIONS_SCHEMA,
    messages: {
      overCap: `Comment block is {{words}} words; the cap is ${COMMENT_WORD_CAP}. Cut it, or move the reasoning to ${DECISIONS}.`,
      banned: `Comment carries {{label}}, which belongs in ${DECISIONS}, not beside the code.`,
    },
  },

  create(context) {
    return {
      'Program:exit'(): void {
        const grandfathered = new Set(fileBudget(budgetOf(context), relativePathOf(context))?.grandfathered ?? [])

        for (const violation of analyzeFile(context).violations) {
          if (grandfathered.has(violation.fingerprint)) continue
          const loc = {
            start: { line: violation.line, column: violation.column },
            end: { line: violation.endLine, column: violation.endColumn },
          }
          if (violation.kind === 'over-cap') {
            context.report({ loc, messageId: 'overCap', data: { words: String(violation.words) } })
          } else {
            context.report({ loc, messageId: 'banned', data: { label: violation.label } })
          }
        }
      },
    }
  },
}
