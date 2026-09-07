import { commentBudget } from './src/rules/comment-budget.ts'
import { commentRatio } from './src/rules/comment-ratio.ts'

export const rules = {
  'comment-budget': commentBudget,
  'comment-ratio': commentRatio,
}

export const plugin = { meta: { name: 'eslint-plugin-terrace', version: '0.1.0' }, rules }

export default plugin
