import tseslint from 'typescript-eslint'
import budget, { IGNORED_GLOBS } from 'eslint-plugin-comment-budget'

const commentRules = { 'budget/comment-budget': 'error' }

export default [
  { ignores: IGNORED_GLOBS },
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
