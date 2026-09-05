# Species sheet: pass 5 — the angelfish (`angelfish`)

Generic brief: `.claude/orchestration/briefs/species-glb-pass-template.md` — read it FIRST; this
sheet only carries what is specific to the angelfish. Passes 1–4 (fish, shark, ray, eel) are
merged; this is model-only through the existing adapter.

## The species you replace
`plugins/wildlife/client/species/angelfish.ts`. Colours 0xe8b83c body (golden), 0x23232a bars
(near-black), 0xdfa838 fins, 0x141310 eyes. `ANGELFISH_ENVELOPE` evaluates to: length 0.63,
halfLength 0.315, halfWidth 0.085 (a BAR's outer face — `BAR_HALF_THICKNESS`), crownY
0.3287741112302734 (dorsal tip: hull half-height at x = −0.06 minus FIN_SEAT_BITE plus
DORSAL_PEAK 0.24), bellyY −0.3152764129638672 (anal tip). Nose +0.25, caudal tip −0.38
(PEDUNCLE_X −0.25 − CAUDAL_REACH 0.13). Joints: `rig`, `tail`, `leftPectoral`/`rightPectoral`.
`animate`: ANGELFISH_TAIL_HZ 2.2, ANGELFISH_TAIL_SWING_RADIANS 0.35 (both EXPORTED — grep
importers, keep the exports), BODY_COUNTER_YAW_FRACTION 0.18, pectoral dihedral 0.55 with
flutter 0.14 lagging 0.9. ONE envelope: crown/belly are rigid fins, static at rest.

## Design decision, already made: the bars are geometry
`halfWidth = 0.085` is the outer face of a bar standing proud of the flank (hull 0.07 across at
widest). The install checks `flank` against it, so the bars cannot be paint: raised bands on both
flanks — thin lens-section plates wrapped onto the hull, or a locally thickened section — whose
outermost point is z = ±0.085 exactly at the front bar's station; `flank` sits there. Bars at
x = +0.08 and −0.10, tall (~0.88 of hull height there, crowns and heels buried), lens-shaped so
they read as markings. Pectorals rest at identity (flat in the file) like the fish's; their
0.55 rad dihedral is assigned in `animate`; flat they reach past 0.085, which is the upper-bound
case the docs allow.

## The model
A freshwater Pterophyllum silhouette: tall, thin, disc-shaped body (two and a half times its
width at the crown of the curve); long triangular dorsal sweeping up and back to crownY;
matching anal fin to bellyY; small forked caudal on a narrow peduncle under `tail`; small
pectorals with rounded roots; two dark vertical bars; eyes; a small mouth. Triangle aim ≤ ~2 500.

Joints: `SWIMMER_JOINTS` (rig, tail, pectoral_port −Z, pectoral_starboard +Z). Old
`leftPectoral` was `sign = 1` → +Z → STARBOARD: `+0.55 + flutter` → `pectoral_starboard`,
`−0.55 − flutter` → `pectoral_port`.
Anchors: `nose` (+0.25), `tail_tip` (−0.38), `crown` (dorsal tip, crownY), `belly` (anal tip,
bellyY), `flank` (±0.085, front bar's outer face).

## Extra deliverable for this pass
Fix the stale species lists in the fish.ts and shark.ts header comments (they still name
ray/eel/angelfish as whaleHull/bodyKit users) — one line each, in this commit.

## Render check specific to this species
Side view must show the bars as markings on the flank, not separate plates; if they read as
plates, thin/soften them and re-render.

Report: `.claude/orchestration/briefs/angelfish-glb-pass5-report.md`.
