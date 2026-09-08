/** Word cap for one comment block, from code_style.md. */
export const COMMENT_WORD_CAP = 30

export type ViolationKind = 'over-cap' | `banned:${string}`

export type Violation = {
  kind: ViolationKind
  line: number
  column: number
  endLine: number
  endColumn: number
  /** Words in the block; only meaningful for 'over-cap'. */
  words: number
  /** Human label of the banned pattern; empty for 'over-cap'. */
  label: string
}

type Loc = { line: number; column: number }

export type CommentNode = {
  type: 'Line' | 'Block'
  value: string
  loc: { start: Loc; end: Loc }
}

type BannedPattern = { id: string; label: string; test: (text: string) => boolean }

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/
const WAS_NOW = /\bwas\b[^.;]{0,40}?\b\d[\d.,%]*\b[^.;]{0,20}?\bnow\b/i

/**
 * Attribution, not the word: an audio source has an `owner` and a module has
 * one owner. A decision is dated or quoted.
 */
const OWNER_ATTRIBUTION =
  /\bowner\s*[,:]\s*(?:\d{4}-\d{2}-\d{2}|")|\bthe owner\s+(?:said|asked|wants|wanted|called|decided|rejected|read)\b/i

/** "used to" as history, not as "used in order to"; a rejection, not a rejected input. */
const HISTORY =
  /\b(?:it|this|that|these|they|we|which|who|but|and|;)\s+used\s+to\b|\bused to be\b|\bsuperseded\b|\brejected\s*:|\bwas rejected\b|\brejected in favou?r\b|\bwe rejected\b/i

/** A figure offered as evidence, not the verb: this code measures things for a living. */
const MEASUREMENT = /\bmeasured\s+(?:rather than|on|over|in a live|live)\b|\bMEASURED\s*[:,]/

/** A row of figures: three or more numbers with at most one word among them. */
function isDigitRow(line: string): boolean {
  const stripped = line.replace(/^[\s*/|+-]+/, '').trim()
  if (stripped === '') return false
  const numbers = stripped.match(/\b\d[\d.,%]*\b/g)
  if (numbers === null || numbers.length < 3) return false
  const words = stripped.match(/[A-Za-z]{2,}/g)
  return words === null || words.length <= 1
}

/**
 * Prose that belongs in a decision record, not beside the code: dates, who
 * decided, the shape before this one, and the figures that settled it.
 */
export const BANNED_PATTERNS: BannedPattern[] = [
  { id: 'iso-date', label: 'a dated record', test: (text) => ISO_DATE.test(text) },
  { id: 'owner', label: 'an attributed decision', test: (text) => OWNER_ATTRIBUTION.test(text) },
  { id: 'history', label: 'superseded history', test: (text) => HISTORY.test(text) },
  { id: 'measurement', label: 'a measurement', test: (text) => MEASUREMENT.test(text) },
  { id: 'was-now', label: 'a before/after number', test: (text) => WAS_NOW.test(text) },
  { id: 'digit-row', label: 'a table of figures', test: (text) => text.split('\n').some(isDigitRow) },
]

/** ESLint hands back the comment body already; only the JSDoc gutter is left. */
function stripMarkers(comment: CommentNode): string {
  if (comment.type === 'Line') return comment.value
  return comment.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*/, ''))
    .join('\n')
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word !== '').length
}

type Block = { comments: CommentNode[]; text: string }

function isOwnLine(comment: CommentNode, lines: string[]): boolean {
  const before = lines[comment.loc.start.line - 1]?.slice(0, comment.loc.start.column) ?? ''
  return before.trim() === ''
}

/**
 * A block is a run of comments alone on consecutive lines. A comment sharing a
 * line with code stands alone, so annotating N fields is not one N-word block.
 */
export function groupBlocks(comments: CommentNode[], lines: string[]): Block[] {
  const blocks: Block[] = []
  let open: CommentNode[] = []

  const flush = (): void => {
    if (open.length === 0) return
    blocks.push({ comments: open, text: open.map(stripMarkers).join('\n') })
    open = []
  }

  for (const comment of comments) {
    if (!isOwnLine(comment, lines)) {
      flush()
      blocks.push({ comments: [comment], text: stripMarkers(comment) })
      continue
    }
    const previous = open.at(-1)
    if (previous !== undefined && previous.loc.end.line + 1 !== comment.loc.start.line) flush()
    open.push(comment)
  }
  flush()
  return blocks
}

function violationAt(kind: ViolationKind, label: string, block: Block, words: number): Violation {
  const first = block.comments[0]!.loc.start
  const last = block.comments.at(-1)!.loc.end
  return {
    kind,
    label,
    words,
    line: first.line,
    column: first.column,
    endLine: last.line,
    endColumn: last.column,
  }
}

export function analyze(source: string, comments: CommentNode[]): Violation[] {
  const blocks = groupBlocks(comments, source.split('\n'))
  const violations: Violation[] = []

  for (const block of blocks) {
    const words = countWords(block.text)
    if (words > COMMENT_WORD_CAP) violations.push(violationAt('over-cap', '', block, words))
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(block.text)) {
        violations.push(violationAt(`banned:${pattern.id}`, pattern.label, block, words))
      }
    }
  }

  return violations
}
