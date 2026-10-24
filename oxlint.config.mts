import { readFileSync } from 'node:fs'
import { defineConfig } from 'oxlint'

const policy = JSON.parse(readFileSync(new URL('.comment-budget.json', import.meta.url), 'utf8')) as { ignore: string[] }

// Only the rules below run; default categories are off so an oxlint release cannot add rules.
export default defineConfig({
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'budget', specifier: 'eslint-plugin-comment-budget' }],
  ignorePatterns: policy.ignore,
  overrides: [
    { files: ['**/*.ts', '**/*.tsx'], rules: { 'budget/comment-budget': 'error' } },
    {
      // Solid correctness (same rule set as MoManga): eslint-plugin-solid runs inside oxlint; ESLint is only its runtime library.
      files: ['client/src/**/*.{ts,tsx}', 'plugins/*/client/**/*.{ts,tsx}'],
      jsPlugins: ['eslint-plugin-solid'],
      rules: {
        'solid/jsx-no-duplicate-props': 'error',
        'solid/jsx-no-undef': ['error', { typescriptEnabled: true }],
        'solid/jsx-uses-vars': 'error',
        'solid/no-innerhtml': 'error',
        'solid/jsx-no-script-url': 'error',
        'solid/components-return-once': 'warn',
        'solid/no-destructure': 'error',
        'solid/prefer-for': 'error',
        'solid/reactivity': 'warn',
        'solid/event-handlers': 'warn',
        'solid/imports': 'warn',
        'solid/style-prop': 'warn',
        'solid/no-react-deps': 'warn',
        'solid/no-react-specific-props': 'warn',
        'solid/self-closing-comp': 'warn',
      },
    },
  ],
})
