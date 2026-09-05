# Brief: boats model constants → readonly accessors, then in-game eyes-on of the GLB war boat

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, SolidJS + three.js client, Node 24 server run via type stripping).
Work ONLY in your own worktree. Create it first:
  git -C /mnt/e/Development/Projects/Terrace worktree add .claude/worktrees/glb-accessors -b glb-accessors main
Absolute worktree root: /mnt/e/Development/Projects/Terrace/.claude/worktrees/glb-accessors
Never edit or run git against the main checkout. Commit to branch glb-accessors. Do not push.
Comments are claims, not evidence: verify behavior from executed code and cite file:line.

## Part A — remove the `export let` smell
plugins/boats/client/models.ts lines ~48–71 export three mutable bindings set at install time with hardcoded fallbacks:
  BOAT_WATERLINE_LIFT, BOAT_FIRE_COLUMN, BOAT_DRAW_OBJECTS.
Convert them to readonly accessors (functions or a frozen object with getters) whose value comes from the installed kit, so
(a) consumers cannot see a stale fallback after install, and (b) nothing outside models.ts can assign them.
Decide what a read-before-install should do (throw with a clear message vs. return the fallback) by reading every consumer
(grep the three names across client/ and plugins/) and the preload ordering in the host; state the choice and why in the report.
No new features, no magic numbers (keep/rename the existing named constants), keep the diff small.
Verify: cd <worktree> && pnpm typecheck; cd <worktree>/plugins/boats && timeout 240 npx vitest run. Commit (conventional message, no attribution/footers).

## Part B — eyes-on in-game
The owner has authorized (this turn) starting an AGENT-OWNED stack. Never touch the owner's running stack: never kill a process you did not launch; kill only by a pid you captured or by the owner of a port YOU chose (`ss -ltnp` in a script file). Never use inline `pkill -f`/`pgrep -f` (it self-matches and kills your shell).

Stack shape (owner-approved):
- Reference launcher: /mnt/e/Development/Projects/Terrace/.agent-stack/launch.sh. Make your own copy under a project dot-dir, e.g. /mnt/e/Development/Projects/Terrace/.glb-eyes-on/ (NOT ~ and NOT the session scratchpad — it can be swept mid-run). Run the server from YOUR WORKTREE's server/ dir.
- Use a spare PORT (e.g. 2699), WORLDS_DIR under .glb-eyes-on/worlds, DB_PATH pointing at a nonexistent file, and WORLD_SIZE=512.
- A fresh world has no villages so no boats. Copy one of /mnt/e/Development/Projects/Terrace/server/data/worlds/*.db (pick one with a fleet; try the-windward-fells.db or galewick-downs.db — copy only the .db, never open the original) into your worlds dir and write its id to `.active` (check how the server reads it in server/src).
- Client: Vite DEV server from <worktree>/client, pointed at your server: check client/vite.config.ts for the env var (memory says `VITE_SERVER_URL=ws://localhost:<port> npx vite --port <vite port>`, unverified). Never `vite build`. Vite on /mnt/e does not watch files — restart it after any edit.
- Screenshots: Playwright/Chromium via raw CDP or headless; Chrome DevTools MCP is unreliable in WSL2. Look for an existing screenshot rig (grep for `__terrace` in client/src and for playwright scripts under client/.*.mjs in the main checkout — read-only) and reuse its pattern.
- Tear down everything you launched when done (server, vite, chromium). Verify with `ss -ltnp` that your ports are free and no chrome-headless-shell of yours remains.

Deliverable: 3–5 in-world PNGs of a live fleet of GLB war boats from game camera angles (close-up showing hull texture, mid shot of several boats on water showing waterline, one with a boat on fire if achievable via the admin/torch path — see client/.torch-fleet.mjs in the main checkout for how earlier agents did it). Save PNGs under /mnt/e/Development/Projects/Terrace/.glb-eyes-on/shots/. Check specifically: hull sits at the waterline (not floating, not submerged), fire column sits on the deck, texture is sRGB (not washed out), no missing-material magenta, no z-fighting. Report anything wrong with a screenshot of it.

Final report (short): Part A commit hash + the read-before-install decision; Part B absolute PNG paths with one line each on what they show; any defect seen; confirmation of teardown. Do NOT merge.
