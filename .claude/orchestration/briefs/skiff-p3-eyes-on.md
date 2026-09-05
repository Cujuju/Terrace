# Brief: skiff GLB, phase 3 — in-game eyes-on of the authored skiffs (GH #317)

Repo: /mnt/e/Development/Projects/Terrace. Arc worktree (phases 1-2 committed there, node_modules installed):
  /mnt/e/Development/Projects/Terrace/.claude/worktrees/skiff-glb-models   (branch skiff-glb-models)
Never edit or run git against the main checkout. Never pnpm install, never symlink, never rm -rf / recursive delete.
Do not push, do not merge, do not add tests. Comments are claims, not evidence.
Read the phase reports first: .claude/orchestration/briefs/skiff-p1-report.md and skiff-p2-report.md.

## Stack — AGENT-OWNED, never the owner's
The owner's own server/client must never be touched: never kill a process you did not launch; kill only by a pid you
captured or by the owner of a port YOU chose, from a script file (`ss -ltnp`). Never inline `pkill -f` / `pgrep -f`
(self-matches and kills your shell).

Reuse the war-boat rig, copied (not edited in place) from /mnt/e/Development/Projects/Terrace/.glb-eyes-on/:
  launch.sh, stop.sh, shoot-boats.mjs  →  /mnt/e/Development/Projects/Terrace/.skiff-eyes-on/
Edit your copies: WT = the skiff worktree; ports 2698 (server) / 5298 (vite); WORLDS_DIR=.skiff-eyes-on/worlds;
DB_PATH a nonexistent file; WORLD_SIZE=512. Copy ONLY /mnt/e/Development/Projects/Terrace/.glb-eyes-on/worlds/frostwick-hollows.db
(the world that has coastal settlements; do not copy -wal/-shm files, never open the originals) and write its id to
`.active` the way launch.sh's server expects (check server/src for how WORLDS_DIR/.active is read). Vite on /mnt/e does
not watch files — restart it after any edit. Never `vite build`. Player token: shoot-boats.mjs's TOKEN default worked
last session on that world copy; verify it still yields a joined session (the script's readiness wait).

## Framing skiffs, not war boats
shoot-boats.mjs waits for the boats plugin's views and targets the nearest hull. Adapt your copy (shoot-skiffs.mjs) to:
- wait for the structures plugin instead (find what window.__terrace exposes for plugins — grep `__terrace` in
  client/src — and how the war-boat script found boat views; do the equivalent for the skiff InstancedMesh, e.g. the
  Group named 'structures:skiffs' with count > 0);
- pick a target from the live skiff placements or from the DB: query frostwick-hollows.db (sqlite3 CLI if present,
  else node:sqlite / better-sqlite3 from the worktree's node_modules — check what the server uses) for structures with
  tier ≥ 1 that are coastal; convert cell → world by CELL_WORLD_SIZE (shared/src/constants.ts:50). Do NOT guess a point.

## Deliverable: 4-5 PNGs under /mnt/e/Development/Projects/Terrace/.skiff-eyes-on/shots/ (1600x1000)
1. Close (dist ~1.5, height ~0.8): one skiff; check waterline bite (in the water, not on it, not sunk), interior visible
   (sole + thwarts), vertex colours present (not a flat single brown, not magenta/black), bow points along the orbit
   direction of travel (take two shots 2 s apart and compare motion vs heading — the phase-2 rotateY sign is what this
   proves; if the boat sails stern-first, say so loudly with both frames).
2. Mid (dist ~4): a settlement's fleet of 2-3 skiffs orbiting beside the shore and huts.
3. Game (dist ~7, ~55° down): the actual play distance; the skiff must still read as a boat, not a slab.
4. Dusk if the app has a time-of-day control reachable from the page (last session's dusk shot: check how
   shoot-boats.mjs or .glb-eyes-on/probe.mjs did it); skip with a note if not.
5. If any war boat is in the same world, one frame with both for scale.
LOOK at every PNG yourself (Read tool) before reporting. Also capture the browser console for errors from the structures
plugin's preload/attach (a thrown fit check or missing anchor would silently leave NO skiffs — zero skiffs in frame is a
FAIL to diagnose, not a "no settlements here").

Tear down everything you launched (server, vite, chrome-headless-shell) via your stop.sh; verify with `ss -ltnp` that
2698/5298 are free. Leave .skiff-eyes-on/ in place (uncommitted) — the orchestrator commits the rig.

## Final report (short; also write it to .claude/orchestration/briefs/skiff-p3-report.md)
Absolute PNG paths with one line each; the heading-vs-motion verdict with evidence; console errors seen; any defect;
teardown confirmation with the ss output line.
