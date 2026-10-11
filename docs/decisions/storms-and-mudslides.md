# Storms and mudslides

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-09-01 (storms and mudslides defaults, #230/#231)

Owner calls on the two open-defaults issues from the storms/mudslides landing:

- **Storm surge defaults `on`** (was `off`). The condition: a surge scours only a
  shoreline whose whole brush footprint is revealed. The footprint guard that
  mudslides had built for itself (`footprintUnlocked`, tested by chunk, the
  square superset of the round brush) moved to `server/src/plugins/footprint.ts`
  and both plugins import it — one rule, not two that could drift. Rejected:
  gating on the centre cell only (the brush skirt can bleed a chunk over), and
  filtering the *broadcast* while still writing the height (the write is the
  harm; a player unlocking the chunk later would find a scar with no history).
- **The hurricane eye stays bright daylight** — that is what a real eye is.
- **Cyclones form wherever the water test passes**, inland seas included; no
  map-edge restriction. `waterFractionUnder` is the rule.
- **Mudslide frequency defaults `uncommon`**, a new tier between `rare` (6× the
  wait) and `common` (1×) at 3× — the integer nearest the log midpoint (2.45)
  that keeps "half `rare`, three times `common`" exactly sayable.
- **Mud runs into the sea.** The `sea` stop is gone from `nextFlowCell`: a front
  keeps walking the seabed downhill and deposits there, so a coastal cliff — the
  steepest ground on a genesis world — slides like any other and a big enough
  slide builds a fan through the surface. Fresh water still stops a front on the
  bank (the debris-dam reason stands). `sea` remains in `MUDSLIDE_STOPS` so
  slices written before this parse. Residual, named: the client draws the front
  at lattice height, so under water it is not visible; the fan is.

## Decision made 2026-09-15 (rain coverage cap follows the scaled footprint)

Reverses the population half of `d73f7f62`. That commit tripled rain and snow
front area but kept the active cap computed over the base disc, so the number
of fronts stayed the same and the realised rain coverage was ~3 × 0.09 (~26%
measured on the shipped world). Owner call: `coverageFraction` means what it
says. `discActiveCapFor` and `discMeanFootprintCells` now take the population's
`footprintAreaScale`, so a bigger front means fewer fronts, not more sky.
Shipped 512-unit world: rain cap 7 → 3; 128-unit worlds stay at the floor of
1; fog and thunderstorm (scale 1) are byte-identical. Rejected: renaming the
constant to describe the tripled coverage (keeps a number that lies), and
leaving it (the 26% sky was the complaint).

## Decision made 2026-09-15 (snow seats from band 15 up)

`SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA` 2 → 15 (mean ground under the disc at
least 240 height units). Snow no longer falls on green fields; it seats over
the upper grassland and everything above. Owner call, band chosen directly.
Rejected: `MOUNTAIN_MIN_HEIGHT` (384, rock only) and `SNOW_LINE_HEIGHT`
(576, snow-capped only) — both too rare on ordinary genesis worlds.

## Decision made 2026-09-15 (`cyclone-surge` renamed `cyclone-damage`)

Wind scour had ridden the surge switch with no decision of its own. Owner
call: a cyclone does damage or it does not, over water and land alike, so the
one switch is named for that. `cyclone-damage` (`off`/`on`, default `on`)
gates the shoreline surge and the inland wind scour together. Saved worlds
keep their value: `PluginSettingDeclaration.formerKeys` lets a plugin name the
keys a setting used to be stored under, and the session and admin readers
resolve them (current key wins). Rejected: a second switch for wind scour
(two knobs for one intent), and leaving the misnamed key.

## Decision made 2026-09-15 (no flash, no thunder)

The flash governor's floor is photosensitivity; strikes that come too soon
used to thunder anyway, so about one strike in six was heard but never seen.
Owner call: sound and light always agree. A strike thunders only when its
bolt was drawn, which also means reduced-motion players, who see no bolts,
hear no thunder. Rejected: keeping thunder for refused flashes (the review's
"intended" reading).
