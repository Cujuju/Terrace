# Brief — celestial background outside the map (arc `celestial-void`, GH #326)

You are a fresh Opus implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/celestial-void`
(branch `celestial-void`, forked from main). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/celestial-void" })`.
`node_modules` is missing there: run `pnpm install --offline` in the worktree
root in the background and poll (it can take minutes on this drive). Paths
below are relative to the worktree root. Commit to the worktree branch as you
go (conventional commits, first line < 72 chars, no attribution footers, stage
exact paths only). Do NOT merge to main. Do NOT start or stop any app stack.
Do NOT touch `docs/**`, `shared/**`, `plugins/**`, or `.claude/**` except
your report. Do NOT add tests (owner rule; permission not granted). Do NOT
install dependencies.

## The owner's ask (verbatim, three messages)

> I want to change what we render outside of the map. We currently use a flat
> color that matches essentially the sky. I would like to do some sort of
> swirling celestial animation that looks more like we are a plot among the
> stars.

> I don't want it to change based on time of day. I only want time of day to
> affect the night and day rendering on map. Off map I want it to continue to
> show the same look.

> Give me both concepts as a configuration option. [...] the star wheel needs
> the stars to actually rotate [...] It just needs to be a circular motion.
> preferably rendered at something like a thirty to forty five degree angle.

Owner chose: **per-player preference**, localStorage-backed like the existing
control prefs, switchable at runtime from the HUD controls panel. Default:
Star Wheel.

## Deliverable

1. A fullscreen background pass drawing one of two GLSL looks, `nebula` or
   `wheel`, behind everything else. Reference shaders (approved visuals):
   `.claude/orchestration/refs/celestial-void-shaders.glsl`. Port them
   faithfully; the numbers in them are the approved look. Every literal that
   is a design decision becomes a named constant (the refs already name the
   wheel's). Wheel default tilt: 60° (owner revised 2026-09-04). Rotation direction, steady stars, 3x drift and screen-wide wheel stars per the refs file, revision 5 (four-armed spiral-galaxy wheel, WHEEL_RATE -0.04).
2. A per-player pref `voidStyle: 'nebula' | 'wheel'` with a `<select>` in
   `client/src/ui/ControlsPanel.tsx`, persisted under a versioned
   localStorage key, applied live (no reload).
3. Time of day must not touch the background at all.

## Mechanism, verified from source this session (re-verify yourself, cite file:line)

- `client/src/render/scene.ts:247` — `scene.background = new Color(SKY_COLOR)`.
  `SKY_COLOR` (`scene.ts:50`) is also the hemisphere light's sky term
  (`scene.ts:257`) and the frontier fog's top-row tint
  (`client/src/render/frontierFog.ts:98,181`). Keep the hemisphere use
  exactly as is: the map's lighting is not part of this arc.
- `client/src/render/skyRig.ts:60-63` — `applySkyRig` writes
  `state.backgroundColor` onto `scene.background` ONLY IF it is a `Color`
  (`instanceof` guard, documented as "a background that somehow became a
  Texture is simply left alone"). So once `scene.background` is no longer a
  Color, the day/night plugin (`plugins/daynight/client/sky.ts:260`) and the
  cyclone gloom (`plugins/cyclone/client/gloom.ts:154`) keep computing
  `backgroundColor` and it is ignored — which is exactly the owner's rule.
  Do NOT edit `plugins/**` or `SkyRigState`; update the comment in
  `skyRig.ts` so it states the new truth (core now owns the background and
  the field is intentionally unused by core) rather than "a defensive no-op".
- Render loop: `scene.ts:361-383` (`renderFrame` → `renderer.render(scene,
  camera)`). No `scene.fog`. Renderer uses ACES tone mapping + exposure
  (`scene.ts:237-243`) — the shader output will pass through it; compensate
  in the material (`toneMapped: false` on the ShaderMaterial is the direct
  way) so the approved colours survive.
- Existing pref pattern: `client/src/state/controlPrefs.ts:110-160,178-205,
  226-255` — three copies of "versioned localStorage key + module-scope
  signal + setter that persists". Panel: `client/src/ui/ControlsPanel.tsx:91-`.
- Previews (`client/src/preview*.ts`, e.g. `previewWater.ts:178,205`) build
  their own `Scene`s and are NOT touched by this arc.
- three `^0.185.1` (`client/package.json:17`).

## Design decisions (settled — implement, don't relitigate)

- **Where the pass lives.** New module `client/src/render/celestialVoid.ts`
  exporting `createCelestialVoid(viewport): CelestialVoid` with `setStyle`,
  `dispose`. Implementation choice is yours between (a) a camera-following
  back-face sphere/box mesh with a `ShaderMaterial` (`depthWrite:false`,
  `depthTest:false`, `frustumCulled:false`, lowest `renderOrder`) or (b) a
  fullscreen triangle rendered before the main scene with `autoClear`
  managed. Pick the one that needs the least code in `scene.ts`; say why in
  the module comment. `scene.background` becomes `null` and the `new
  Color(SKY_COLOR)` line goes away.
- **Anchoring.** Camera-anchored: the shader sees view direction, so orbiting
  rotates the sky like a skybox and panning does not move it. For the wheel,
  keep the hub on the view axis exactly as the reference does (the ray/plane
  math is in screen space; do not re-derive it in world space).
- **Time.** One `u_time` in seconds from a monotonic clock started at module
  load, advanced from the render loop's `dt` (so a paused tab does not jump).
  Honour `prefers-reduced-motion: reduce` by freezing `u_time`.
- **Pref contract, not a fourth copy.** Add
  `client/src/state/persistedChoice.ts`: one small helper
  `persistedChoice<T extends string>(key, allowed: readonly T[], fallback)`
  returning `[accessor, setter]` with the same load/validate/save behaviour
  the three existing prefs have. Use it for the new `voidStyle` pref in
  `client/src/state/voidPrefs.ts`. Leave the three existing prefs untouched
  (focused PR) and note in your report that they are candidates to migrate.
- **Frontier fog tint.** `frontierFog.ts:181` lightens `SKY_COLOR` for the
  top row so the mist dissolves into the sky. With a dark void behind it, a
  pale top row will read as a white wall. Replace with a named constant
  `VOID_HAZE_COLOR` exported from `celestialVoid.ts` (the mean colour of the
  looks, roughly the nebula's `deep`/the wheel's base — pick one value and
  justify it) and blend toward that instead. Take an in-world screenshot
  showing a frontier edge against the void for both styles.
- **Budget.** ≥ 140 fps on the owner's machine (~7 ms/frame,
  `docs/DESIGN.md:27`). Measure the pass on your GPU with
  `EXT_disjoint_timer_query_webgl2` if available, else with the perf-probe
  approach in `client/test/zz-perf-probe.test.ts`; report ms at the canvas
  resolution you measured. If the nebula exceeds 1.5 ms at 1440p, render the
  pass to a half-resolution target and upscale; otherwise do not add that
  machinery.
- **Panel copy.** Label "Beyond the map", options "Star wheel" / "Nebula".
  Hook into `resetBindings` only if the panel's reset button is documented as
  resetting every pref in the panel — read `ControlsPanel.tsx:195-201` and
  decide; state the decision in the report.

## Verification you must do before reporting

- `pnpm --filter client typecheck` (or the client package's script) passes.
  Run only client tests, with a timeout; never `pnpm -r test`.
- In-world screenshots (the run skill / existing `.peek*.mjs` scripts show
  how the app is driven; you may START a dev client/server only if the owner's
  rule in CLAUDE.md is satisfied — it is not; so instead capture via a
  standalone harness that mounts `createViewport` + the void pass on a
  canvas, or use the previews pattern). Three images minimum: nebula, wheel
  at 35°, and a frontier edge. Put them under `.celestial-shots/` in the
  worktree (not `$HOME`), untracked.
- Confirm by grep that nothing else in `client/src` reads `scene.background`
  as a `Color` at runtime after your change.

## Report

Write `.claude/orchestration/briefs/celestial-void-report.md` in the worktree
(commit it): commits on the branch, file:line for each mechanism claim you
relied on, measured pass cost with resolution and GPU, screenshot paths, the
reset-button decision, and anything you left out and why.
