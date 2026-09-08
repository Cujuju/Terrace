import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { BUDGET_FILE } from './targets.ts'

export type Budget = {
  /**
   * Files that predate the rule, repo-relative. A whole-tree run skips them;
   * touching one does not. Cleaning a file means deleting its line here.
   */
  exempt: string[]
}

export const EMPTY_BUDGET: Budget = { exempt: [] }

type CacheEntry = { mtimeMs: number; budget: Budget }
const cache = new Map<string, CacheEntry>()

/** The budget sits at the repo root; a linter may be pointed anywhere below it. */
export function findBudgetFile(from: string): string | undefined {
  let directory = from
  for (;;) {
    const candidate = join(directory, BUDGET_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory || directory === parse(directory).root) return undefined
    directory = parent
  }
}

export function budgetAt(path: string): Budget {
  const mtimeMs = statSync(path).mtimeMs
  const cached = cache.get(path)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.budget

  const budget = JSON.parse(readFileSync(path, 'utf8')) as Budget
  cache.set(path, { mtimeMs, budget })
  return budget
}

export function budgetFor(from: string): { budget: Budget; root: string } {
  const path = findBudgetFile(from)
  if (path === undefined) return { budget: EMPTY_BUDGET, root: from }
  return { budget: budgetAt(path), root: dirname(path) }
}
