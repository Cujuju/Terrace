import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const BUDGET_FILE = '.comment-budget.json'

/** Directories the budget never covers; dot-directories (worktrees, scratch rigs) go too. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', '__pycache__'])

/** eslint `ignores` equivalents of SKIPPED_DIRECTORIES, plus generated declarations. */
export const IGNORED_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/__pycache__/**',
  '**/.*/**',
  '**/*.d.ts',
]

export const LINTED_GLOBS = ['**/*.ts', '**/*.tsx']

function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)
}

export function isLintedFile(name: string): boolean {
  return (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts')
}

/** Repo-relative posix paths of every file the budget covers, in a stable order. */
export function findLintedFiles(root: string): string[] {
  const found: string[] = []

  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(entry.name)) walk(join(directory, entry.name))
      } else if (entry.isFile() && isLintedFile(entry.name)) {
        found.push(relative(root, join(directory, entry.name)).split(sep).join('/'))
      }
    }
  }

  walk(root)
  return found
}
