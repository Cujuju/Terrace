# Flora structures

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (flora × structures — buildings always win)

**Trees despawn under buildings, by two layers, not one.** Owner report: "if
buildings are going to spawn over trees, then the trees need to de-spawn."
structures' `changes` world-event (b47d09e) names `seeded`/`upgraded` cells,
but that list is deliberately narrower than "every new structure" — it
excludes ordinary B3/S23 births and stir sparks, which chronicle treats as
churn, not history. A consumer needing "every occupied cell" cannot get it
from the event alone. Fix: flora's onWorldEvent fells a tree the instant its
cell is named seeded/upgraded (instant, matches the event's own causes); its
existing periodic survey (~5 s cadence) additionally treats every
structure-occupied cell — read via a new read-only cross-plugin bridge,
flora/server/structures-bridge.ts, the established dynamic-import pattern
(relics→mana) — as unplantable, culling anything already standing there.
This second layer is load-bearing, not redundant: it is what actually
guarantees the invariant for ordinary births/stir sparks and for buildings
that predate this feature. Structure death does not replant; the cell
recolonizes on flora's ordinary schedule once it drops out of the occupied
set.
