# Brief: relic art pass 2 — light spires + four model redesigns

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, SolidJS + three.js client).
Work ONLY in your own worktree. Create it first:
  git -C /mnt/e/Development/Projects/Terrace worktree add .claude/worktrees/relics-art-p2 -b relics-art-p2 main
Absolute worktree root: /mnt/e/Development/Projects/Terrace/.claude/worktrees/relics-art-p2
Never edit or run git against the main checkout. Commit to branch relics-art-p2. Do not push. Do not merge.
Comments are claims, not evidence: verify behaviour from executed code and cite file:line.
Do NOT start the game app (server or Vite client) — the owner has not authorised it this turn. Verification is by the standalone render harness described below.
No new dependencies. No tests may be added or edited. Conventional commit messages, no attribution lines or footers.

Read first, in the worktree:
- plugins/relics/client/relicShapes.ts — the per-skill builders, the paint/attribute contract, `relicGeometry` (ONE common scale from the tallest shape), `tile()`.
- plugins/relics/client/gemMaterial.ts — the icon-lit shader (face normal from derivatives → flat shading; higher segment counts = smoother look).
- plugins/relics/client/gems.ts — GEM_RADIUS_CELLS, GEM_HOVER_CELLS, gemGroundY, bob/spin.
- plugins/relics/client/index.ts — createGem/syncGems/animateGems, RELIC_DRAW_OBJECTS, drawBudget.
- .claude/orchestration/refs/hud-icons/relics.py — the icon generator. It MIRRORS every builder in Python (titans_hand, quake, genesis, spring_of_aether) and projects them onto the tile; `python3 relics.py --preview` rewrites plugins/relics/client/RelicIcons.tsx, relic-*.svg and preview.html. The model IS the icon: every builder change must be mirrored there and the icons regenerated. Python may use lower segment counts than the TS builder where a 32 px icon needs it; positions, proportions and paints must match.
- docs/DESIGN.md and docs/decisions/plugin-host.md, mesh-budgets.md (plugins declare draw budgets as expressions of their own caps).

Owner's words (2026-09-05), verbatim:
> add spires of light coming from the relics so they are easy to spot.
> The water fountain needs to be modeled like it looks like it's actually got water coming up, spraying up from the center into a plume.
> Genesis has a ball on a stick and it should probably look more like a barbed arrow.
> The quake needs to look more like sound waves instead of concentric circles.
> I want the hand to be rendered like a strong high-resolution hand like you would expect the hand of God to look like.

## Design decisions (settled by the orchestrator — do not relitigate; flag if impossible)

### A. Light spires (new, index.ts + a new sibling module e.g. `relicSpire.ts`)
- One extra mesh per relic: a vertical column of light in the skill's CATEGORY colour (`relicColor`, gems.ts), rising from the relic's ground (gemGroundY) to a named height (a constant, world units; start around 14 — tall enough to show over a hill from the default camera). Radius a named constant, roughly 0.5 world units at the base.
- Open-ended cylinder, double-sided, additive blending, `depthWrite: false`, unlit, not tone-mapped. Vertex alpha: strongest at the base, fading to zero at the top; a soft fade also at the very foot so it does not cut a hard disc into the terrain. A slow gentle pulse of intensity (period a named constant, few seconds) is allowed but keep it subtle; no spin.
- The spire does NOT bob or spin with the gem; it is positioned once per frame at the relic's cell, base at `ground`, hidden when the gem is hidden. Render order: spires after opaque scene (transparent material handles that; set `renderOrder` if needed so it draws after water/terrain). Check whether client/src/render/scene.ts uses fog and decide whether the spire respects it — state the decision in the report.
- Draw budget: `RELIC_DRAW_OBJECTS` becomes 2 (gem + spire) with the comment updated; drawBudget stays the expression `RELIC_COUNT * RELIC_DRAW_OBJECTS`. Geometry shared across relics (one BufferGeometry, per-relic material or per-relic mesh with shared material + a uniform for colour — your call, state it). Dispose on plugin dispose, exactly as gems are.

### B. Spring of Aether — a real plume
Keep the rock outcrop, rim and pool. Replace the low "well" dome with a FOUNTAIN: a central water column rising from the pool centre (tapered cylinder, narrow at the base, opening as it rises), crowning in a plume head (a cluster of 3–5 small spheres / a flared inverted cone), with 4–6 falling arcs of spray around it (thin tilted cylinders or short tube/lathe segments) arcing outward and down back into the pool, plus a few droplet spheres near the pool surface. Water paint throughout; the plume head may use the water paint's light end more (it is the brightest thing). Total height ≤ the current hand's height so the common scale in `relicGeometry` does not shrink every relic (measure: print each shape's bounding-box height before/after and put the table in the report).

### C. Genesis — barbed arrow on the island
Keep the two-tier island (beach + grass). Replace the tree (trunk + ball canopy) with an upright BARBED ARROW planted in the mound, crimson: a slender shaft, a sharp conical head pointing UP, and two swept-back barbs beneath the head (flat triangular prisms angled down and out, so the silhouette reads "barbed" from the isometric camera and in the 32 px icon). Fletching at the shaft foot is optional. The arrow is the prominent element (taller than the tree was, within the height cap in B).

### D. Quake — sound waves, not rings
Keep the rock slab and the crimson epicentre dome. Replace the three closed tori with SOUND WAVES: two mirrored fans of three nested ARCS (TorusGeometry with the `arc` parameter, roughly a quarter to a third turn each), standing UPRIGHT in a vertical plane through the epicentre, opening away from it on either side — the ")))•(((" glyph in 3D. Each successive arc is larger and taller. Arcs must not close into rings and must not lie flat (flat arcs read as concentric circles again from above). Check the reference of the current look: /mnt/e/Development/Projects/Terrace/.claude/orchestration/refs/relics/quake-in-game-2026-09-05.png.

### E. Titan's Hand — a strong, high-resolution hand
Replace the box hand with a modelled one, palm toward the viewer, fingers up, amber paint as now: a tapered wrist (cylinder), a palm with rounded edges (extruded rounded-rectangle Shape or a box with beveled/rounded sides), four fingers each of THREE phalanges (capsules or cylinder segments with sphere knuckles, slight natural curl and length variation: middle longest), a thumb of two segments splayed out and slightly forward, knuckle bulges at the palm top. Use higher segment counts than the other relics (a named constant, e.g. HAND_SEGMENTS) so the derivative-shaded faces read smooth and muscular. Budget: keep the merged hand under roughly 4 000 triangles (state the count). It should read as a powerful, deliberate hand, not a mitten.

## Constraints that hold for all of B–E
- Every relic stays exactly ONE merged BufferGeometry (plus its spire). Keep `applyPaint`/`Part` contract; add paints to RELIC_PALETTE only if genuinely needed (relics.py reads it).
- Named constants for every dimension that encodes a design decision; no magic numbers in builders beyond obvious geometry literals already in the file's idiom.
- Mirror each builder in relics.py, regenerate, and confirm the regenerated RelicIcons.tsx typechecks. Look at preview.html (render it to PNG via the harness below) — each icon must still read at 38 px.
- Keep the tile, hover, bob, spin and pick behaviour unchanged.

## Verification (no app start)
1. `pnpm typecheck` from the worktree root; `cd plugins/relics && timeout 240 npx vitest run` — all green.
2. Standalone render harness under /mnt/e/Development/Projects/Terrace/.claude/worktrees/relics-art-p2/.relics-harness/ (project dot-dir, never $HOME, never the session scratchpad): a static HTML page that imports three from the worktree's node_modules (import map or `python3 -m http.server` from a directory with a symlink), builds all five relics with `relicGeometry` + `createGemMaterial`, adds their spires, stands them on a flat green plane at the game's default camera pitch (see client/src/render/ for the orbit defaults — cite the file:line you took them from), and renders. Because relicShapes.ts is TypeScript, bundle it for the harness with the worktree's existing esbuild/vite (`npx esbuild --bundle --format=esm` is fine; `vite build` of the CLIENT is not) — do not add dependencies.
3. Screenshot with an existing headless Chromium: look in ~/.cache/ms-playwright, `which chromium chromium-browser google-chrome`, and `find /mnt/e/Development/Projects/Terrace -maxdepth 4 -name "chrome-headless-shell*"`; drive it with `--headless --screenshot`. If none exists anywhere, say so and stop at the harness (report that the render step is blocked), do not install one.
4. Produce PNGs under .relics-harness/shots/: (a) all five relics in a row with spires, camera at game pitch, from ~30 world units; (b) one close-up per relic (five PNGs); (c) preview.html of the regenerated icons at 4× zoom. Look at every PNG yourself before reporting; fix what looks wrong.

## Report
Write .claude/orchestration/briefs/relics-art-p2-report.md (in the MAIN checkout's path is fine to write? NO — write it inside the worktree at the same relative path and commit it). Contents: commit hashes; the shape-height table (before/after, and the resulting common scale); triangle counts per relic; spire design constants and the fog decision; absolute PNG paths with one line each on what they show; anything you could not do and why. Keep it under a page.
