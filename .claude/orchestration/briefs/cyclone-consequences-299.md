# Brief — #299 (part 1 of 2): a cyclone has consequences on land

You are a fresh implementation agent. Work in your OWN worktree (`EnterWorktree`
with no path → new worktree off main). Commit to its branch (conventional commits,
first line < 72 chars, NO attribution footers, stage exact paths only). Do NOT merge
to main. Paths are relative to the worktree root.

Read first (binding): root `CLAUDE.md`; `docs/decisions/storms-and-mudslides.md`
and `docs/decisions/plugin-host.md` (do not append); `plugins/cyclone/server/index.ts`
header (:1-60) — the consumer seam it describes is what you are building;
`server/src/plugins/types.ts:277` (emitEvent) and `:714-724` (onWorldEvent);
`server/src/plugins/kit/rotatingStorms.ts:213-302` (damage event payload,
ROTATING_STORM_DAMAGE_INTERVAL_SECONDS=1, windFalloffAt :592); an existing consumer:
`plugins/wildlife/server/index.ts:520-523` + `plugins/wildlife/server/fire-event.ts`
(subscribe by name, validate structurally). Issue #213 lists the intended consumers.

## Owner's ruling (2026-09-03, verbatim)
"Cyclone should have consequences on land. It should flatten flora, damage
structures, push boats, disrupt the land itself." (Eye-hole rendering is parked;
the client render is a separate brief — touch nothing under `plugins/cyclone/client`.)

## Today (verified)
`cyclone:damage` (`RotatingStormDamage`: eye x/y, radius, eyeRadius, intensity,
durationSeconds, bounded `cells[{x,y,severity}]`) and `cyclone:landfall` are emitted
every second per storm (cyclone/server/index.ts:204-205). NO plugin consumes them
(#237). The only world effect is surge: half a band scoured from one shoreline cell
per 10 s (cyclone/server/surge.ts). Comment/code: the header at index.ts:18-27 says so.

## Build (four consumers, one contract)
Every consumer subscribes to `cyclone:damage` BY NAME via `onWorldEvent`, parses the
payload structurally in its own `cyclone-event.ts` (mirror wildlife's `fire-event.ts`),
never imports cyclone, and converts `severity × durationSeconds` into its own action
through NAMED constants with reasoned docs. Determinism: use the consumer's own seeded
RNG where one exists (flora, structures, boats have rng modules/seeds — check); never
`Math.random`. Server-authoritative; clients learn only through each plugin's
existing broadcasts.

1. **Flora — flatten.** Struck cells above a named severity fell trees (and crops if
   the plugin has them) using the SAME code path a burned-out tree takes minus the
   scorch (find it: `floraBurnedOut`, flora/server/index.ts:1505; stumps.ts). A felled
   tree leaves a stump if burns do. Rate: a severity-1 cell for 1 s fells with a named
   probability so a full-strength eyewall clears a wood in seconds, the outer disc
   thins it. State what the client sees and confirm the existing flora broadcast
   carries it (file:line).
2. **Structures — damage.** Find how a burned building is removed/demolished
   (structures/server/index.ts's `registerStructuresFuel` callback and what it calls;
   `clearance.ts`, `life.ts`). Wind damage uses that path, gated by severity with a
   higher bar than flora (buildings outlast trees) — named constants. If structures
   has tiers (`tiers.ts`), higher tiers resist more; say how. No new "health" model
   unless one exists.
3. **Boats — push.** `Boat` (boats/server/fleet.ts:72-81) has x, y, heading. A boat
   inside the disc is pushed each event by a displacement along the storm's
   tangential wind (rotation sense: read the kit/cyclone for which way it spins;
   northern-hemisphere cyclonic = counter-clockwise viewed from above — match whatever
   the client spiral draws) scaled by severity × durationSeconds, clamped to sailable
   cells (`isSailable`, fleet.ts:318) — a pushed boat never lands on ground. Add the
   push in `advanceFleet`'s frame, not from inside the event handler, if the handler
   runs mid-tick (check host.ts's event dispatch order; say what you found).
   A boat pushed by a severity-1 gale for 1 s moves a named number of cells.
4. **Land — disrupt.** In the cyclone plugin itself: struck cells above sea level
   with severity above a named bar are scoured by a fraction of a band (integer height
   units; reuse `SURGE_SCOUR_HEIGHT_UNITS`'s reasoning), via `world.sculpt` with a
   named small brush, budgeted per event (a named max ops per storm per second) so a
   storm never floods the sculpt queue. Gate it with the same `cyclone-surge` setting
   or add a sibling setting — justify the choice in one paragraph in the report.
   Landfall (`cyclone:landfall`) stays informational.
5. Update the cyclone index.ts header (:18-27) so it names what consumes the events
   now (comments are claims; make it true).

## Proof (required, node scripts, no browser, no app start)
Under your worktree's `.verify-299/` (never $HOME, never committed): drive the server
sim with a forced cyclone (`CYCLONE_DEV_FORCE=1`, cyclone/server/dev.ts) on a world
with a wood, a village and boats near the shore, using the construction shape the
plugins' tests use. Report before/after counts: trees, buildings, boat positions
(with the push direction against the spin), and terrain height deltas at struck cells.
Same seed twice → identical results. Include the script paths.

## Constraints
- Tests: do NOT add or write tests (owner rule). Existing must pass for every touched
  package: `pnpm --filter <pkg> test` with a timeout; `pnpm typecheck`. NEVER
  `pnpm -r test`. Report a pinned old contract, don't rewrite it.
- No new dependencies. No magic numbers. Erasable TS, no `any`. Plugins never import
  each other. Don't touch `docs/**`, `.claude/**` except your report, or
  `plugins/cyclone/client/**`.

## Report
`.claude/orchestration/briefs/cyclone-consequences-299-report.md`: commits, worktree
path/branch, per-consumer file:line, the constants table (name, value, reason), proof
output, test/typecheck tails, what you left undone and why. Then stop.
