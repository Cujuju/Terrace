import tseslint from 'typescript-eslint'
import terrace from './tools/eslint-plugin-terrace/index.ts'
import { IGNORED_GLOBS } from './tools/eslint-plugin-terrace/src/targets.ts'

const commentRules = { 'terrace/comment-budget': 'error' }

export default [
  { ignores: IGNORED_GLOBS },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { terrace },
    rules: commentRules,
  },
  {
    files: ['**/*.tsx'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { terrace },
    rules: commentRules,
  },
]
