import ts from 'typescript'
import type { CommentNode } from './analyze.ts'

/**
 * Off-line callers read comments from here: the ESLint parser costs seconds to
 * import, tsc milliseconds. `test/comments.test.ts` holds both to one answer.
 */
const LINE_MARKER_LENGTH = 2
const BLOCK_MARKER_LENGTH = 2

export function commentsOf(source: string, path: string): CommentNode[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const found: CommentNode[] = []
  const seen = new Set<number>()

  const at = (position: number): { line: number; column: number } => {
    const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, position)
    return { line: line + 1, column: character }
  }

  const take = (range: ts.CommentRange): void => {
    if (seen.has(range.pos)) return
    seen.add(range.pos)
    const isLine = range.kind === ts.SyntaxKind.SingleLineCommentTrivia
    found.push({
      type: isLine ? 'Line' : 'Block',
      value: source.slice(range.pos + LINE_MARKER_LENGTH, isLine ? range.end : range.end - BLOCK_MARKER_LENGTH),
      loc: { start: at(range.pos), end: at(range.end) },
    })
  }

  /**
   * Every token, not every node: a comment before `import` or `}` is trivia of
   * a keyword `forEachChild` skips. Trailing ranges catch same-line comments.
   */
  const collect = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile)
    if (children.length === 0) {
      for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) take(range)
      for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) take(range)
      return
    }
    for (const child of children) collect(child)
  }

  collect(sourceFile)

  return found.sort((a, b) => a.loc.start.line - b.loc.start.line || a.loc.start.column - b.loc.start.column)
}
