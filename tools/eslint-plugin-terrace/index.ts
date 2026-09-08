import { commentBudget } from './src/rules/comment-budget.ts'

export const rules = { 'comment-budget': commentBudget }

export const plugin = { meta: { name: 'eslint-plugin-terrace', version: '0.1.0' }, rules }

export default plugin
