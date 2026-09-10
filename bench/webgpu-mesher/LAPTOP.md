# Gate 2 on the laptop: WebGPU mesher power versus the shipped client

Handoff for a Claude session running on the owner's laptop (Apple M4 Max, macOS). Self-contained. Every path is relative to the clone unless absolute.

## Orchestration

- Fable orchestrates and reviews; do not spawn forks. The runs here are sequential hardware measurements, so run them yourself. Spawn one Sonnet agent only if a step needs a script written that does not exist; verify its output with a concrete check before using it.
- Never start the game server, Vite, or a browser without the owner's permission in the current turn. Ask once, up front, for permission to run: headless Chrome for `run.mjs`, a visible Chrome for the battery runs, and `run_server.py` for the client run. `sudo powermetrics` prompts for the owner's password; tell the owner before each run.
- Never add tests. Stage exact paths only. No attribution in commits.
- Commit results on branch `gate2-laptop`, push it, and tell the owner. Do not commit to `main` from the laptop.

## What this is

`bench/webgpu-mesher/` is a standalone WebGPU page that meshes the Frostwick Hollows 512² terrain on the GPU (compute pass, per-cell marching squares, exact port of the shared band function) and draws it, plus the shipped CPU mesher's output for comparison, under identical shading and camera. On the desktop (RTX 3090) it matched the shipped mesh to 0.220 % of pixels against a 0.191 % metric noise floor, band placement exact except 157 cell-centre samples the shipped mesh also misses, full-world rebuild 2.5 ms GPU against 938 ms CPU, and a 3×3-chunk edit at 0.44 ms median / 2.1 ms heaviest GPU. What is unknown is what it costs on the laptop, which is the machine whose battery the owner cares about. Gate 2 measures that.

## Prerequisites

Check each; install only what is missing, and ask before installing anything.

```bash
node --version          # need 24 or newer
brew install node       # if missing or older; Homebrew's node is 24+
corepack enable && corepack prepare pnpm@10.33.0 --activate
# if corepack is missing: npm install -g pnpm@10.33.0
python3 --version       # macOS ships one; run_server.py needs 3.9+
ls "/Applications/Google Chrome.app" && echo chrome ok
```

Then in the clone:

```bash
pnpm install
pnpm typecheck
```

`pnpm-workspace.yaml` lists darwin arm64 under `supportedArchitectures`, so `better-sqlite3` and the bundler binaries install natively. If `pnpm install` reports ignored build scripts, run `pnpm rebuild better-sqlite3`.

## Inputs

`bench/webgpu-mesher/frostwick-gate.db` is a one-snapshot copy of the world (snapshot #1322, 3.5 MB), tracked. `dump.mjs` regenerates every other input from it and the repo's TypeScript: `world.bin`, `spans.bin`, `expected.bin`, `keys.bin`, `cpu-mesh.bin` (188 MB), `meta.json`, `palette.json`, `marching.json`, `isoline-cases.json`. `run.mjs` calls it when `meta.json` is missing. Nothing generated is tracked (see `.gitignore`).

The same DB serves as the client's world for the client run:

```bash
mkdir -p server/data/worlds
cp bench/webgpu-mesher/frostwick-gate.db server/data/worlds/frostwick-hollows.db
printf 'frostwick-hollows' > server/data/worlds/.active
```

## Step 1: adapter

In Chrome, DevTools console on any page:

```js
(await navigator.gpu?.requestAdapter())?.info ?? 'NO ADAPTER'
```

Also record whether `(await navigator.gpu.requestAdapter()).features.has('timestamp-query')` is true; without it the page falls back to wall-clock timing and says so in `results.json`. If `NO ADAPTER`: check `chrome://gpu` for the WebGPU line and try Safari (26 or newer exposes WebGPU). If no browser exposes an adapter, write that in the results and stop; gate 2 is a kill by default.

## Step 2: headless correctness and timings, on mains

```bash
cd bench/webgpu-mesher
node run.mjs
mkdir -p results/laptop
cp results.json report.md gpu.png cpu.png diff.png results/laptop/
```

`run.mjs` runs Node self-checks, serves the directory, drives headless Chrome, and writes the files. It exits 1 with `verdict kill — band parity mismatches`; that is expected (157 cell-centre samples, documented on the desktop) and not a failure of this run. Confirm: parity 157 mismatches / 0 holes, pixels 0.2203 %. Those are geometry and must not change with the GPU. If they do, stop and report the numbers.

Record from the console lines: draw p50 for gpu and cpu, rebuild wall and gpu ms, edit heaviest and median gpu p50 / p95 / max.

Chrome not found: `GATE1_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node run.mjs`.

## Step 3: battery runs

Conditions, identical for every run, and written into the notes:

- Unplugged, battery above 60 % at start. Fixed brightness, auto-brightness and True Tone off, note the level.
- Every other app quit. One Chrome window, one tab, fresh profile: `open -na "Google Chrome" --args --user-data-dir=/tmp/gate2 --enable-unsafe-webgpu`.
- Same window size for every run: the page canvas is 1200×900; size the client window so its canvas matches. Not fullscreen.
- Hands off for the full ten minutes. Note fans.

Sampler first, then the run within ten seconds. `<run>` is A, A-idle, A-cpu, B, or C.

```bash
sudo powermetrics --samplers cpu_power,gpu_power -i 1000 -n 600 -o "$PWD/results/laptop/<run>-powermetrics.txt" &
pmset -g batt | tee results/laptop/<run>-batt-start.txt
```

After ten minutes:

```bash
pmset -g batt | tee results/laptop/<run>-batt-end.txt
awk '/CPU Power/ {c+=$3; n++} /GPU Power/ {g+=$3} /Combined Power/ {t+=$8} END {printf "samples %d  CPU %.0f mW  GPU %.0f mW  combined %.0f mW\n", n, c/n, g/n, t/n}' results/laptop/<run>-powermetrics.txt
```

At minute five: `top -l 1 -stats pid,cpu,command | grep -i chrome` into `<run>-top.txt`.

### Run A: the page, sculpting

```bash
cd bench/webgpu-mesher && node run.mjs --serve 9320
```

Open `http://127.0.0.1:9320/mesher.html?src=gpu&loop=1&edit=100` in the fresh profile. Renders every frame at the bench pose and re-emits a random interior 3×3 chunk window every 100 ms, ten edits a second, a moving stroke. The top-left counter shows seconds, fps, edits, edit GPU p50 / p95. At minute ten run `JSON.stringify(__loopStats())` in the console and save it as `results/laptop/A-loopstats.json`.

### Run A-idle and A-cpu

Same, with `?src=gpu&loop=1` and `?src=cpu&loop=1`. No edits. A-idle against A-cpu should be near zero (same geometry, one has the mesher's extra buffers resident). Five minutes each is acceptable if time is short; say so in the notes.

### Run B: the shipped client, idle at the same pose

```bash
TERRACE_PERF_SINK="$PWD/bench/webgpu-mesher/results/laptop/B-client-overview.json" python3 run_server.py
```

Open the Local URL Vite prints, in the fresh profile: `http://localhost:5173/?perfprobe=overview&settle=600000`. The probe parks the camera at the app's default pose, which is the page's bench pose, samples frames, and posts its block to the sink when the settle expires. Copy frame p50 / p95 / p99 out of it. Quit `run_server.py` with `q` so the server writes its shutdown snapshot.

### Run C: the shipped client, sculpting by hand

Plain client, no probe. The owner sculpts continuously for ten minutes at roughly ten strokes a second. Hand-driven, not repeatable; say so.

## Step 4: write and commit

`bench/webgpu-mesher/results/laptop/notes.md`:

```
adapter: <vendor, architecture, timestamp-query yes/no, browser + version>
macOS: <version>   display: <refresh Hz>   brightness: <level>
step 2: draw gpu/cpu p50, rebuild wall/gpu, edit heaviest p50/p95/max, edit median p50/p95/max

| run | what | fps | battery start → end | CPU mW | GPU mW | combined mW | Chrome CPU % | fans |
|---|---|---|---|---|---|---|---|---|
| A | page gpu, edit=100 | | | | | | | |
| A-idle | page gpu, no edits | | | | | | | |
| A-cpu | page cpu mesh, no edits | | | | | | | |
| B | client, probe overview, idle | | | | | | | |
| C | client, hand sculpting | | | | | | | |
```

Then:

```bash
git checkout -b gate2-laptop
git add bench/webgpu-mesher/results/laptop
git commit -m "bench: gate 2 laptop power results"
git push -u origin gate2-laptop
```

`.gitignore` re-includes everything under `results/`, so the pngs and `results.json` there are tracked; confirm with `git status` before committing.

## Reading it

- A-idle against B: raw WebGPU drawing the same geometry versus the whole three.js scene with plugins. That gap is the most a TSL rewrite could recover.
- A against A-idle: the mesher's cost at ten edits a second on Apple silicon.
- B against C: what sculpting costs in the shipped client today.
- If both A-idle and B run at the display's refresh rate with high combined mW, a 60 fps frame cap is the cheapest lever and independent of every other decision.

Kill criterion, written before the run: if A draws more combined mW than C, or if step 1 finds no adapter, WebGPU does not solve the laptop's power problem.
