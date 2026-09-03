# Brief — the carve walks inward, lowers by default, hides Mode

You are a fresh Opus implementation agent working in an isolated git worktree
(your cwd; forked from main). Commit to the worktree branch as you go
(conventional commits, first line < 72 chars, no attribution footers, stage
exact paths only). Do NOT merge to main. Do NOT start or stop any app stack.
Do NOT touch `docs/**` (they are settled with the owner; the orchestrator will
flag the doc drift). Do NOT ADD new test cases — you may only UPDATE existing
tests whose expectations encode the old cut alignment. If `node_modules` is
missing in the worktree, `pnpm install --offline` (slow on this drive; run in
the background and poll).

Comments are claims, not evidence: verify every mechanism below at file:line
before changing it, and cite the lines in your report.

## The owner's report (verbatim)

> It's not working consistently when I attempt to carve layers. It will just
> stop. It only goes so far when my expectation is I should be able to carve
> all the way through a band.
> Also, because there is no raise mode, only a lower or remove that should be
> the default mode, and holding shift should not be required.
> Mode should also not be displayed in the HUD, much as we do not show hard or
> smooth for the pull tool.

## Bug 1 — the cut opens a band one above the band the pick names (root cause of "it stops")

Root cause, one sentence: `applyCarve` leaves the grasped band solid and
opens `spanBand + 1`, while the client's pick names the band whose SLAB the
ray struck, so the opening a cut leaves is never the band the next pick
inside it names, and the neighbour rule refuses every cut after the first.

Mechanism (verified this session):

- `client/src/world.ts` `bandOfPick` (~line 428): a riser hit names
  `ceil(hitY / BAND_HEIGHT)` — the band whose drawn slab
  `[(k−1)·BH, k·BH]` contains the struck height. Owner decision 2026-08-26
  quoted there: "if you're grabbing the side of a band, then that is the band
  that should apply." DO NOT change this derivation — the drag shares it.
- `shared/src/heightmap.ts` `applyCarve` (~line 2614):
  `lo = spanBand·BH`, `hi = (spanBand + CARVE_BANDS_PER_STROKE)·BH`, and the
  anti-cheat loop asks `canCarveBandAt` of bands
  `spanBand+1 … spanBand+CARVE_BANDS_PER_STROKE−1`. Result: lower piece
  caps at `spanBand·BH` (still covers band `spanBand`), roof floors at
  `(spanBand+2)·BH` (covers `spanBand+2`), so only band `spanBand+1` is open.
- Reproduced with the shared library (cliff at band 10, low ground at band 2,
  grab the lowest lip = band 3): first cut at x=10 opens band 4
  (`[-1536,48),[80,160)`); the back-wall riser inside that opening lies in
  slab `(48, 64]`, so the next pick names band 4; the cut at x=11 wants to
  open band 5, no neighbour is open at 5, refused. Tunnel is one cell deep,
  forever. Reproduction script:
  `/tmp/claude-1000/-mnt-e-Development-Projects-Terrace/76b23a0e-423e-4c59-a572-9d17b1bab3a3/scratchpad/carve-chain.mjs`
  (copy it into your worktree scratch if you want to rerun it).

The fix (verified by simulation, script `carve-fix.mjs` beside the one above):
the cut must OPEN the grasped band. In `applyCarve`:

```
lo = (spanBand − 1) · BAND_HEIGHT
hi = (spanBand + CARVE_BANDS_PER_STROKE − 1) · BAND_HEIGHT
anti-cheat: canCarveBandAt for band = spanBand … spanBand + CARVE_BANDS_PER_STROKE − 2
```

With that, grabbing lip band 3 on the cliff leaves `[-1536,32),[64,160)`
(floor level with the outside ground, band 3 open), the next riser hit
inside names band 3 again, and the cut walks inward cell by cell without
limit. Express the shift as a named constant or a clearly named local, not a
bare `- 1`; say in the comment WHY (the slab convention `bandOfPick` uses:
band k's face is `[(k−1)·BH, k·BH]`, so opening band k means removing from
`(k−1)·BH`).

Keep the `lo <= BEDROCK_FLOOR` whole-stroke refusal exactly as is — with the
new `lo` it also (correctly) refuses `spanBand = MIN_BAND + 1`, whose lower
piece would be empty. Keep the centre-column `spanIndexCoveringBand` guard in
`applySculpt`. Rewrite the `applyCarve` doc block so it describes the new
cut (it currently states "the cell is STILL SOLID at the grasped band" as the
design — that sentence is the bug). Re-check the `CARVE_BANDS_PER_STROKE`
comment (~line 201): its derivation (2 bands removed = the smallest DRAWN
opening) still holds; adjust wording only if it names the old alignment.

Run `pnpm test` and `pnpm typecheck`. Fix any existing test whose
expectation encodes the old alignment (search `shared/test`, `client/test`,
`server/test` for `carve`). Do not add tests.

## Bug 2 — a carve requires the lower chord; it should lower by default

Mechanism (`client/src/input/sculptInput.ts`):

- `onPointerDown` (~line 885) resolves the action from the control bindings
  (`resolvePress` in `client/src/state/controlPrefs.ts`); an unmodified
  click is `raise`. Touch uses the sticky `sculptMode()`.
- `emitIntent` (~line 521) then drops the intent:
  `if (strokeTool === 'carve' && sculptDirection(action) > 0) return;`
  — so a plain click with Carve does nothing until shift is held.
- `currentStrokeAction` (~line 476) re-resolves the modifier mid-stroke, so
  releasing shift during a carve stroke silently kills the rest of it.
- `startStroke` and `emitIntent` both call `setSculptMode(action)`, which
  writes the sticky, PERSISTED HUD mode (`hudState.ts` `setSculptMode`,
  stored) — a carve stroke would leave the HUD on "Lower" for the next tool.

Fix: a carve stroke's direction is the TOOL's, not the modifier's or the
sticky mode's. When the press's tool is `carve`, the stroke action is
`lower` regardless of modifiers (mouse) or `sculptMode()` (touch), it is
NOT re-resolved mid-stroke, and the carve must NOT write `setSculptMode`
(the sticky mode belongs to the tools that have a direction). Keep the
`dir > 0` refusal in `emitIntent` as a defensive guard with its comment
updated to say it is now unreachable and why it stays. Keep the wire
contract unchanged (`dir: -1`, validator in `shared/src/protocol.ts` ~line
528 still rejects `dir: 1`). Put the "which tools have no direction" fact in
ONE place (a shared constant beside `TOOLS_WITHOUT_EDGE_PROFILE` in
`shared/src/heightmap.ts` is the right home, exported from shared's index)
so the HUD (bug 3) and the input read the same list instead of each
hard-coding `'carve'`.

Check `takeHold` (~line 773) and the camera bindings
(`client/src/input/cameraBindings.ts`) still behave: a carve press with no
modifier must not be swallowed as a camera action, and shift-click with
Carve should also carve (the modifier is simply ignored for this tool).

## Bug 3 — the HUD shows Mode for the carve

`client/src/ui/Hud.tsx` ~line 396: the Mode row is unconditional. Wrap it
the way the Edge row is wrapped (~line 363, `<Show>` on
`TOOLS_WITHOUT_EDGE_PROFILE`), driven by the new shared constant from bug 2.
Remove the row rather than disable it, for the reason the Edge comment
gives. Keep the `brushTool()` read inside JSX (file-header rule). Check
`client/src/state/hudState.ts` and any HUD test for an assumption that the
row is always present.

## Verification you must do and report

1. `pnpm test` and `pnpm typecheck` green in the worktree (paste the summary
   lines). Failing tests in packages you did not touch may be other agents'
   work — check `git status` and say so explicitly rather than fixing them.
2. Rerun the reproduction script against your worktree's `shared/src`
   (adjust the import paths) and paste the output showing the cut walking ≥4
   cells inward.
3. Report file:line for every change, and the commit hashes.

Write your report to `.claude/orchestration/briefs/carve-review-report.md`
in the worktree and commit it. Then return a short summary.
