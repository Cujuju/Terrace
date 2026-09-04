# Brief: durable real-GPU frame benchmark, then measure the cyclone tower (#305)

Issue: https://github.com/Cujuju/Terrace/issues/305 (arc/weather-clouds-shadow-reveal-clip).
Owner ruling 2026-09-03: build a generic, committed, reusable GPU fps benchmark
that any agent (Anthropic or the pi CLI) can run with one command; then use it
to answer #305.

Read first: `docs/DESIGN.md`, `CLAUDE.md`, `.gpu-perf/README.md`,
`.gpu-perf/gpu-probe.sh`, `.gpu-perf/perf-probe.patch`,
`/mnt/c/Users/shawn/terrace-foreground.ps1`,
`.claude/orchestration/perf-review-2026-08-29.md` (bar and prior numbers),
`plugins/cyclone/server/dev.ts` (the `CYCLONE_DEV_FORCE=1` switch).

## Why (root cause)

The only real-GPU harness is `.gpu-perf/` — gitignored, page-side code shipped
as `perf-probe.patch`, which already fails `git apply --check` on
`client/src/main.tsx` five days after it was written, and hard-wired to one
scenario (idle 240 frames + 5 s sculpt stroke). An uncommitted patch-based
probe rots; a DEV-only committed probe with a scenario switch cannot.

Physical constraint you cannot change: WSL Chromium has no /dev/dri and renders
on SwiftShader, so ONLY Windows-side Chrome (RTX 3090) gives a judgeable frame
time. Only Windows→WSL localhost is open, so the page measures itself and POSTs
to the dev server; nothing in WSL can drive it over CDP. Keep that shape.

## Deliverable

1. `client/src/perfProbe.ts` — committed, DEV-only. Gated on `?perfprobe=<scenario>`
   and the whole install call sits inside `if (import.meta.env.DEV)` in
   `client/src/main.tsx` next to the existing `__terrace` handle (verify the
   line yourself; do not trust this brief's memory of it) so production
   tree-shakes it. Port the patch's measurement core (per-frame ms, p50/p95/p99,
   1% low, draw calls, triangles, upload bytes, per-callback breakdown, gpu
   string, client version) and its `settle=<ms>` param.
2. Scenarios, one function each, selected by the query value:
   - `idle` — settle, then N idle frames.
   - `sculpt` — the patch's held radius-4 stroke (keeps A/B parity with
     `.gpu-perf/results/*.json`).
   - `cyclone` — server run with `CYCLONE_DEV_FORCE=1`; the probe parks the
     camera on the storm (find the eye via the cyclone client plugin's state,
     verify the accessor at file:line) at a documented distance, then samples.
   Adding a scenario later must be one function plus one table entry.
3. `/__perf` POST sink as a Vite dev plugin in `client/vite.config.ts` writing
   JSONL to `TERRACE_PERF_SINK` (required env; no silent /tmp default).
4. `scripts/gpu-bench.sh <scenario> <label>` (bash) plus
   `scripts/gpu-bench-foreground.ps1` (move the HOME copy here; owner rule:
   nothing working lives in $HOME). The script: kills only the perf-profile
   Chrome by its command line, launches Chrome with the rig's flags and their
   documented reasons, holds foreground, waits for the sink line, prints one
   JSON line with `label` and `scenario`. Every timing/port is a named constant
   with its reason.
5. `scripts/gpu-bench.md` — how to start the isolated stack (server on 2599 with
   `WORLDS_DIR`/`DB_PATH` in a project dot-dir, NEVER $HOME; Vite on 5199 with
   `VITE_SERVER_URL=ws://localhost:2599`), the output field contract, and an
   A/B recipe. Written so pi or an Anthropic agent can run it cold.
6. Results go in `.gpu-perf/results/` (already ignored) — record your #305 runs
   there and quote them in the report.

## Then measure #305

Run `idle` and `cyclone` on main, same world, same camera distance, ≥3 runs
each; report msMean/p95/p99/1%-low and draw calls. Bar: ≥140 fps = ~7.1 ms
budget on every frame. If the cyclone scenario breaks the bar, name the tier
counts in `plugins/cyclone/client/spiral.ts` as the first lever with the
measured delta per tier — but DO NOT retune; that is a separate owner decision.

## Rules

- Work in your worktree only. Own stack on 2599/5199, throwaway world copied
  from `server/data/worlds/*.db` if a grown world is needed. Never touch the
  owner's running server, ports 2567/5173, or `WORLDS_DIR` defaults. Kill by
  port-owner pid from a script FILE; never inline `pkill -f` (self-matches).
- Vite on /mnt/e does not watch: restart Vite after every client edit.
- Chrome launch steals Windows desktop focus for the hold window; that is
  expected and owner-approved for this task.
- No new dependencies. No tests without owner permission (none granted).
- Claims need file:line evidence you read this session; comments are claims,
  not evidence.
- Commit on your branch with conventional commits, no AI attribution lines in
  the body beyond what the harness adds. Do not merge; the orchestrator does.
- Report to `.claude/orchestration/briefs/gpu-bench-305-report.md`: what was
  built, verification (a real run's JSON line pasted), #305 numbers, and any
  assumption you could not verify.
