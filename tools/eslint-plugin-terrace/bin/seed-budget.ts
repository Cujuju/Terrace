import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyze } from '../src/analyze.ts'
import type { Budget, FileBudget } from '../src/baseline.ts'
import { commentsOf } from '../src/comments.ts'
import { BUDGET_FILE, findLintedFiles } from '../src/targets.ts'

/** Enough precision that a one-line change to a 2000-line file still registers. */
const RATIO_DECIMALS = 4

/** A new file answers to a file cut by hand, not to a tree that is half comments. */
const CEILING_EXEMPLAR = 'shared/src/heightmap.ts'

function round(ratio: number): number {
  return Number(ratio.toFixed(RATIO_DECIMALS))
}

function seed(root: string): Budget {
  const files: Record<string, FileBudget> = {}
  let exemplarRatio: number | undefined

  for (const path of findLintedFiles(root)) {
    const source = readFileSync(join(root, path), 'utf8')
    const { violations, ratio } = analyze(source, commentsOf(source, path))
    if (path === CEILING_EXEMPLAR) exemplarRatio = ratio
    if (violations.length === 0 && ratio === 0) continue
    files[path] = {
      ratio: round(ratio),
      grandfathered: [...new Set(violations.map((violation) => violation.fingerprint))].sort(),
    }
  }

  if (exemplarRatio === undefined) throw new Error(`ceiling exemplar ${CEILING_EXEMPLAR} is missing`)
  return { newFileRatioCeiling: round(exemplarRatio), files }
}

const root = process.cwd()
const budget = seed(root)
writeFileSync(join(root, BUDGET_FILE), `${JSON.stringify(budget, null, 2)}\n`)

const grandfathered = Object.values(budget.files).reduce((sum, file) => sum + file.grandfathered.length, 0)
process.stdout.write(
  `${BUDGET_FILE}: ${Object.keys(budget.files).length} files, ${grandfathered} grandfathered violations, ` +
    `new-file ceiling ${(budget.newFileRatioCeiling * 100).toFixed(1)}%\n`,
)
