import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BUDGET_FILE } from './targets.ts'

export type FileBudget = {
  /** Comment-only lines over non-blank lines, as of the last seed. May never rise. */
  ratio: number
  /** Violations that predate the rule; editing the comment drops its fingerprint. */
  grandfathered: string[]
}

export type Budget = {
  /**
   * The repo's own aggregate comment ratio at seed time. A file the budget has
   * never seen may not be denser than the codebase already is.
   */
  newFileRatioCeiling: number
  files: Record<string, FileBudget>
}

/** Float compare slack, wider than the four decimals the budget file stores. */
export const RATIO_EPSILON = 1e-4

export const EMPTY_BUDGET: Budget = { newFileRatioCeiling: 0, files: {} }

type CacheEntry = { mtimeMs: number; budget: Budget }
const cache = new Map<string, CacheEntry>()

export function budgetFor(root: string): Budget {
  const path = join(root, BUDGET_FILE)
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return EMPTY_BUDGET
  }
  const cached = cache.get(path)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.budget

  const budget = JSON.parse(readFileSync(path, 'utf8')) as Budget
  cache.set(path, { mtimeMs, budget })
  return budget
}

export function fileBudget(budget: Budget, relativePath: string): FileBudget | undefined {
  return budget.files[relativePath]
}
