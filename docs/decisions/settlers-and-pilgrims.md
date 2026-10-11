# Settlers and pilgrims

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-19 (settler races & Pilgrim Routes — mechanics card 47)

**Settler races & Pilgrim Routes (owner decisions 2026-08-19).** Two settler
races: Rudys (little dog people) and Unos (cat people); ids `rudy`/`uno`,
plural Rudys/Unos. Race is derived, never stored: bit 24 of the structures
cell-hash over 16-cell district coordinates (`SETTLER_DISTRICT_CELLS`), one
race per district. Other plugins copy the derivation (plugin-isolation rule)
and pin the shared golden vectors: (0,0) rudy, (16,16) uno, (100,100) uno,
(511,511) rudy. Pilgrim routes (card 47): monster settled = 16-cell circle
held 120 s; catchment 64 cells; viewpoint = highest walkable cell on a 24-cell
ring (8 = measured largest protection aura 4.5 rounded up + drift margin,
deliberately not imported); walk 0.5 c/s, linger 30 s, cap 24; all constants
derived in `pilgrims/server/pilgrimage.ts`. Route blessing: structures waives
only `STRUCTURE_UPGRADE_MIN_NEIGHBORS` for blessed cells (age gate and B3/S23
untouched), replace-semantics total state, not persisted. Pilgrims plugin
reads monsters/structures via relics→mana-style dynamic bridges; difficulty
deliberately unread (monsters already scale with it).

## Decisions made 2026-08-19 (hi-res settler models)

**Hi-res settler models (owner decision).** Pilgrim folk are the one
deliberately smooth family of models in an otherwise flat-shaded blocky world
(approved concept: artifact d6cf5ca4). Construction: per race, all static
body parts merge into one vertex-colored Lambert geometry and the glossy
eyes/nose into one Phong geometry — 8 draw calls, ~7k triangles per pilgrim,
shared geometry across instances. Vertex colors are stored exactly as
`new Color(hex)` yields them — three r152+ already converts to working space;
converting again double-darkens (round-1 defect). No lighting/shadow changes:
smoothness comes from geometry and smooth normals under the existing
hemisphere+sun rig. The rig contract (`create(race)` → `{root,
animate(seconds, phase)}`, feet at y=0, +X forward, joint meshes) is
unchanged; animals, monsters and structures stay blocky pending a separate
owner decision.

## Decisions made 2026-08-19 (wanderers — ambient settlers, card 26)

**Wanderers.** A second walker kind on the pilgrims wire (`kind: 'pilgrim' |
'wanderer'`; absent kind parses as pilgrim, unknown kinds drop; one id
allocator across both sims). Deterministic dispatch: time cut into 60 s
epochs; each epoch every qualifying settlement rolls
`hashCell(hashCell(x,y)^epoch, epoch) % 4 === 0`; the roll's high bits pick
the destination. Qualifying = SENDER has survived ≥ 4 CA generations
(structures' own `age`, carried over the bridge since 2026-08-19;
wire-neutral; absent age = old build = qualifies); destination = ANY standing
settlement 8–48 cells away, walkable — the card demands "stood some while" of
the sender only, and the measured world (snapshot gen 3401: 14 cells, ages
mostly 0–2) has no established pairs. Journey: walk out, visit 10 s, walk
home, despawn; pilgrims' stuck rules verbatim. Purely cosmetic by contract —
no blessing, no mana, no monster reads. Cap 16 (< pilgrims' 24: events may
crowd, ambience may not). Visual: same race body/gait/palette, no staff — the
one at-a-glance kind difference. Tuning is sized to the MEASURED world and
recorded as such; a dense future world rides the cap.
