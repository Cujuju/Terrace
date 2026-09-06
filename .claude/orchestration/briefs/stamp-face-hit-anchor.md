# Brief: Stamp/Smooth on a riser hit anchors on the tread at the FOOT of the face (issue #347)

You are a fresh Opus agent working in a git worktree of /mnt/e/Development/Projects/Terrace.
Read this whole brief before opening any file. Do not read docs beyond what is named here.

## Rules (binding)
- Comments are CLAIMS, not evidence. Every mechanism you rely on must be verified at file:line in
  the actual code, and your report must cite those file:line pairs.
- Contract tests only: ONE new test (one `it`) in ONE new file under client/test/. No other tests.
- No screenshots, no running the app, no server changes, no shared/ changes. Client-only.
- Keep the change small and direct. No new dependencies. No refactors outside the fix.
- Code style: TypeScript strict; no `any`; prefer no comments (hard cap 30 words each, add one only
  where the WHY is non-obvious); no magic numbers (name every constant); never delete existing lines
  or comments; named exports; a `.ts` helper shared by ≥2 modules or needing a test lives in a
  sibling `.ts`, never exported from a `.tsx`.
- Commit on the worktree branch with a conventional-commit message, no attribution trailers.
  Stage only your exact paths. Do NOT merge, do NOT push, do NOT touch main.

## The bug (owner report 2026-09-05)
Clicking Plateau (Hard Stamp) near a lip sometimes raises the clicked band AND extends the band above.

Mechanism, as diagnosed from source (VERIFY each step yourself, cite file:line):
1. client/src/terrain/picking.ts — `TerrainRayPick` (~line 233). When the ray strikes a vertical
   riser, the pick names the column whose FACE the ray entered, i.e. the UPPER cell, with
   `hitRiser: true` and `(hitX, hitY, hitZ)` the world-space point where the ray met that face.
2. client/src/input/sculptInput.ts — `emitIntent` (~line 560). Every brush tool's intent takes
   `x: cell.x, y: cell.y` from `hoverTarget()` (~line 508), regardless of `hitRiser`.
3. shared/src/heightmap.ts — `anchoredTargetHeight` (~line 785): the target for a raise is the
   centre cell's grasped ceiling plus one band. From the upper cell (band k+1) that is k+2.
4. `fillTowardTarget` then raises footprint cells at k to k+1 AND cells at k+1 to k+2 in one stroke.

## The fix (owner-approved direction)
For the Stamp and Smooth tools ONLY, when the hover pick has `hitRiser === true`, the intent's
cell is the tread at the FOOT of the face: the cell the ray occupied just before entering the
struck column. Derive it by stepping back from `(hitX, hitZ)` along the ray's horizontal
direction by a small, named fraction of a cell, then converting to cell coordinates with the same
world→cell mapping picking.ts uses (see `worldPointToCell` / the CELL_WORLD_SIZE divide near
picking.ts:78–115 — verify the exact function name and rounding).
Pull (`drag`) and Carve keep the face cell exactly as today. Nothing changes when `hitRiser` is
false.

Where the ray lives: `hoverRay` (sculptInput.ts ~line 385, a `PointerRay` with `origin` and
`direction`, set together with `hoverCell` in `repick` ~line 456). `hoverTarget()` returns the
pick but not the ray; you will need both in emitIntent. Read how `dragPlaneCell` (~line 427)
uses the ray for the analogous pattern.

Design constraints:
- Put the derivation in a PURE helper in a sibling `.ts` (suggested: client/src/terrain/pickBand.ts
  already holds pick→band contract helpers — read it first and add there if it fits, else a new
  client/src/terrain/faceFoot.ts). Signature along the lines of
  `footOfFaceCell(pick: TerrainRayPick, direction: Vec3, worldSize: number): {x, y} | null`
  — returns the pick's own cell when `hitRiser` is false; returns null (caller then falls back to
  the pick's cell, or refuses — decide and justify) if the stepped-back cell is off the map.
- Guard against the degenerate case: a near-vertical ray (horizontal direction length ~0) has
  no meaningful "before" cell — return the pick's own cell and name the epsilon.
- The tool set that gets the foot anchor must be a named constant next to the existing
  TOOLS_WITHOUT_DIRECTION / TOOLS_WITHOUT_EDGE_PROFILE constants in sculptInput.ts (find them).
- `seedLayer` (~line 872) is a Pull-tool seed and sends `tool: 'stamp'` — read `takeHold`
  (~line 887) and decide, with a one-line justification in your report, whether the seed path
  needs the foot anchor. Hint: takeHold already refuses a riser hit before seeding (~line 909);
  confirm and leave it alone if so.

## The one test
client/test/<name>.test.ts, one `it`: construct a `TerrainRayPick` with `hitRiser: true` on cell
(4,4) with `hitX/hitZ` on that cell's -X face, and a ray direction travelling +X (and downward);
assert the helper returns cell (3,4). Model on client/test/pickBand.test.ts for imports
(`CELL_WORLD_SIZE` from ../src/config.ts). Also assert in the SAME `it` that `hitRiser: false`
returns the pick's own cell (that is the contract's other half, not a second test).

## Verify before reporting
- `pnpm --filter ./client exec vitest run test/<name>.test.ts test/pickBand.test.ts test/hoverPick.test.ts`
  with `timeout 300` (never run the whole workspace).
- `pnpm typecheck` from the worktree root with `timeout 600`.
- `git -C <worktree> diff --stat` and paste it.

## Report format (final message)
1. Verified mechanism: 4 bullets, each with file:line as it is in YOUR checkout.
2. Diff stat + commit hash on the worktree branch.
3. Test + typecheck output tails (exact).
4. The seedLayer decision and the off-map/null decision, one line each.
5. Anything you were unsure about, labelled "unverified".
