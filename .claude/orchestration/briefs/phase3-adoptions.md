# Phase 3 (ii) brief — cloud decks, ground shade, reveal clip across the six sky plugins (#284)

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12`
(branch `worktree-agent-a63416ea19b8c4c12`, rebased onto main 700d927; sequence (i) is
its top three commits). First action: `EnterWorktree({ path: "<that path>" })`. Paths
below are relative to the worktree root. Commit as you go (conventional commits, no
attribution footers, stage exact paths only). Do NOT merge to main.

Read first (binding — owner decisions, do not relitigate):
- `/mnt/e/Development/Projects/Terrace/.claude/plans/weather-clouds-shadow-reveal-clip.md`
  (absolute; untracked in main). §3 is your scope; §4 the budget; §5 the gates; §7 the
  decided punts; §8 the five decisions.
- `.claude/orchestration/briefs/phase3-core-report.md` (in the worktree) — the API you
  consume, with `file:line`; its "What sequence (ii) must know" list is binding.
- `client/src/plugins/kit/puffDeck.ts`, `discRig.ts`, `discSystemsView.ts`,
  `precipitation.ts`, `hazeBank.ts`; `plugins/cyclone/client/spiral.ts` + `gloom.ts` +
  `index.ts`; `plugins/{rain,thunderstorm,snow,fog}/client/*`; `plugins/tornado/client/*`;
  `plugins/thunderstorm/server/index.ts:120-140` (strikes).
- `client/test/drawBudget.test.ts`; root `CLAUDE.md`; `docs/DESIGN.md` (140 fps rule).

## Decisions already taken (2026-09-02, owner)
1. Decks are `MeshLambertMaterial` + `onBeforeCompile` (billboard at
   `#include <project_vertex>`, puff mask in the fragment) with a SPHERICAL-BLEND
   normal per puff (plan §3.1 snippet; `PUFF_NORMAL_FLATNESS` named). NOT +Y.
2. **Decks must read as 3D PUFFS, not flat sheets**: several height tiers over a named
   `DECK_THICKNESS_WORLD_UNITS`, fewer/larger toward the top, denser toward the centre,
   per-seed size variation, domed top, flat base the column falls out of. Shots from
   above, from the side at deck height, and from below are gate items.
3. Shade darkness: START at rain 0.25 / thunderstorm 0.45 / snow 0.20 / cyclone 0.15,
   tune by eye in-world on YOUR OWN stack, report the finals.
4. Cyclone converts NOW: its deck material becomes the same Lambert/spherical-normal
   shape; `uDaylight` and `CLOUD_GLOOM_RESPONSE` go (the scene's lights carry the gloom
   to the deck); the spiral LAYOUT and its matrix-on-push design stay exactly as they
   are. Cyclone publishes one shade disc per spiral at `CYCLONE_DECK_HEIGHT_WORLD_UNITS`.
5. `inner` is a FLAT DARK CORE (core report item 1), not an eye hole. Cyclone passes a
   named `CYCLONE_SHADE_CORE_FRACTION`; no eye-hole term is added to the primitive.
6. `thunderstorm:strikes` client message → `world.broadcastVisible` on the strike cell.
   `emitEvent` for fire is UNCHANGED.
7. Fog: clip only, no deck, no shade. Tornado: clip only (snippets), no shade.

## Deliverables
- `client/src/plugins/kit/cumulusDeck.ts`: one `InstancedMesh` per PLUGIN, capacity
  `maxMasses × puffsPerMass`; per-instance static attributes (mass slot, seed, polar
  offset, tier); per-frame `uMasses[maxMasses]` (centre xz, radius, intensity) written
  from the interpolated disc — NO buffer upload in steady state. `applyRevealClip` on
  its material. Exposes `update(slot, disc)`, `park(slot)`, `dispose()`. Kit names no
  plugin; every number is a named constant with its reasoning (puff count from the
  coverage arithmetic in plan §3.1, not copied from the spiral).
- rain / thunderstorm / snow: deck per plugin via the kit; profile constants in each
  `rig.ts`; `publishGroundShade` from the view's interpolated sample;
  `groundShadeBudget = MAX_ACTIVE_SYSTEMS`; `applyRevealClip` on the column material,
  the haze material(s), and (thunderstorm) bolt + glow materials — once per pooled
  material, not per rig. `drawBudget` +1 each; pins in `drawBudget.test.ts` updated
  (permission granted for this arc).
- fog: `applyRevealClip` on its haze materials.
- tornado: clip snippets in cone + debris shaders, `ctx.revealClipUniforms()` merged.
- cyclone: as decision 4 + clip snippets in the spiral shader + `groundShadeBudget =
  MAX_SPIRALS`.
- thunderstorm server: decision 6.

## Hard constraints
- You MAY start/stop your OWN isolated stack from the worktree (owner permission, this
  session). Never the owner's stack, never from the main checkout. Copy
  `.phase2-stack/` (untracked, in the worktree) to `.phase3-stack/`; free port (check
  `ss -ltn`), `WORLDS_DIR` + NONEXISTENT `DB_PATH` under `.phase3-stack/`,
  `WORLD_SIZE=512`, rebuilt `client/dist`. Kill by pid file / port-owner pid from a
  script FILE; NEVER an inline `pkill -f`/`pgrep -f`. Vite on /mnt/e does not watch:
  rebuild before every shot. Tear down when done.
- Tests: ONLY the `drawBudget.test.ts` pin updates and, if the kit deck has pure maths
  worth pinning (tier layout, puff count), ONE short test for it. Nothing else.
- Comments are claims, not evidence; cite `file:line` in the report.
- Plugins never import each other; kit names no plugin.
- Don't touch `docs/**`, `.claude/**` except your report, `shared/**`,
  `client/src/render/**` (sequence (i) is done; if you NEED a change there, stop and
  say so in the report rather than making it), `plugins/weather/**`.

## Gates (in the worktree, before you report)
- `pnpm typecheck` clean; client suite green except the pre-existing
  `vertexGrid.test.ts > keeps walls attributed to the higher cell` (not yours).
- `git diff --stat main...HEAD` shows only sequence (i)'s files plus yours.
- In-world shots to `.verify-shots/phase3/`, each named for the plan §5 letter:
  (a) rain deck + column + shadow at noon — FROM ABOVE, FROM THE SIDE AT DECK HEIGHT,
  FROM BELOW; (b) same at a low sun, shadow displaced; (c) thunderstorm deck lit by its
  own flash; (d) snow deck; (e) a mass straddling the frontier; (f) a mass at the world
  edge; (g) cyclone spiral clipped at the frontier, Lambert-lit; (h) tornado clipped.
  Use `<PLUGIN>_DEV_FORCE=1` (phase1 report §12) and the daynight plugin's time
  control for the low sun (find it; if none exists, say so and shoot at whatever
  elevation you can reach).
- Fill-rate (plan §4): headless SwiftShader CANNOT measure GPU fill-rate honestly, so
  report the ANALYTIC overdraw instead — puffs on screen × mean screen coverage per
  puff, camera under a rain deck, under a thunderstorm deck, under the cyclone — plus
  `renderer.info.render` calls/triangles for each. The owner measures fps on their
  machine.

## Report
`.claude/orchestration/briefs/phase3-adoptions-report.md` in the worktree: commits;
final tuned values with the shots that justify them; per-plugin draw budgets before /
after; the overdraw table; every deviation with reason; anything the owner must decide
before merge.
