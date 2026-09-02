# Terrace — project instructions

Consult `docs/DESIGN.md` for standing rules and architecture, and
`docs/decisions/<arc>.md` for the dated decisions of the area you are touching.
Both are settled with the owner — do not relitigate without new information.
Do not append to either without the owner's permission in the current turn.

## Task tracking

GitHub Issues on `Cujuju/Terrace`. Arcs are `arc/<slug>` labels, buckets are
`area/<x>` labels (see global CLAUDE.md for the scheme).

## Commands

- `pnpm typecheck` — typecheck all workspace packages
- `pnpm test` — run Vitest across the workspace
- Tests and typecheck must pass before any commit that touches `shared/`.

# Tests
- Never add or write tests without my explicit permission; permission is per-session only and must be re-granted in each new session.

Failing tests in packages you did not touch are other agents' in-flight work —
check `git status` before reporting them as breakage.

## Committing (shared checkout, concurrent agents)

Commit work as soon as it is done. Agents share this checkout, and
uncommitted changes get overwritten.

Stage only your exact paths — never `-A`, never a bare `git add`.

Working in a worktree? Commit to its branch, then call `ExitWorktree`
(`action: "keep"`) to return to this checkout and merge there — git against the
shared checkout is blocked from inside a worktree until you do.

## Hard rules from the design record

- `shared/` is the single source of truth for terrain math and protocol types.
  Client and server both import it; never duplicate its math.
- Terrain math must stay deterministic: integer-only (or exactly-specified
  IEEE ops like `Math.sqrt` with immediate integer floor), fixed iteration
  order. Identical inputs must give identical outputs on server and client.
- `shared/` uses only erasable TypeScript syntax (no enums, no namespaces) so
  Node 24 can run it directly via type stripping.
- Clients send intents, never heights. The server is authoritative.
- Nothing "gamey" in core — mana, followers, reveal timing are plugins.
- Never start or shut down the app (server or client) without the owner's permission in the current turn.


# TypeScript
- TypeScript strict mode throughout — no `any` without a comment explaining why
- Prefer named exports over default exports for components

# SolidJS / React
- Co-locate types with the code that uses them; shared types go in `client/src/types/index.ts`
- Keep components focused — if a file grows past ~300 lines, consider splitting
- A `.tsx` exports only components (+ types — erased, exempt). A runtime const/fn stays **unexported-local** if used once; promote to a sibling `.ts` only when **shared by ≥2 modules**. Never `export` a non-component value from a `.tsx`.

# Documentation
