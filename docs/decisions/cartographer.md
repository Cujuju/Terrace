# Cartographer

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (the Cartographer — mechanics card 45)

**An in-game chart of the known world, client-only by construction.** The map
button (bottom-right, stacked above the gear so the phone-width strip gains no
width) opens a modal overlay that renders the player's revealed chunks as an
inked parchment chart, exportable as a PNG named after the world. Everything
is derived on the client from the terrain mirror through a narrow read-only
window (`World.chartSource()`): "revealed" is exactly the mirror's `received`
set — the renderer's own notion of what exists — so no reveal-plugin knowledge
and no protocol change is involved, and nothing new goes on the wire.

**The chart is a document, not a minimap.** Drawn once per open (dated the
moment it is made), sepia ink on parchment rather than the game palette: band
boundaries become contour lines, the waterline a heavy coast stroke, water a
depth-graded wash with wave-dash hatching, and the FOG BOUNDARY is the
parchment's own burnt edge — a singe gradient plus a jittered tear line — with
"here be krakens" set in the deepest unknown. The sheet crops to a padded
square window around revealed territory (`chartWindow`): at the live world's
~2% revealed, a world-scale sheet made the known world a stamp on an empty
page. All randomness (mottle, tear jitter) comes from a fixed integer hash of
cell coordinates, so identical knowledge charts identically on every client.

**Split for testability.** Classification, the frontier BFS/singe field, the
kraken anchor and the crop window are pure in `client/src/terrain/chart.ts`
(tested, `client/test/chart.test.ts` — including that unrevealed heights are
NEVER read); the canvas painting and the Solid overlay live in
`client/src/ui/Cartographer.tsx`. Chart-open state is deliberately not
persisted — reopening a modal on reload is a surprise, not a preference.
