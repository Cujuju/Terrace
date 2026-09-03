# Brief — #299 (part 2 of 2): the cyclone towers

You are a fresh implementation agent. Work in your OWN worktree (`EnterWorktree` with
no path → new worktree off main). Commit to its branch (conventional commits, first
line < 72 chars, NO attribution footers, stage exact paths only). Do NOT merge to
main. Paths relative to the worktree root. Main already contains the #300 kit change
(camera-height deck ordering: read `client/src/plugins/kit/cumulusDeck.ts`,
`kit/discSystemsView.ts`, `client/src/plugins/types.ts` for the accessor) — build on
it, do not re-derive it.

Read first (binding): root `CLAUDE.md`; `docs/decisions/storms-and-mudslides.md`
(do not append); `plugins/cyclone/client/spiral.ts` header (:1-72) and its constants
(:73-215); `kit/cumulusDeck.ts` (:1-230: the tiered-depth design the rain deck uses —
DECK_TIERS, population taper, top-radius fraction, tier jitter, PUFF_NORMAL_FLATNESS);
`kit/precipitation.ts`; `plugins/cyclone/client/index.ts`, `gloom.ts`;
`plugins/cyclone/protocol.ts` (CYCLONE_DECK_HEIGHT_WORLD_UNITS, CYCLONE_EYE_RADIUS_FRACTION).

## Owner's rulings (2026-09-03)
- "Cyclones seem extremely weak and don't seem to do anything but kind of rotate a
  puffy disk." (#299) — the visual half.
- "Do the tower for the cyclone." Confirmed reading: the storm keeps its disc
  footprint and eye hole (eye-hole shading decision is PARKED — leave
  CYCLONE_SHADE_CORE_FRACTION and the eye logic alone), but is built IN DEPTH: the
  spiral bands rise from a low, wide rim to a tall, dark EYEWALL ring around the eye,
  with rain columns falling out of the bands. Not a tornado cone; the tornado plugin
  owns that shape (#233).

## Today (verified)
spiral.ts: 810 billboarded puffs (9 arms × 90) on a logarithmic spiral evaluated in
the vertex shader, one instanced draw, `DECK_THICKNESS_FRACTION = 0.1` of a
10-world-unit deck height → a flat lid (gate shot `g3-cyclone-side.png` in
`.verify-shots/phase3/` of the old worktree `.claude/worktrees/agent-a63416ea19b8c4c12`
if you want the before). MeshLambert-lit, `PUFF_NORMAL_FLATNESS` from the kit.
No precipitation. Gloom (gloom.ts) darkens the scene light under the storm.

## Build
1. **Depth profile.** Puff height becomes a function of `aAlong` (0 at the eyewall,
   1 at the rim): tall at the eyewall, falling to the rim. Named constants for the
   eyewall height (a multiple of the deck height or of `DECK_THICKNESS_WORLD_UNITS`
   — pick the one whose reasoning holds at every world-size radius clamp and say
   why), the rim height, and the falloff exponent. Puffs stack in tiers at the
   eyewall like the kit deck (several puffs per arm position across the height, or
   more puffs per arm near the eye — state which and why; the instance count is a
   coverage decision, doc it like `PUFFS_PER_SPIRAL`). The layout stays evaluated in
   the shader from per-instance attributes: NO per-frame CPU matrix writes
   (`layoutDirty` rule, spiral.ts:1-20).
2. **Eyewall reads dark and solid.** Puffs near the eye are bigger and denser and
   darker than the rim (`CYCLONE_EYEWALL_SHADE` exists — make it do this properly, or
   replace it with a named profile). The eyewall must occlude the far side of the
   storm from a low camera: a side view should show a wall, not a band.
3. **Rain under the bands.** Cyclone rigs get a `PrecipitationColumn` per storm
   using the kit column with a cyclone profile (streak, named count/opacity), whose
   seed disc covers the band annulus — NOT the eye. The kit column seeds a full disc
   (`precipitation.ts:203-211`); extend the profile/contract with an inner-radius
   fraction so an annulus is a first-class option (rain, snow, thunderstorm pass 0 and
   are unchanged). Column render order follows the #300 contract: it must never paint
   over the spiral from above. Say how the spiral's `SPIRAL_RENDER_ORDER` relates to
   the kit's constants after your change.
4. **Ground shade & gloom** stay; if the shade darkness (0.15) is now visibly too
   faint against the darker eyewall, raise it with a reasoned doc — the issue text
   flags it. Leave the eye core decision parked.
5. **Draw budget**: `drawBudget` in cyclone/client/index.ts must be updated from the
   new object count, derived from the plugin's cap, not typed.
6. **Reduced motion**: nothing new animates on the CPU; the shader time uniform
   already respects the view's clock — confirm from source.

## Verification (required, capped)
Typecheck + `pnpm --filter <cyclone pkg> test` + client tests with a timeout; NEVER
`pnpm -r test`. No new tests (owner rule). In-world shots: you MAY run your OWN
isolated stack from your worktree (Vite DEV, never `vite build`; free port via
`ss -ltn`, `WORLDS_DIR` + nonexistent `DB_PATH` under `.tower-stack/`; pid-file kill
only, never inline `pkill -f`; `CYCLONE_DEV_FORCE=1`). Template scripts: the old
worktree's `.phase3-stack/{launch.sh,stop.sh,shot.mjs}`. HARD CAP 20 minutes on
stack+shots; past it, tear down and report "shots not taken" with the blocker. Shots
to `.verify-shots/cyclone-tower/`: (1) side view at cloud height, (2) low view from
the ground under the rim, (3) from above. Tear down when done.

## Constraints
No new deps. No magic numbers. Erasable TS, no `any`. Kit code names no plugin.
Don't touch `docs/**`, `.claude/**` except your report, or `plugins/cyclone/server/**`
(another agent owns it this session).

## Report
`.claude/orchestration/briefs/cyclone-tower-299-report.md`: commits, worktree
path/branch, constants table (name, value, reason), file:line per item, test/typecheck
tails, shot paths or blocker, draw-budget arithmetic, what you left undone. Then stop.

## Integration constraint found by the orchestrator (verify it yourself)
The kit column births every particle at `CLOUD_BASE_WORLD_Y` (24 wu, precipitation.ts)
and that height is not a profile parameter, while the cyclone deck sits at
`CYCLONE_DECK_HEIGHT_WORLD_UNITS = 10` (protocol.ts:325) — below the kit's
`MAX_GROUND_WORLD_Y` (16), so a tall peak can already poke through today's disc. Rain
born at 24 over a deck at 10 would fall out of empty sky. Resolve it at the contract:
either the cyclone's base moves to the kit's cloud base (then the eyewall rises above
it; check the gloom aim and the shade disc `y` in index.ts:161-168 follow), or the
column contract gains a base height. Prefer the first unless you find a reason it
breaks the cyclone's "seen from inside it" design (spiral.ts:1); state the reason.
