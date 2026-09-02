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
