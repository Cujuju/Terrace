# relic art pass 2 — report

Branch `relics-art-p2`, worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/relics-art-p2`.

## Shape heights

Bounding-box heights, world units after the common scale, and the same figures
in the builders' unit frame (÷ scale). Every relic's bbox is 0.7999 wide before
and after — the tile is 2 units under all five, so that width IS the common
scale: **0.39997, unchanged**. Azure Heart is still the tallest half-extent, so
it still sets the scale and no relic shrank.

| relic | before (world / unit) | after (world / unit) |
|---|---|---|
| titans-hand | 0.8879 / 2.220 | 0.8879 / 2.220 |
| quake | 0.3240 / 0.810 | 0.7950 / 1.988 |
| genesis | 0.7039 / 1.760 | 0.8799 / 2.200 |
| azure-heart | 0.9000 / 2.250 | 0.9000 / 2.250 |
| spring-of-aether | 0.4640 / 1.160 | 0.7239 / 1.810 |

## Triangles (merged geometry, tile included)

| relic | before | after |
|---|---|---|
| titans-hand | 168 | **3444** (cap was ~4000) |
| quake | 668 | 1100 |
| genesis | 300 | 236 |
| azure-heart | 464 | 464 |
| spring-of-aether | 484 | 2008 |

## Spires (plugins/relics/client/relicSpire.ts)

`SPIRE_HEIGHT_WORLD = 14`, `SPIRE_RADIUS_WORLD = 0.5`, `SPIRE_SEGMENTS = 10`,
`SPIRE_FALLOFF_EXPONENT = 2.2` (alpha = (1−up)^2.2), `SPIRE_FOOT_FADE_WORLD =
1.2` (smoothstep at the foot, so the column does not cut a bright disc into the
ground), `SPIRE_BASE_ALPHA = 0.5`, `SPIRE_PULSE_PERIOD_S = 4.5`,
`SPIRE_PULSE_DEPTH = 0.18`, `SPIRE_RENDER_ORDER = 10`. Open-ended cylinder,
`DoubleSide`, `AdditiveBlending`, `depthWrite: false`, `toneMapped: false`.
ONE shared geometry (built lazily in index.ts, disposed with the gem
geometries); ONE material per relic, holding its category colour and its own
pulse phase — the same split the gems already make.
`RELIC_DRAW_OBJECTS` is now 2; `drawBudget` stays `RELIC_COUNT *
RELIC_DRAW_OBJECTS`.

**Fog decision: the spire is not fogged, and there is no fog to respect.**
Nothing in `client/src/` assigns `Scene.fog` (grepped this session: the only
hits are comments in `client/src/plugins/kit/hazeBank.ts:14` and
`discSystemsView.ts:16`; `client/src/render/frontierFog.ts` is its own quad
geometry, not scene fog). Recorded in the module comment: if scene fog is ever
added, a beacon meant to be read from across the map should stay exempt.

## Screenshots

All under
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/relics-art-p2/.relics-harness/shots/`:

- `row.png` — all five with spires on a flat plane, camera at the game's
  default orbit (azimuth 45°, polar 55° — `client/src/render/scene.ts:135-136`),
  17 world units out.
- `close-titans-hand.png` — the modelled hand: wrist, rounded palm, knuckles,
  four three-boned fingers fanned, thumb splayed forward.
- `close-quake.png` — the two mirrored fans of three upright open arcs, feet on
  the slab, epicentre dome between them.
- `close-genesis.png` — the barbed arrow planted in the mound.
- `close-azure-heart.png` — unchanged, for the common-scale comparison.
- `close-spring-of-aether.png` — the fountain: column, foam plume head, six
  falling spray arcs, droplets on the pool.
- `icons-preview.png` — the regenerated `preview.html` at 4× device scale;
  all five still read at 38 px.

## Verification

`pnpm typecheck` clean across the workspace (0 `error TS`).
`plugins/relics` vitest: 4 files, 77 tests, all pass.

## Not done / handed back

- **`relics.py` and the regenerated SVGs are NOT committed.** The whole
  `.claude/orchestration/refs/` tree is untracked in the main checkout by
  convention, and committing over paths that exist there untracked would make
  the merge fail. The mirrored generator lives in the worktree at
  `.claude/orchestration/refs/hud-icons/relics.py`; copy it (and
  `relic-*.svg`, `preview.html`) back over the main checkout's copies after
  merging. `plugins/relics/client/RelicIcons.tsx` — its actual output — IS
  committed.
- `.relics-harness/` is gitignored, matching `.volcano-shots/` and friends, so
  the PNGs live only in this worktree. Keep the worktree until they have been
  looked at.
- The Python icon renderer uses lower segment counts than the TS builders
  (`HAND_SEG = 8`, spheres 4×6, no palm bevel) — positions and proportions
  match, resolution deliberately does not.
