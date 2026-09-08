/**
 * Where the prose is supposed to go. Every project answers differently, so a
 * repo names its own in `COMMENT_BUDGET_REDIRECT`; Terrace sets it in CI and
 * in the pre-commit hook.
 */
const DEFAULT_REDIRECT = 'the commit message or a decision record'

export const REDIRECT = process.env['COMMENT_BUDGET_REDIRECT'] ?? DEFAULT_REDIRECT
