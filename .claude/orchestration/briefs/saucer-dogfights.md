# Brief — flying-saucer dogfights (arc `saucers`)

You are a fresh Opus implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/saucers`
(branch `saucers`, forked from main at 4ad45f5). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/saucers" })`.
If `node_modules` is missing in the worktree, run `pnpm install --offline`
there (slow on this drive; run in background and poll). Paths below are
relative to the worktree root. Commit to the worktree branch as you go
(conventional commits, first line < 72 chars, NO attribution footers or
Co-Authored-By, stage exact paths only — never `git add -A`). Do NOT merge
to main. Do NOT start, restart or stop any app stack (server or Vite) —
owner rule. Do NOT touch `docs/**`, `shared/**`, `.claude/**` (except your
report), or any existing plugin's files. You add ONE new plugin
`plugins/saucers/` plus the one-line registrations it needs in
`client/src/plugins/registry.ts` and wherever the server discovers plugins
(find it: grep how `monsters` is registered on the server side, and the
pnpm workspace globs — `pnpm-workspace.yaml`).

OWNER RULE — NO TESTS: do not add or write any test files. Verify with
`pnpm --filter @terrace/plugin-saucers typecheck` and `pnpm typecheck`
at the root (never `pnpm -r test` — it hangs). Existing package tests you
did not touch are not yours.

## The owner's ask (verbatim)

> create flying saucer dog fights in the air where the flying saucers fly
> into the map, dog fight, and the winner takes off while the loser crashes
> and explodes, leaving behind a crater and fire. The saucers should fly at
> high speed, like they're zooming in, battling, and then zooming out.

## Read first (settled rules — do not relitigate)

- `CLAUDE.md` (root), `docs/DESIGN.md`, `docs/decisions/plugin-host.md`,
  `docs/decisions/monsters.md`, `docs/decisions/mesh-budgets.md`,
  `docs/model-assets.md`.
- `plugins/monsters/` end to end — it is the TEMPLATE: server-authoritative
  entity list, ONE full-state broadcast message (`monsters:state` shape),
  client that draws only what the server says, interpolates between
  broadcasts (`client/src/plugins/kit/interpolator.ts`,
  `viewReconcile.ts`), cosmetic-only client animation. Copy its
  package.json / tsconfig.json / vitest.config.ts shape for the new
  package `@terrace/plugin-saucers`.
- `plugins/boats/client/models.ts` + `client/src/render/rigAsset.ts` +
  `client/src/render/rigSkin.ts` — how an authored `.glb` is preloaded
  (`preload()` on the client plugin, `.glb?url` import, `loadRigAsset`,
  `bakeRig`, `asset.node(name)`, `asset.anchor(name)`).
- `server/src/plugins/types.ts` `WorldApi` — `sculpt(x, y, radius, amount)`
  (the crater), `heightAt`, `sibling(name)`, `simMillis`, `difficulty`,
  broadcast/keepalive patterns (~line 198-210, 701).
- `plugins/fire/server/index.ts` `igniteAt(x, y)` — reach it ONLY through
  `world.sibling('fire')` with duck-typing and buffer-don't-drop, per
  plugin-host.md. Fire not installed → a crater with no flames, no throw.
- Verify every mechanism above from file:line yourself; comments are
  claims, not evidence.

## Design (decided; implement this)

Server (`plugins/saucers/server/`, deterministic, integer-ish, fixed
iteration order — same bar as monsters):

- An ENCOUNTER is the unit: rolled on a cadence read from `difficulty`
  (interpolate between two named anchors at 1 and 100, like mana). At most
  one encounter alive at a time (named constant). Admin/test trigger:
  accept a client→server message `saucers:summon` gated exactly the way
  monsters gates its admin summon (find it in monsters/server/index.ts).
- Encounter phases, each a named-constant duration: `approach` (two
  saucers enter from opposite map edges at HIGH speed toward an arena
  centre chosen over unlocked land, well above terrain — say a named
  `CRUISE_ALTITUDE_BANDS` over the local max height), `dogfight` (both
  orbit/weave the arena centre with fast heading changes, firing lasers in
  bursts; server tracks each saucer's `hp`, laser hits decrement it — the
  outcome is deterministic from the encounter's seeded RNG (copy
  monsters/server/rng.ts's approach), NOT Math.random), `resolve` (the
  loser dives on a steep line to a crash cell; the winner climbs and exits
  at high speed off a map edge), `aftermath` (crash: ONE `world.sculpt`
  crater of named radius/depth at the crash cell, then `igniteAt` a small
  ring of cells around it via the fire sibling; the encounter ends and the
  list empties).
- Tick from the plugin's `onTick`-equivalent at the host cadence; broadcast
  full state at the host's moving-entity cadence (copy monsters' choice).
  Wire payload per saucer: `id`, `variant` (0|1|2 — three models), `x`,
  `y` (cells, may be fractional on the wire like monsters if it does that;
  otherwise fixed-point ints), `alt` (world Y), `heading` (radians or
  turns), `speed`, `phase`, `hp`, plus a `lasers` list of active bolts
  `{from:id, to:id, t0}` and, at aftermath, `crash: {x, y, at}`. Keep the
  protocol in `plugins/saucers/protocol.ts`, dependency-free, one message
  type carrying FULL state, an empty list meaning "nothing to draw".
- Persistence: an encounter is transient — do NOT persist it. On
  onWorldCreate the list is empty. Craters persist because terrain
  persists; fire persists because fire does.
- Crash cell must be unlocked, on land, not water (use `heightAt` against
  the sea level constant shared/ exports — find it), and not inside any
  protection another plugin exposes via the deny-chain in types.ts ~573
  (read what monsters/structures do; if the deny chain rejects the sculpt,
  pick the next candidate cell from the seeded RNG, bounded attempts).

Client (`plugins/saucers/client/`, cosmetic only):

- `preload()` loads three GLBs: `plugins/saucers/client/assets/saucer-a.glb`,
  `saucer-b.glb`, `saucer-c.glb`. THE ORCHESTRATOR IS AUTHORING THESE IN
  BLENDER RIGHT NOW and will drop them into your worktree; until they
  exist, build against a PROCEDURAL FALLBACK (a flattened sphere + dome +
  ring torus from three primitives) behind the same interface, selected
  when the `.glb?url` import fails to resolve at preload — and leave a
  `// TODO(saucers): remove fallback once assets land` marker. Asset
  convention (docs/model-assets.md): units = cells, Y up, forward = +X,
  origin at the hull's centre-bottom, authored outer diameter 4 cells.
  Node names you MUST use, exactly: meshes `hull`, `ring` (spins about
  local Y — the animated part), `dome`, `lights` (emissive strip; flash
  by modulating emissive intensity); Empties `muzzle` (laser origin, on
  the underside) and `top`. One material per mesh.
- Per-frame from the frame clock: interpolate position/heading (kit
  interpolator), bank into turns, spin `ring` continuously (named rad/s),
  flash `lights` on a named cadence, draw each active laser as a thin
  emissive cylinder/line from the shooter's `muzzle` toward the target
  with a short lifetime, and at `crash` play a burst (expanding emissive
  sphere + a few sprite shards, ~1 s, named) at the crash point, then
  nothing — the fire plugin draws the flames and the terrain shows the
  crater. Respect `kit/reducedMotion.ts`. Stay inside the frame budget:
  ≥140 fps target, so no per-frame allocations, pooled laser meshes,
  at most two saucers + a handful of bolts alive.
- No HUD. Same reasoning as monsters.

## Deliverables

1. Commits on branch `saucers` (worktree), typecheck green at root.
2. Report at `.claude/orchestration/briefs/saucer-dogfights-report.md`:
   what you built (file:line for each mechanism), the constants table
   (name, value, why), how to trigger an encounter for a smoke test
   (the exact admin message, mirroring the monsters recipe), anything you
   punted with an explicit yes/no and one-line reason, and any place the
   design above turned out to be wrong from source (say what you did
   instead and why).
3. Then `ExitWorktree({ action: "keep" })` and stop. The orchestrator
   merges and does the eyes-on visual verification after an owner-approved
   restart; do not attempt it yourself.
