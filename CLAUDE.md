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
