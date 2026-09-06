# Brief — HUD modeler dock: icons, width slider, centred over the toolbar

Owner request (2026-09-04): "proceed with the center HUD change for sculpt
pyro and temple. Swap tool so that instead of text, it uses an icon. For the
brush, turn it into a slider that goes from least to most values with stops
for the two center values. Change the soft and hard to also be icons. And
change the mode to be an icon."

Approved design mockup (read it before coding, it is the spec for the look):
https://claude.ai/code/artifact/d8db9fe4-7387-4f3b-83e4-7f9a8fb5706f

## What changes

1. **Location.** The brush panel (`client/src/ui/Hud.tsx`, the
   `.hud-panel.hud-anchor-bottom-left` block) moves out of the bottom-left
   grid cell into `.hud-bottom-center`, ABOVE the `<Toolbar />`. That cell is
   `column-reverse` (hud.css), so the dock is rendered AFTER the toolbar in
   DOM order to appear above it. It is shown only while the sculpt tool is
   held: `activeToolId() === SCULPT_TOOL_ID` (`client/src/plugins/toolbar.ts`).
   Pyro and Temple have no settings, so with them held the toolbar sits alone.
   The bottom-left grid cell becomes empty; keep the strip's grid as is.
2. **Tool row → icons.** Stamp, Smooth, Pull, Carve become icon-only tiles.
   Icon art is FINISHED and lives in
   `.claude/orchestration/refs/hud-icons/{stamp,smooth,pull,carve}.svg`.
   Convert each into a Solid component in a new file
   `client/src/ui/BrushIcons.tsx` (components only, per project rule; the
   `.svg` files stay as the design source, do not import them at runtime).
   Keep every gradient id exactly as in the files — they are prefixed per icon
   because SVG ids are document-global. Keep `aria-label` and `title`
   (TOOL_LABEL / TOOL_TITLE) on the buttons; the label text is no longer
   rendered.
3. **Edge row → icons.** `soft.svg`, `hard.svg`, same treatment;
   PROFILE_LABEL/PROFILE_TITLE stay on the buttons.
4. **Mode → icon.** The `.mode-value` pill keeps its two colour states (accent
   green raise / `--hud-lower` orange lower) and becomes a round icon button:
   `raise.svg` when raising, `lower.svg` when lowering. `aria-label` and
   `modeTitle` stay. Visibility rules for Edge and Mode rows are unchanged
   (`TOOLS_WITHOUT_EDGE_PROFILE`, `TOOLS_WITHOUT_DIRECTION` from shared).
5. **Brush width → slider.** Replace the five width buttons with a native
   `<input type="range" min="0" max="4" step="1">` whose value is the INDEX
   into `BRUSH_RADII` (`client/src/state/hudState.ts`), so it snaps to the
   five rungs and the keyboard works. `setBrushRadius(BRUSH_RADII[index])`
   on input. The ends are captioned with `brushWidthWorldUnits` of the first
   and last rung; the current width is shown under the thumb. Draw five
   detents on the track (one per rung; the mockup grows each detent's ring
   with the rung). `aria-valuetext` = `${width} world units`. Style the
   native range (track, thumb, `::-webkit-slider-*` and `::-moz-range-*`)
   on the existing HUD tokens in `client/src/ui/hud.css`.
6. **Row labels** ("Brush", "Tool", "Edge", "Mode") are dropped: every control
   carries its own title/aria-label. Remove the now-dead `.hud-label` rules
   that only served this panel; keep the ones other panels use (grep first).
7. **Chrome.** Reuse `.brush-picker` wells and `.brush-button` (square 34px
   variant holding a 26px icon) rather than inventing new classes; delete
   `.brush-button-wide` only if nothing else uses it (grep). The dock wears
   `--hud-glass` like the toolbar. Narrow-screen (`@media (max-width: 640px)`)
   rules: the dock is already icon-only, so update the media block so the
   strip still fits 390px — the dock and toolbar stack in the centre cell.

## Rules (binding)

- SolidJS: never store a reactive read in a component-body `const`; call
  accessors inline in JSX (Hud.tsx's own header rule).
- TypeScript strict; no `any`. Named exports. A `.tsx` exports only
  components (+ types).
- Do NOT write or add tests (owner rule; permission not granted). Run the
  existing client tests: `timeout 300 pnpm --filter ./client test` (never the
  whole workspace) and `pnpm typecheck`. Both must pass.
- Do not touch `shared/`, plugins, or any file outside `client/src/ui/`,
  `client/src/ui/hud.css`, and (only if a hook is needed) `client/src/plugins/toolbar.ts`.
- Keep existing comments; when you change behaviour a comment describes,
  rewrite that comment so it stays true. Comments are claims: verify against
  code, cite `file:line` in your report.
- Commit in your worktree branch with a conventional message
  (`feat(hud): ...`), no attribution lines. Stage exact paths only.
- Do not start the app or Vite. Do not screenshot. The orchestrator verifies
  visually after merge.

## Report

Return: commit hash, files changed with line counts, the `pnpm typecheck` and
client test output tails, and for each of items 1–7 the `file:line` where it
is implemented. Flag anything you could not do and why.
