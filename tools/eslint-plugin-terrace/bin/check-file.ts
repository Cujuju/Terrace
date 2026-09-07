import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { analyze, COMMENT_WORD_CAP } from '../src/analyze.ts'
import { commentsOf } from '../src/comments.ts'
import { budgetFor, fileBudget, RATIO_EPSILON } from '../src/baseline.ts'
import { isLintedFile } from '../src/targets.ts'

/**
 * One file, no eslint startup: the same verdict the rule gives, fast enough to
 * run after every edit. Prints nothing when the file is within budget.
 */
const DECISIONS = 'docs/decisions/<arc>.md'

function report(root: string, path: string): string[] {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const key = relative(root, absolute).split(sep).join('/')
  if (!isLintedFile(key) || key.startsWith('..')) return []

  const source = readFileSync(absolute, 'utf8')
  const { violations, ratio, commentLines, nonBlankLines } = analyze(source, commentsOf(source, key))

  const budget = budgetFor(root)
  const recorded = fileBudget(budget, key)
  const grandfathered = new Set(recorded?.grandfathered ?? [])
  const ceiling = recorded?.ratio ?? budget.newFileRatioCeiling

  const lines: string[] = []
  for (const violation of violations) {
    if (grandfathered.has(violation.fingerprint)) continue
    lines.push(
      violation.kind === 'over-cap'
        ? `${key}:${violation.line} — ${violation.words} words, cap is ${COMMENT_WORD_CAP}.`
        : `${key}:${violation.line} — carries ${violation.label}.`,
    )
  }
  if (ratio > ceiling + RATIO_EPSILON) {
    const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
    lines.push(
      `${key} — comments are ${percent(ratio)} of the file (${commentLines} of ${nonBlankLines} lines); ceiling is ${percent(ceiling)}.`,
    )
  }
  return lines
}

/** A PostToolUse hook hands the edited path on stdin; a shell hands it on argv. */
function pathFromStdin(): string | undefined {
  let raw: string
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return undefined
  }
  if (raw.trim() === '') return undefined
  const payload = JSON.parse(raw) as { tool_input?: { file_path?: string } }
  return payload.tool_input?.file_path
}

const path = process.argv[2] ?? pathFromStdin()
if (path === undefined) process.exit(0)

let lines: string[]
try {
  lines = report(process.cwd(), path)
} catch {
  process.exit(0)
}

if (lines.length > 0) {
  process.stderr.write(
    `Comment budget — put the reasoning in ${DECISIONS}, not in the source:\n${lines.map((line) => `  ${line}`).join('\n')}\n`,
  )
  process.exit(2)
}
