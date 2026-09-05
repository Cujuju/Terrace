# Brief 3: in-game eyes-on of the real assets + retire the "no textures / no external assets" rules

Repo: /mnt/e/Development/Projects/Terrace. You run in your own git worktree (harness-created;
`pwd` and `git branch --show-current` first; use that root for every command). Commit on the
branch; do not merge or push; never edit the main checkout. GitHub issue: Cujuju/Terrace#322.

Context (all merged on main today, 2026-09-04, owner decision "everything may have textures and
external assets; import real, attractive models"):
- Render kit PBR-complete: client/src/render/{materialMaps,rigAsset,rigSkin,staticAsset}.ts.
  Asset units are WORLD units (AssetFootprint / ASSET_FIT_TOLERANCE_WORLD_UNITS).
- Blender tools: tools/blender/{import_model,stat_glb,render_glb}.py; docs/model-assets.md.
- Real assets in the game now: structures tier-2 timber house (plugins/structures/client/assets/
  timber-house.glb, CC0 Poly Pizza cottage), wildlife grazer = Quaternius deer
  (plugins/wildlife/client/assets/grazer-deer.glb), wildlife fish (assets/fish.glb, Blender-built),
  structures skiffs (assets/skiff.glb), boats war boat (plugins/boats/client/assets/war-boat.glb).
- Each has been shot in a preview harness (.model-import/shots/**). NONE of the new ones has been
  seen in the running game. That is this brief's Part A.

## Part A — in-game eyes-on (agent-owned stack; never touch the owner's)
Recipe: read /mnt/e/Development/Projects/Terrace/.claude/orchestration/briefs/glb-eyes-on-and-accessors.md
Part B and follow it exactly for the stack (own copy of .agent-stack/launch.sh under a project
dot-dir, spare ports, own WORLDS_DIR with a COPY of a populated world .db, own DB_PATH, Vite dev
server pointed at your server, chrome-headless-shell over raw CDP via client/scripts/
chromeHeadlessShell.mjs; see .glb-eyes-on/shoot-boats.mjs for a working in-world driver that
parks the camera relative to a real entity). Never inline `pkill -f`; kill only pids you captured.
Tear everything down at the end and prove it with `ss -ltnp`.

Shots (PNG, 1280×800 or larger) to /mnt/e/Development/Projects/Terrace/.model-import/shots/ingame/:
1. A settlement containing tier-2 timber houses: one mid shot showing several houses among other
   tiers, one close-up showing texture and race tint (both races if the world has both — check
   RACE_TINTS usage), one from the game's default orbit distance so legibility at play distance
   is judged. Check: houses sit ON the ground (no floating, no sinking past the sill), footprint
   inside the cell, no z-fighting, no magenta, texture not washed out.
2. Grazers (deer): a herd mid shot and a close-up mid-stride. Check hooves on the ground
   (memory rule: prove attachment, not bounds overlap), legs swing about their pivots, coat sRGB.
   Note any visible seam at shoulder/hip (known residual, #328) and say how visible at play distance.
3. Fish and skiffs in a coastal shot, war boat if a fleet is out (optional; already shot once).
4. Draw calls: read the renderer's frame draw-call count (see how .glb-eyes-on/shoot-boats.mjs or
   client/scripts/shootSpeciesPreview.mjs reads renderer.info) with the settlement + herd in frame,
   and compare to the plugins' declared drawBudget values (client/src/plugins/host.ts consumes
   `drawBudget`; read how it samples/logs breaches). Report numbers; a breach is a finding, not a fix.
Report every defect with the PNG that shows it. Do not fix rendering defects in this brief — file
them as findings (the orchestrator opens issues).

## Part B — retire the superseded rules (comments only; no behaviour change)
The owner superseded "no textures / no external assets" for every plugin today. Rewrite each of
these header passages so they state the CURRENT rule — external GLB assets and textures are
allowed and are the default path for new models (docs/model-assets.md); what STAYS banned is
non-determinism (Math.random) in procedural geometry, per-object lights, and anything that
changes shared/ — and keep every other sentence (do not delete history; say "until 2026-09-04
this file's rule was … ; superseded because …"):
- plugins/flora/client/models.ts:32–33
- plugins/monsters/client/geometry.ts:11–26 (keep the fur-texture story; the "arrives over the
  network" ban is gone — an embedded GLB texture is exactly that)
- plugins/monsters/client/cthulhu.ts:5 and plugins/monsters/client/kraken.ts:5 (one clause each)
- plugins/wildlife/client/models.ts:13 (the pool now holds asset-sourced species; say so)
- plugins/structures/client/models.ts:36 — already rewritten by phase 2; read it and only fix
  it if it still reads as the old rule.
- plugins/fire/client/scar.ts:94 and smoke.ts:57 say "No external assets:" as a DESCRIPTION of
  those effects, not a rule; leave them unless the sentence claims a plugin-wide rule.

## Part C — one leftover unit name
plugins/wildlife/client/species/assetSpecies.ts still has `ENVELOPE_TOLERANCE_CELLS` (L181, used
L90/L256/L453) and error text "cell tolerance" in a file whose docs now say world units. Rename to
`ENVELOPE_TOLERANCE_WORLD_UNITS` (same 0.01; rewrite its justification in world-unit terms), fix the
doc line and error text, grep the repo for other users. Names/words only. If `git log -1 --
plugins/wildlife/client/species/assetSpecies.ts` on main shows a commit newer than 912f92c, another
session is mid-pass on that file: skip Part C and say so.

## Rules
- Verify after B+C: `pnpm typecheck`; `cd plugins/wildlife && timeout 300 npx vitest run
  --hookTimeout 60000`; `cd plugins/monsters && timeout 240 npx vitest run`; `cd plugins/flora &&
  timeout 240 npx vitest run`. Never `pnpm -r test`.
- No tests to add (comments + a rename only).
- Diff scope: the files named in B and C only. Part A leaves NO tracked changes (dot-dir only).
- Commit conventional (`docs(plugins): …` for B, `refactor(wildlife): …` for C, or one commit),
  no attribution/footers. Do not merge or push.

## Report (short; file:line for claims)
Commit hash; absolute PNG paths with one line each on what they show; every defect found with
its PNG; draw-call numbers vs declared budgets; confirmation of teardown (`ss -ltnp` shows your
ports free, no chrome-headless-shell of yours); Part C done or skipped and why.
