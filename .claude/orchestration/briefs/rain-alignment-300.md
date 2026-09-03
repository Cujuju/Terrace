# Brief — #300 rain column not aligned with its cloud deck

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/agent-a63416ea19b8c4c12`
(branch `worktree-agent-a63416ea19b8c4c12`, at fe93ae3; main is f72a6ae = fe93ae3 +
one docs commit). First action: `EnterWorktree({ path: "<that path>" })`, then
`git merge --ff-only main` inside it. Paths below are relative to the worktree root.
Commit to the worktree branch as you go (conventional commits, first line < 72
chars, NO attribution footers, stage exact paths only). Do NOT merge to main.

Read first (binding): root `CLAUDE.md`; `docs/decisions/weather-clouds-shadow-reveal-clip.md`
if it exists; `.claude/plans/weather-clouds-shadow-reveal-clip.md` §3.

## The defect (owner, 2026-09-02): "Rainstorms don't have the rain completely aligned
with the clouds." Two verified mechanisms, both in the kit. Fix both. Verify each
from source lines yourself before touching them; cite `file:line` in the report.

### A. The column's POSITION double-counts the wind
`client/src/plugins/kit/precipitation.ts:280,285`: `x = discX*radius + vx*aloft`.
The rig root already moves with the mass (`kit/discRig.ts:149`), so a drop that
also drifts by `vx*aloft` in the rig's local space moves at TWICE the wind over the
ground and the column's foot lands downwind of the cloud. Magnitude today: wind is
0.6–2 world units/s (`plugins/weather/server/wind.ts:39-40`); rain fall time
28/26 s → foot up to 2.15 wu (8.6 cells) downwind against a 6–14 cell radius;
snow (fallSpeed 3.2) → up to 17.5 wu (70 cells): the snow column can sit entirely
outside its cloud.

Physics we want: a drop leaves the cloud with the cloud's velocity and the air it
falls through moves with the cloud, so IN THE CLOUD'S FRAME it falls straight
down; its ground-frame velocity is (vx, −fallSpeed, vy), which is what the STREAK
should show. So: keep the streak direction exactly as it is (`streakX/Y/Z`), and
remove the `vx*aloft` / `vy*aloft` terms from the position. Keep sway. Keep
`driftSeconds` exported (a test uses it; `plugins/rain/test/client.test.ts:224`);
rewrite its doc and the `advance` doc to say what is now true. Update the file's
header/comments that describe the shear. Do not delete other lines.

### B. Deck vs column draw order is decided by three's centre-distance sort
The deck (`kit/cumulusDeck.ts:579`, one InstancedMesh for every mass, position =
world origin) and the column/haze (`kit/discRig.ts:119,122`) all use
`DISC_RENDER_ORDER = 1` (`discRig.ts:50`) with `depthWrite:false`. At equal
renderOrder three sorts transparent objects by their object-centre view depth,
so whether rain draws OVER the cloud depends on where the world origin is
relative to the mass — arbitrary. Shots `.verify-shots/phase3/a-rain-deck-above.png`
and `a-rain-deck-side.png` show streaks painted on the cloud's face.

Geometry that makes the fix exact: every column particle is at Y ≤ CLOUD_BASE_WORLD_Y
= DECK_BASE_WORLD_Y and every haze sheet is far below it; every puff is at Y ≥ the
base. So for a camera ABOVE the base plane, on any ray a puff is always nearer
than a column particle → draw column/haze first, deck after. For a camera BELOW
the base plane, a column particle is always nearer → deck first, rig parts after.
One boolean per frame: `camera.y >= DECK_BASE_WORLD_Y`.

Implement:
1. `ClientPluginCtx` (client/src/plugins/types.ts) gains ONE read-only accessor
   for the camera's world position, implemented in `client/src/plugins/host.ts`
   from `viewport.camera` (see host.ts:339 for how it is reached). Return a
   readonly `{x,y,z}` written into a reused scratch object, no allocation per
   call. Doc it like the neighbouring accessors. Search every test fake of
   ClientPluginCtx (`grep -rn "ClientPluginCtx" client/test plugins/*/test`) and
   add the accessor there if a fake enumerates the interface (do not weaken types
   to dodge this).
2. Two named constants in `kit/cumulusDeck.ts` (or discRig.ts — wherever the
   ordering contract is stated), defined RELATIVE to `DISC_RENDER_ORDER`, for the
   deck's order with the camera above vs below the base; all values must stay
   positive (the sea sits at 0 — see the doc on `DISC_RENDER_ORDER`). Bumping
   `DISC_RENDER_ORDER` itself is allowed if needed; check the other plugins'
   `*_RENDER_ORDER` constants (grep) and state in the report what changes
   relative order with them and why that is acceptable.
3. The deck exposes one method that takes the camera Y and sets `mesh.renderOrder`
   accordingly. It must be called ONCE per frame from ONE place for all three deck
   users (rain, snow, thunderstorm) — not three copies in three plugins'
   `frameExtras`. Preferred: `DiscSystemsViewSpec` (kit/discSystemsView.ts)
   accepts an optional `deck`, and `renderFrame` calls it with `ctx`'s camera Y
   before the rigs update. If you find a cleaner single point, use it and say why.
   Cyclone uses no deck; nothing there changes.
4. Doc comments on every touched contract explain the plane argument above in
   the file's own voice (see how cumulusDeck.ts writes its rationale).

## Constraints
- Tests: do NOT add or write tests (owner rule, per session). Existing tests
  must pass: `pnpm --filter <pkg> test` for client, rain, snow, thunderstorm, with a
  timeout; NEVER `pnpm -r test` / whole-workspace. `pnpm typecheck` must pass.
  If an existing test pins the removed shear, report it — do not rewrite the test.
- No new dependencies. No magic numbers. Erasable TS only. No `any`.
- Don't touch `docs/DESIGN.md`, `docs/decisions/*`, `.claude/**` except your report.
- Comments are claims, not evidence.

## In-world verification (required, capped)
You MAY run your OWN isolated stack from the worktree (owner permission for this
session), never the owner's. Template: `.phase3-stack/launch.sh`, `stop.sh`,
`shot.mjs` (untracked, in the worktree). Verification stacks run Vite DEV, never
`vite build`. Pick a free port (`ss -ltn`), `WORLDS_DIR` + nonexistent `DB_PATH`
under `.phase3-stack/`. Kill by pid file only, never inline `pkill -f`. Tear down
when done. HARD CAP: 20 minutes wall clock on the stack+shots. If the browser or
stack is not producing shots by then, stop, tear down, and report "shots not
taken" with what blocked you. Do not retry SwiftShader tuning.
Shots wanted, saved to `.verify-shots/rain-300/`: (1) rain deck from above,
(2) rain deck from the side near cloud height, (3) the same side view from well
below the cloud base. Rain is forced via the rain plugin's dev switch (find it in
`plugins/rain/server/dev.ts`; report the variable).

## Report
Write `.claude/orchestration/briefs/rain-alignment-300-report.md`: commits, per-item
`file:line` evidence, test/typecheck output tail, the render-order table
(before/after, every `*_RENDER_ORDER` constant), shot paths or the blocker, and
anything you deliberately left undone. Then stop; do not merge.
