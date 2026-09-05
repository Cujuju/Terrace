# Brief: rain and snow storms cover 3× the area at spawn

Owner ask (2026-09-04): "grow the size of the rain and snowstorms. I want them
to cover three times as much area when they spawn." Rain and snow ONLY. Fog and
thunderstorm keep their current footprint.

## Where the size lives

- `server/src/plugins/kit/discSystems.ts` — the shared disc engine used by
  rain, snow, fog and thunderstorm. The radius band is
  `DISC_SYSTEM_MIN_RADIUS_CELLS` / `DISC_SYSTEM_MAX_RADIUS_CELLS` (cellsAcross
  24 / 56 world units), clamped by `discMaxRadiusFor` via
  `DISC_MAX_RADIUS_WORLD_FRACTION` (0.35). The spec is `DiscSystemsSpec`
  (coverageFraction, maxActiveSystems, random, siting?, onUnsited?). The cap
  is DERIVED from coverageFraction and the mean disc area (E[r²]) — read
  `capFor` and the comments above it before touching anything.
- `plugins/rain/server/index.ts:95` and `plugins/snow/server/index.ts:93` —
  the two `createDiscSystems({...})` calls that must change.
- `plugins/rain/protocol.ts` / `plugins/snow/protocol.ts` — coverage
  fractions (0.09 / 0.027) and `MAX_ACTIVE_SYSTEMS` (7 / 2), with rationale.
- `plugins/rain/client/rig.ts`, `plugins/snow/client/rig.ts` — the client
  draws the disc from the radius on the wire. rig.ts:36 mentions a puff budget
  of 900 "over a system's disc, which is 1 800 cells² at the minimum radius":
  find every per-system budget that assumes the old radius band.
- `plugins/snow/server/siting.ts` — samples ground at half the candidate
  radius; a bigger radius changes how often a site is refused and handed off
  to rain (`onUnsited`).

## Requirements

1. Area ×3 per storm ⇒ radius × √3 for rain and snow discs. Do it at the
   CONTRACT layer: add a per-population option to `DiscSystemsSpec` (name it
   for the decision — it is an AREA scale, the kit derives the radius
   factor), default 1, so fog/thunderstorm are byte-for-byte unchanged. No
   magic numbers: the 3 is a named constant in each of rain and snow's
   protocol.ts with a comment citing the owner's 2026-09-04 ask.
2. The NUMBER of storms in the sky must not change. Today the cap falls out
   of coverage ÷ mean area; if you leave that alone, tripling the area cuts
   the count to a third. Decide how the derivation stays honest (scale the
   coverage the cap is derived from, or derive the cap from the unscaled
   area) and keep every rationale comment in protocol.ts / discSystems.ts
   TRUE after your change — rewrite the ones your change falsifies.
   Assumption to state in your report: the owner wants bigger storms, not
   fewer. Flag it.
3. `DISC_MAX_RADIUS_WORLD_FRACTION` must still bind on a 128-unit world.
   Compute and report the new radius band in cells on the shipped world and
   on a 128-unit one.
4. Client rigs: whatever per-system particle / puff / instance budget exists,
   decide whether density per cell or count per system is the invariant, keep
   the 140 fps benchmark in mind (≈7 ms frame budget), and say which you
   chose and why. Tripling a per-system count is a cost; halving density is
   a visible thinning. Report the numbers.
5. Determinism rules in `docs/DESIGN.md` and `docs/decisions/storms-and-mudslides.md`
   apply. Read them first. Do not append to either.
6. Tests: do NOT add new tests (owner rule). Update existing assertions only
   where they encode the old radius band or cap, and list each one you
   touched with file:line and the old/new expectation.

## Verify (all must pass; use timeouts, never `pnpm -r test`)

- `pnpm typecheck`
- `timeout 300 pnpm --filter ./plugins/rain test`
- `timeout 300 pnpm --filter ./plugins/snow test`
- `timeout 300 pnpm --filter ./plugins/fog test` and `./plugins/thunderstorm`
  — unchanged behaviour
- `timeout 300 pnpm --filter ./server test`

## Rules

- You are in a git worktree. Commit there with a conventional-commit message
  (no attribution trailers), then call `ExitWorktree` with `action: "keep"`.
  Do NOT merge into main.
- Never start or stop the app (server or client). No screenshots.
- Stage only your exact paths.
- Comments are claims, not evidence: verify every mechanism you rely on at
  file:line and cite it in the report.

## Report (write to `.claude/orchestration/briefs/storms-triple-area-report.md`)

- Commit hash and branch.
- The contract change (spec field, kit math) with file:line.
- Old → new radius band (cells) on the 2048-cell world and a 128-unit world.
- How the storm count was kept, with the before/after `capFor` values for
  rain and snow.
- Client budget decision and numbers.
- Every rationale comment rewritten, every test assertion changed.
- Assumptions and anything you left undone, explicitly.
