import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyze } from '../src/analyze.ts'
import type { Budget } from '../src/baseline.ts'
import { commentsOf } from '../src/comments.ts'
import { BUDGET_FILE, findLintedFiles } from '../src/targets.ts'

/**
 * Writes the exemption list: every file that does not yet meet the cap. Rerun
 * after cleaning files and the ones you fixed drop off.
 */
function seed(root: string): Budget {
  const exempt: string[] = []
  for (const path of findLintedFiles(root)) {
    const source = readFileSync(join(root, path), 'utf8')
    if (analyze(source, commentsOf(source, path)).length > 0) exempt.push(path)
  }
  return { exempt }
}

const root = process.cwd()
const budget = seed(root)
writeFileSync(join(root, BUDGET_FILE), `${JSON.stringify(budget, null, 2)}\n`)
process.stdout.write(`${BUDGET_FILE}: ${budget.exempt.length} files exempt\n`)
