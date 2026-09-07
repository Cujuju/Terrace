import type { Rule } from 'eslint'
import { fileBudget, RATIO_EPSILON } from '../baseline.ts'
import { analyzeFile, budgetOf, OPTIONS_SCHEMA, relativePathOf } from '../context.ts'

function asPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

/**
 * The ratchet. The word cap alone is gamed by splitting one long block into
 * several short ones, so a file's comment density may never rise either.
 */
export const commentRatio: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: "Hold a file's comment density at or below its recorded ceiling.",
    },
    schema: OPTIONS_SCHEMA,
    messages: {
      overCeiling:
        'Comments are {{ratio}} of this file ({{commentLines}} of {{nonBlankLines}} lines); its ceiling is {{ceiling}}. Cut a comment before adding one.',
      overNewFileCeiling:
        'Comments are {{ratio}} of this new file ({{commentLines}} of {{nonBlankLines}} lines); the ceiling for a file the budget has not seen is {{ceiling}}.',
    },
  },

  create(context) {
    return {
      'Program:exit'(node): void {
        const budget = budgetOf(context)
        const recorded = fileBudget(budget, relativePathOf(context))
        const ceiling = recorded?.ratio ?? budget.newFileRatioCeiling
        const { ratio, commentLines, nonBlankLines } = analyzeFile(context)
        if (ratio <= ceiling + RATIO_EPSILON) return

        context.report({
          node,
          messageId: recorded === undefined ? 'overNewFileCeiling' : 'overCeiling',
          data: {
            ratio: asPercent(ratio),
            ceiling: asPercent(ceiling),
            commentLines: String(commentLines),
            nonBlankLines: String(nonBlankLines),
          },
        })
      },
    }
  },
}
