import { readFileSync } from 'node:fs'
import tseslint from 'typescript-eslint'
import budget from 'eslint-plugin-comment-budget'

const policy = JSON.parse(readFileSync(new URL('.comment-budget.json', import.meta.url), 'utf8'))

const commentRules = { 'budget/comment-budget': 'error' }

export default [
  { ignores: policy.ignore },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { budget },
    rules: commentRules,
  },
  {
    files: ['**/*.tsx'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { budget },
    rules: commentRules,
  },
]
