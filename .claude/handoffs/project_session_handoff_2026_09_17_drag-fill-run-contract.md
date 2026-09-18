# Drag fill — the run contract

## Status

SPEC SETTLED, NOT IMPLEMENTED. No code changed this session. Owner
verified the rule across all ten bands of a specimen column and said
"Prep that, we will clear, and then I will have you finish this."

## Tip

`3bbf3cfa` — fix(pick): report the aim band for every face in the debug
readout. (Other agents' work; this session committed only this handoff.)

## The rule — implement exactly this

**From the dragged band, run down through like material to the first
boundary. That slab is what the stroke writes into every swept cell.**

- Grab **solid** → run down through solid to that span's `floorBand`.
  Band 7 of a 6–7 span carries 6+7; band 6 carries only 6; a ground band
  carries the whole ground beneath it.
- Grab **air** → run down through air to that void's floor. Band 5 of a
  4–5 void carries 4+5; band 4 carries only 4; a one-band void carries
  only itself.
- **Welding is not a decision.** The slab lands; `canonicaliseColumn`
  merges whatever it touches. Nothing inspects what is overhead.
- **There is no refusal case.** Only "already solid" stops a fill.
- Shielding falls out free: the run never starts below its own floor, so
  it cannot reach a hollow under the material you grabbed.

**Protocol consequence — the blocker.** The swept cell CANNOT derive the
run's floor: in a neighbour, band 7 may sit in an air run reaching down
to band 4, and computing it locally would destroy the hollow. The floor
band must travel on the sculpt intent beside `targetBand`. It is a plain
integer, not a span index, so both replicas apply it deterministically.

**Deletions this enables** — `BandFill`'s `extend`/`overhang` variants,
the `null` refusal, both `isGapDrawn` calls in the write path, and
`pushLowerLayers` (the run IS the descent, not a second pass).

## What changed

- Nothing in code. `shared/src/columns/bandQueries.ts` is at its
  committed state.
- Two bugs diagnosed and reproduced against `frostwick-hollows`: a drag
  left 215 of 317 swept cells dead on a cliff, and 4,456 one-band voids
  exist that the old predicate could never fill.
- Owner ruling, verbatim: **"I don't care what overhangs.md says, that
  file is probably garbage at this point."** Do NOT treat
  `docs/decisions/overhangs.md` as binding for this area. #224's "the
  drag never seals a carve" is superseded.
- Spec artifact (10-band specimen, every band, both columns):
  https://claude.ai/artifact/HUr9vxiorBCBLJmY3HHymM

## Uncommitted

Untracked diagnostics in `server/`, safe to delete:
`scratch-drag-dead6.ts` (minimal arch repro), `scratch-drag-hole.ts`,
`scratch-void-origin.ts`, `scratch-void-mint.ts`,
`scratch-cliff-split.ts`. Run with
`node --experimental-strip-types server/<file>`.

A superseded patch sits in the session scratchpad — it implements an
earlier seal-check rule. Ignore it; write the run contract fresh.

## Pending

1. Implement the run contract in `shared/`.
2. Add the floor band to the sculpt intent + wire types.
3. Regenerate the two `golden-sculpt` file snapshots — they WILL move.
4. Tests need the owner's explicit permission, re-granted per session.
   The contract test is the ten-band specimen dragged at every band.
5. Rewrite `docs/decisions/overhangs.md` against the new contract.

## Resume path

1. Open the artifact above — it is the spec, panel per band, with the
   owner's own words quoted on bands 4, 5, 6, 7 and 8.
2. Rewrite `bandFillAt` in `shared/src/columns/bandQueries.ts` as the
   run lookup; delete the `BandFill` variants and both `isGapDrawn`
   gates from the write path.
3. Add the floor band to `shared/src/protocol/sculpt.ts` and have
   `client/src/input/sculpt/drag.ts` send it from the grabbed column.
4. Collapse `pushLowerLayers` in `shared/src/sculpt/drag.ts` into the run.
5. `pnpm typecheck` and `pnpm test`. NOTE: `pnpm test` bails at the first
   failing package — run `client` and `server` separately. Baseline before
   you start: client 4 fail / 772 pass, server 29 fail / 441 pass, both
   other agents' in-flight work.
6. Ask before regenerating goldens or writing tests.

## Cross-refs

[[project_session_handoff_2026_09_16_carve-overhang-pick-gate]] ·
[[project_session_handoff_2026_09_16_sculpt-owner-decisions-walk]] ·
[[project_session_handoff_2026_09_11_d_band0-shoreline-contract]]
