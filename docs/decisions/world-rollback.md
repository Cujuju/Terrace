# World rollback

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-21 (world rollback — restore points, issue: Genesis overshoot)

**What prompted it.** The owner cast the Genesis relic expecting a modest
terraform and got a world-scale one: the snapshot written immediately after it
changed 11,673 cells (4.45% of a 512² map) with a max single-cell delta of
1,772, against 5–108 cells and deltas of 48–432 for every ordinary player
stroke around it. Recovering meant hand-editing SQLite. That is the gap this
feature closes — not the relic bug itself, which is separate.

1. **Restore points are core, not a plugin.** A restore point IS a snapshot,
   the thing core already writes every `SNAPSHOT_INTERVAL_S` (§3.6). Listing
   one and re-applying it is persistence housekeeping. Nothing attaches a rule,
   a cost or a reward to rolling back, so "nothing gamey in core" (§3.5) holds.
   *Rejected:* a `rollback` plugin — it would need privileged access to the
   snapshot store, the world's private masks and the plugin host's own restore
   path, i.e. everything the plugin boundary exists to withhold.

2. **The gate is a shared secret in the environment (`ROLLBACK_KEY`).** v1 has
   no accounts (§3.7), so the server cannot distinguish the self-hoster from
   anyone holding the invite link, and rolling the world back is the most
   destructive thing it can be asked to do. A chosen key must be at least 8
   characters, is refused at boot below that, is never logged, is compared in
   constant time, and five wrong keys locks that connection out for a minute.

   **AMENDED the same day (owner decision): the feature is ON by default.** An
   unset `ROLLBACK_KEY` now means the built-in `DEFAULT_ROLLBACK_KEY`
   (`terrace`), so a self-hoster can use their own safety net without first
   editing an environment file — which was the point of building it. The cost
   is stated plainly rather than hidden: that key is in the repository, so an
   unconfigured deployment can be rolled back by anyone who can reach it, and
   the server logs a WARNING naming the key on every such boot. `ROLLBACK_KEY=`
   (present but empty) is now the spelling that turns rollback off — absent and
   empty deliberately mean opposite things. The 8-character floor deliberately
   does NOT apply to the built-in default, which is shorter than it: a public
   default that announces itself and a secret someone chose are different kinds
   of thing, and a test pins that inequality so the exemption cannot rot.
   *Rejected:* letting any connected player do it with no key at all (one
   griefer erases everyone's world, and there would be nothing to raise the bar
   with on a server that IS exposed). *Rejected:* loopback-only (breaks LAN
   play and every Docker deployment, which is the canonical self-host path).

3. **A rollback saves the world it is rolling away from, first and
   unconditionally.** A mis-aimed rollback therefore costs a click, not a
   world, and the receipt names the undo point. Deliberately not "if dirty":
   a world that happens to be clean at that instant is exactly the case where
   the newest restore point may already be minutes old.

4. **Nothing is ever deleted.** A rollback appends; the state rolled away from
   ages out under `SNAPSHOT_RETENTION` like any other row.

5. **A rollback replays the boot sequence rather than inventing a second
   restore path.** `World.rewindTo` (terrain, union mask, per-token masks) then
   `host.restorePersistence` then `host.worldCreate` — the same two calls, in
   the same order, that `index.ts` makes at boot. It has to be both: flora,
   structures and chronicle stage their slice in `load` and consume it in
   `onWorldCreate`. This makes re-runnability a contract on `PersistenceSlice`
   (stated there): both calls must REPLACE a plugin's state, never add to it.
   Every plugin in the repo was checked against it on 2026-08-21 and each one
   already resets.
   *Rejected:* restarting the process — there is no supervisor guaranteed to
   bring it back (`run_server.py` restarts on file change, not on exit).

6. **Clients learn about it as a plain `snapshot`.** No new "you were rolled
   back" message: the client's `onSnapshot` was already the rejoin path and
   already resets mirror, meshes, fog, water and rivers wholesale. Sent
   per-token, after the plugin replay, so nobody re-renders rewound ground
   while the plugins still hold post-rollback forests and villages.

7. **The list shows how far the world moved, not just when.** Each restore
   point carries `cellsChanged` and `maxCellDelta` against its predecessor, and
   the panel flags rows above 8× the history's MEDIAN (median, not mean — the
   one big event would otherwise raise the bar it has to clear). Timestamps
   alone are useless here: the two snapshots either side of the Genesis cast
   are one minute apart and look identical in a list of times.

8. **Two surfaces, one implementation.** The in-game panel (bottom-right
   button, beside the chart and the gear) and `pnpm --dir server rollback`
   both go through `SnapshotStore`. The CLI exists because the cases that most
   need a rollback are the ones where the server or client will not run; it
   appends the chosen snapshot as the newest and lets an ordinary boot restore
   it, so it needs no terrain math at all.

9. **`SNAPSHOT_RETENTION` is now configurable (default unchanged at 10).** The
   Q4 decision stands as the default; what changed is that the history is now
   something a self-hoster can see and use, so its depth is theirs to set. The
   ceiling of 100 is set by the listing cost, not the disk: listing decodes and
   compares every retained heightmap. **At the default, the safety net is only
   ten minutes deep** — raise it if you want longer.
