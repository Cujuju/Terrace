# Terrace — project instructions

Read `docs/DESIGN.md` first. It is the design & decision record; decisions there
are settled with the owner — do not relitigate without new information.

## Task tracking

GitHub Issues on `Cujuju/Terrace`. Arcs are `arc/<slug>` labels, buckets are
`area/<x>` labels (see global CLAUDE.md for the scheme).

## Commands

- `pnpm typecheck` — typecheck all workspace packages
- `pnpm test` — run Vitest across the workspace
- Tests and typecheck must pass before any commit that touches `shared/`.

## Committing (shared checkout, concurrent agents)

**Commit your work the moment a unit of it is complete — do not leave it
sitting in the working tree.** Several agents edit this checkout at once, and
an uncommitted change is unprotected: another agent's `git add`, `git stash`
or `git checkout` can sweep it into their commit or wipe it. Committed work
cannot be silently lost.

- "Complete" means the smallest thing that stands on its own and passes
  `pnpm typecheck` + the affected package's tests — not "the whole task".
  Several small commits beat one big one held back for an hour.
- Stage **only your exact paths**, never `-A` and never a pathspec-less
  `git add`. Before staging a file, check it holds nothing you did not write
  (`git diff <path>`); if a co-editor is mid-edit inside it, have them commit
  first rather than sweeping their half-finished work in.
- Push when you commit. A local-only commit still loses to a hard reset.
- This does not license committing on the owner's behalf where they asked to
  review first — say what you are about to commit if there is any doubt.

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


# TypeScript
- TypeScript strict mode throughout — no `any` without a comment explaining why
- Prefer named exports over default exports for components

# SolidJS / React
- Co-locate types with the code that uses them; shared types go in `client/src/types/index.ts`
- Keep components focused — if a file grows past ~300 lines, consider splitting
- A `.tsx` exports only components (+ types — erased, exempt). A runtime const/fn stays **unexported-local** if used once; promote to a sibling `.ts` only when **shared by ≥2 modules**. Never `export` a non-component value from a `.tsx`.

# Documentation

# Naming
- React components: `PascalCase`
- Hooks: `useCamelCase`
- Utilities/services: `camelCase`
- CSS tokens: `--kebab-case`
- localStorage keys: `appNameHere:camelCase`
