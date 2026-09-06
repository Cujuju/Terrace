# Brief: skiff GLB, phase 6 — in-game eyes-on of the #327 fixes (transom, dry interior, terrain clearance)

Repo: /mnt/e/Development/Projects/Terrace. Arc worktree (phases 4-5 committed, main merged in at 4d33e5a, node_modules installed):
  /mnt/e/Development/Projects/Terrace/.claude/worktrees/skiff-glb-models   (branch skiff-glb-models)
Never edit or run git against the main checkout. Never pnpm install, never symlink, never rm -rf / recursive delete.
Do not push, do not merge, do not add tests, do not edit source in the worktree (report defects; the orchestrator fixes).
Comments are claims, not evidence. Read first: .claude/worktrees/skiff-glb-models/.claude/orchestration/briefs/skiff-p4-report.md
and skiff-p5-report.md (what changed and what each phase could NOT verify — that is your list).

## What must be proven (owner defects 2026-09-04, verbatim): "The skiffs are missing a back plate, and the water should not
render inside of the boat. The skiffs also should have collision detection with terrain and right now they pass into the terrain."
1. Transom closed: a stern-quarter view shows a back plate, no hole.
2. No sea inside the hull: at every point of the bob cycle the interior shows floorboards/planking, never the blue sea
   surface. Capture the SAME skiff at ≥3 instants spread over a 2.6 s bob period (e.g. 0, 0.9, 1.8 s).
3. No skiff touches drawn terrain: over a full 14 s orbit no hull crosses a shoreline cap. Capture a fleet at ≥4 instants
   across one orbit period from a top-down-ish mid view; also confirm skiff COUNT > 0 (the mooring contract may now
   float nothing where the shore is too tight — if a settlement that used to have boats has none, that is expected, not a
   bug; report how many settlements have 0/1/2/3 boats via the live placements).
4. Preload passed: the console shows no thrown error from installSkiffKit (the new `dryline` assert would leave ZERO
   skiffs — zero skiffs everywhere is a FAIL to diagnose).

## Stack — AGENT-OWNED, never the owner's
Never kill a process you did not launch; kill only by a pid you captured (your stop.sh). Never inline `pkill -f`/`pgrep -f`.
Copy (do not edit in place) /mnt/e/Development/Projects/Terrace/.glb-eyes-on/{launch.sh,stop.sh,shoot-boats.mjs,probe.mjs}
→ /mnt/e/Development/Projects/Terrace/.skiff-eyes-on/ and edit your copies: WT = the skiff worktree; ports 2698 (server) /
5298 (vite); WORLDS_DIR=.skiff-eyes-on/worlds; DB_PATH a nonexistent file; WORLD_SIZE=512. Check `ss -ltnp` that both
ports are free before launching. Copy ONLY .glb-eyes-on/worlds/frostwick-hollows.db (the world with coastal settlements;
no -wal/-shm; never open the original) and write its id to `.active` the way the server expects (check server/src for how
WORLDS_DIR/.active is read). Vite on /mnt/e does not watch files — restart it after any edit. Never `vite build`.
Player token: shoot-boats.mjs's TOKEN default worked before on this world copy; verify it yields a joined session.

## Framing
shoot-boats.mjs targets the war-boat plugin; adapt your copy (shoot-skiffs.mjs) to wait for the structures plugin's skiff
InstancedMesh (Group named 'structures:skiffs' with count > 0 — find how window.__terrace exposes the scene/plugins; grep
`__terrace` in client/src) and read live skiff anchors from it or from the DB (sqlite3 CLI, or node:sqlite / the driver
the server uses from the worktree's node_modules): structures with tier ≥ 1 near water; cell → world via CELL_WORLD_SIZE
(shared/src/constants.ts). Do NOT guess a point. Pick a fleet that sits close to a shoreline — that is where defect 3 shows.

## Deliverable: PNGs under /mnt/e/Development/Projects/Terrace/.skiff-eyes-on/shots/ (1600x1000)
- stern-close (dist ~1.2, from the stern quarter): transom.
- interior-t0/t1/t2 (dist ~1.5, height ~1.0, looking down into ONE skiff): bob cycle.
- orbit-t0..t3 (dist ~4, ~60° down): the fleet nearest a shore across one orbit period.
- game (dist ~7, ~55° down): play distance, still reads as boats.
LOOK at every PNG yourself (Read tool) before reporting. Capture the browser console (errors + warnings) for the whole run.

Tear down everything you launched via your stop.sh; verify with `ss -ltnp` that 2698/5298 are free. Leave .skiff-eyes-on/
in place (uncommitted).

## Report (short; write it to .claude/orchestration/briefs/skiff-p6-report.md and return it)
Per defect: PASS/FAIL with the PNG paths that prove it and one line of what you saw; skiff count per settlement; console
errors; anything you could not capture and why.
