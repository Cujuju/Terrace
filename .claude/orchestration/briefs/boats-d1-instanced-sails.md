# D1 — the sail leaves the per-instance path

Read `.claude/orchestration/briefs/skiffs-arc-common.md` FIRST (binding), then
the `## D1` section of `.claude/plans/skiffs-and-boat-draw-calls.md`. Both are in
the worktree you work in.

## Where you work
`/mnt/e/Development/Projects/Terrace-wt-skiffs`, branch
`arc/skiffs-and-draw-calls`. Absolute paths, `git -C <path>`, never `cd &&`.
Never edit `/mnt/e/Development/Projects/Terrace` — other agents are live there.

## The measured target (D0, 2026-09-06, #367)
Frostwick-hollows, 119 villages / 231 boats, frozen sim, 1584x805:

| baseline draw calls | 373 |
| baseline GPU p50 | 5.544 ms |
| error bar (`noise.baselineGpuMsMeanStep`) | 0.135 ms |
| **boats' share** | **180 draw calls, 1.231 ms GPU, 1.30 ms frame** |

180 at 3 per hull is ~60 hulls in frame. The sail is one of those three, so D1
removes ~60 draw calls. Boats cost more CPU than GPU, which is submission cost —
the thing you are removing.

## What is true today (verify each before you rely on it)
- `plugins/boats/client/models.ts:376` — `create()` calls `instantiateRig` per
  boat: fresh `Skeleton`, one `SkinnedMesh` per surface per instance.
- `models.ts:380-382` — the sail is a separate `Mesh` with a **cloned material
  per boat**, cloned purely so `fighting` can tint it (`:419-421`,
  `SAIL_FIGHTING_COLOR`).
- `models.ts:350-357` — the sail is never baked into the rig: `sailNode` is
  removed before `bakeRig` and re-parented after.
- `models.ts:372` — `drawObjects = blueprint.surfaceCount + 1`; the `+1` is the
  sail.
- `plugins/boats/client/index.ts:181` — `drawBudget = BOATS_PAYLOAD_CAP *
  BOAT_SHAPE.drawObjects`.
- `index.ts:107` — `models.create()` per boat; `index.ts:195-199` — `attach`
  makes the `boats:afloat` `Group` (`container`) and adds it to `ctx.layer`.
- The long comment above `createBoatModels` explains why the sail is NOT baked
  into the rig. That reasoning stands; instancing the sail is a different fix.

Reference precedent in this repo for a single-`InstancedMesh` fleet:
`plugins/structures/client/skiffModels.ts:363`. Read it. **Do not modify it** —
skiffs are a different arc and the one-InstancedMesh rule there is binding.

## What to build
**One `InstancedMesh` for every sail in the fleet**, drawn once per frame,
with the fighting tint written per instance.

1. **Ownership.** The mesh belongs to the fleet, not to a boat. Create it in
   `createBoatModels()` and expose it on `BoatModels` so `attach()` adds it to
   the SAME parent the boat roots live under (`container`), once. Same parent
   matters: it is what lets you compose an instance matrix from the boat root's
   LOCAL matrix without walking world transforms.
2. **Capacity** is `BOATS_PAYLOAD_CAP` — the cap `drawBudget` already derives
   from. Do not restate the literal.
3. **A slot per boat.** `create()` takes a slot, `dispose()` returns it. A free
   slot must draw NOTHING — park it with a zero-scale matrix, and say so in a
   comment. A stale sail at the origin is the failure mode to design out.
4. **Per frame, in `animate()`:** compose the sail's matrix as
   `boatRootLocalMatrix * authoredSailLocalMatrix` and write it with
   `setMatrixAt`, then `instanceMatrix.needsUpdate = true` once per frame for
   the whole mesh — not once per boat. Note `animate()` runs BEFORE the
   renderer updates world matrices, so read the root's own transform and
   compose; do not read `matrixWorld`.
5. **The tint** is `setColorAt` on the instance, guarded by the existing
   `wasFighting` check so it is written only on the frame the state flips.
   Keep ONE shared sail material — the per-boat `clone()` is what this phase
   deletes, and it must not survive.
6. **Keep the numbers truthful.** `drawObjects` is per-hull and loses its `+1`;
   the fleet's single sail draw is a named constant added to `drawBudget`, not
   folded silently into the per-boat count.
7. `dispose()` must free the instanced geometry/material at fleet level and
   nothing per boat that no longer exists.

## Do not
- Do not touch skiffs, `plugins/structures/**`, or anything in arc S.
- Do not run `scripts/gpu-bench.sh` — the orchestrator owns the bench lock and
  the 2598/5198 stack, and a second run corrupts both numbers.
- Do not restart Vite. Do not start or stop any server.
- Do not merge to `main`, and do not call `ExitWorktree`.

## Verify — evidence, not claims
- `pnpm typecheck` in the worktree, clean.
- `timeout 300 pnpm --filter <the boats package> test`, from the package's own
  name in its `package.json`. NEVER `pnpm -r test` — it hangs.
- Tests: contract-level ONLY (owner, this session). The contract worth pinning
  is the slot allocator: a freed slot is reused, a freed slot draws nothing,
  and capacity is never exceeded. No wiring tests, no per-callsite tests.
- Report the before/after of `BOAT_SHAPE.drawObjects` and `drawBudget` with the
  file:line that sets each.

## When done
Commit to `arc/skiffs-and-draw-calls` (stage only your exact paths, never `-A`).
Conventional commit, no attribution footer. Then report:
1. Every file you changed and why, with file:line for the two draw-call numbers.
2. The typecheck and test output you actually saw.
3. Anything in this brief you found to be WRONG at a file:line, with the
   contradicting file:line. Do not silently work around it.
4. What you did NOT do and why.
