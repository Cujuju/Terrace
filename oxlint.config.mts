import { readFileSync } from 'node:fs'
import { defineConfig } from 'oxlint'

const policy = JSON.parse(readFileSync(new URL('.comment-budget.json', import.meta.url), 'utf8')) as { ignore: string[] }

// Only the comment budget runs; default categories are off so an oxlint release cannot add rules.
export default defineConfig({
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'budget', specifier: 'eslint-plugin-comment-budget' }],
  ignorePatterns: policy.ignore,
  overrides: [{ files: ['**/*.ts', '**/*.tsx'], rules: { 'budget/comment-budget': 'error' } }],
})
