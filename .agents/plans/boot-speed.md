# Boot speed — code-only plan (2026-09-05)

Status: PLANNED, not implemented. Owner decision 2026-09-05: the checkout
stays on `E:\` (9p/drvfs); fix boot in code, and add speed tests so the number
is visible on every boot and over time.

## What was measured (2026-09-04, WSL2, no app started)

| Probe | Result |
|---|---|
| `stat` on `/mnt/e` vs ext4 | 29.8 ms vs 0.012 ms per call |
| `import '@colyseus/core'` + `ws-transport` (157 CJS files, express eager) | 16–26 s |
| 24 sequential plugin `server/index.ts` imports | 5.8 s |
| git stamps at boot: version.ts ×2, `status` ×1 (2.8 s), `rev-parse` ×24 (0.2 s each), `diff` per dirty plugin | ≈ 9 s |
| `pnpm start` / `pnpm dev` wrapper | 1.5 s each |
| Vite config load: `vite` 3.3 s, `vite-plugin-solid` (babel) 22.1 s, `vitest/config` 0.55 s, git ×2 ≈ 1 s | ≈ 27 s |
| Vite "ready" after config | 9.5 s (from a saved vite.log) |
| Client sources served unbundled on first page load | 123 core + 141 plugin + 20 shared files |

CPU under 1.5 s in every probe; the cost is per-file round trips to Windows.
Cure in code = fewer files opened, fewer processes spawned, and the ones
that remain done concurrently.

Verified and rejected: Vite's dep cache is NOT invalidated by the git-derived
`__CLIENT_VERSION__` define (Vite 8 `getConfigHash` excludes user defines).

## Phase 0 — speed tests (first, so every later phase reports its own number)

**S1 Server boot phases, in-process.** New `server/src/boot/timing.ts`:
`markBootPhase(name)` records `performance.now()` (whose origin is process
start, so the dependency-import time before `main()` is captured as the
first phase). `index.ts` marks after: deps imported, config, plugins
(stamps and imports separately), build identity, world open, boot snapshot,
listening. On listen it logs one human line and one JSON line:

```
[terrace] boot: deps 16.2s · stamps 9.1s · plugin imports 5.8s · world 0.4s · listen 0.1s · ready 32.0s
[terrace] boot-timing {"deps":16210,"stamps":9100,...,"ready":32010,"pluginCount":24,"worldSize":512}
```

If `TERRACE_BOOT_SINK` names an absolute `.jsonl`, the JSON line is appended
there too, same contract as `TERRACE_PERF_SINK`.

**S2 Vite boot phases.** A small `terrace-boot-timing` plugin in
`client/vite.config.ts`: records `performance.now()` at config-module top and
in `configureServer` + the server `listening` hook, logs
`[vite] boot: config+plugins N s · ready N s since process start`, and appends
to `TERRACE_BOOT_SINK` when set.

**S3 Client page boot marks.** `client/src/perfProbe.ts` gains a `boot`
sample posted to the existing `/__perf` sink: module-eval start (top of
`main.tsx`), first rendered frame, socket connected, snapshot received (chunk
count), first chunk mesh on screen, all snapshot chunks built. Armed by the
existing `?perf=` query the probe already reads (a new `boot` scenario key),
so ordinary sessions send nothing.

**S4 Bench driver** `scripts/boot-bench.sh` + `scripts/boot-bench.mjs`:
starts the server the way `.agent-stack/launch.sh` does (throwaway worlds
dir, port 2599, no legacy DB), waits for the `boot-timing` line, stops it,
repeats N times (default 3), prints median per phase, appends every run to
`.perf/boot-history.jsonl` (project dot-dir, never `$HOME`) with git HEAD and
a label. `--client` also starts Vite and records S2; `--browser` drives
Windows Chrome exactly as `scripts/gpu-bench.sh` does to collect S3 through
the sink. Each run starts the app, so it is run only with owner permission
in that turn. `scripts/boot-bench.md` documents the field contract.

## Phase 1 — server

**P1 Vendor bundle for third-party deps.** `server/scripts/build-vendor.ts`
bundles `@colyseus/core`, `@colyseus/ws-transport` and everything they pull
(express, ws, schema, timer …) into one `server/.vendor/colyseus.mjs` with
rolldown; `better-sqlite3` (native) and `node:*` stay external. Import sites
are two files (`index.ts`, `net/terrace-room.ts`); they switch to a
`package.json` `imports` alias `#vendor/colyseus` so no loader hooks are
needed. A sidecar records the lockfile hash; `build-vendor` is a no-op when
fresh and `run_server.py` / `pnpm start` call it before boot. `.vendor/` is
gitignored. Expected: 16–26 s → about 1 s.
Requires declaring `rolldown` (already in the lockfile via Vite 8) as a
server devDependency — owner approval needed before adding.
Risk: Colyseus internals using dynamic `require`/`__dirname`; validated by
the server test suite and one live boot. Rejected alternatives: Node
startup snapshot (`--build-snapshot`; no ESM, no native addons, fragile),
`node-linker=hoisted` (fewer symlink hops but still 157 files).

**P2 Git stamps: 27+ spawns → 3, and off the critical path.** One
`git ls-tree HEAD plugins/` yields all 24 tree hashes; keep the single
`status` and the per-dirty-plugin `diff`. Switch to async `execFile` and run
the stamp work concurrently with the plugin imports (P3); the two are
independent until `LoadedPlugin` is assembled. Expected: ≈ 9 s → ≈ 3 s, fully
overlapped. Stamp format unchanged.

**P3 Parallel plugin imports.** Import all 24 entries with `Promise.all`,
then assemble `LoadedPlugin[]` in the sorted directory order, so interceptor
order stays deterministic. Precondition: audit each `plugins/*/server/index.ts`
for cross-module top-level side effects (2026-09-04 grep found only
module-local `const x = create…`; the audit reads each file). Expected:
5.8 s → 1–2 s.

**P4 Launcher without pnpm.** `run_server.py` spawns `node src/index.ts`
and `client/node_modules/.bin/vite` directly. 3 s.

## Phase 2 — client

**C1 Skip Vite's dependency scan.** `optimizeDeps.noDiscovery: true` with
an explicit `include` (solid-js, solid-js/web, solid-js/store, three, the
three addons in use, @colyseus/sdk). Removes the startup crawl of ~284
source files. Magnitude unverified; S2 measures it.

**C2 Vendor-bundle `vite-plugin-solid`** (same trick as P1): 22 s of the
27 s config load is babel. Try one bundle of `vite-plugin-solid` +
`babel-preset-solid`; abandon if babel's name-based preset resolution does
not survive bundling. Experiment, not a commitment.

**C3 Lazy plugin client modules.** `registry.ts` becomes name →
`() => import(...)`; the host loads on `syncLivePlugins`. 141 of 284 page
modules are plugin-side. Needs the host's registration paths (toolbar, HUD
panels, messages) to tolerate late arrival — read `plugins/host.ts` first.
Decide after S3 shows how much of page load those modules are.

## Phase 3 — measure, then decide

World open (`World.restore`, plugin restore, boot snapshot with thumbnail)
and the static-client alternative (`vite build` + server-served dist vs dev
mode, given Vite never watches on this mount) get numbers from S1/S4 before
any change.

## Tests

The bench scripts and in-process timing are the speed tests asked for.
Vitest unit tests (P2: `ls-tree` stamps equal the old per-plugin stamps;
P1: vendor freshness check) need explicit permission in the implementing
session.

## Expected outcome

| | Now | After phases 1–2 |
|---|---|---|
| Server to listening | ≈ 32–43 s + world | ≈ 6–8 s (status 2.8 s floor) |
| Vite to ready | ≈ 37 s | ≈ 30 s; ≈ 10 s if C2 works |
| Page load | unmeasured | measured by S3; C3 if warranted |

## Order

S1 → S2 → S3 → S4 (one commit each) → P4 → P2 → P3 → P1 (needs approval)
→ C1 → C2 → re-bench → C3 / Phase 3 by the numbers.
