# Brief: GLB loader contract tests (thin)

Repo: /mnt/e/Development/Projects/Terrace (pnpm workspace, TS strict, Vitest).
Work ONLY in your own worktree. Create it first:
  git -C /mnt/e/Development/Projects/Terrace worktree add .claude/worktrees/glb-contract-tests -b glb-contract-tests main
Absolute worktree root: /mnt/e/Development/Projects/Terrace/.claude/worktrees/glb-contract-tests
Never edit or run git against the main checkout. Commit to branch glb-contract-tests. Do not push.

Owner has granted permission (this session) to write exactly these seven tests, and they must stay THIN:
one behavior per test, minimal fixtures, no new helpers/frameworks, no snapshot files, no new dependencies.
Fixtures: prefer in-memory GLB/glTF built inline (a tiny JSON glTF or a hand-built THREE scene) over binary files on disk.

Read first (verify from code, not comments — comments are claims, cite file:line of executed code):
- docs/model-assets.md
- client/src/render/rigAsset.ts
- the plugin host: grep for `preload` in client/src (mount sites that await TerraceClientPlugin.preload before attach, generation-checked against unmount)
- plugins/boats/client/models.ts (preloadBoatModels / installBoatKit) — reference consumer
- existing tests in client/test and plugins/boats/test for conventions (how three.js / DOM is mocked, if at all)

The seven contracts:
1. preload orders attach after load — host calls plugin.attach only after plugin.preload resolves.
2. unmount during preload never attaches — if the host unmounts while preload is pending, attach is never called.
3. rejected preload is a logged breach — a rejecting preload is caught and reported through the existing breach/log path (find the real one; do not invent one), and attach is not called.
4. rigAsset rejects a mapped material without uv.
5. rigAsset sets sRGB color space and anisotropy on loaded textures.
6. installBoatKit rejects a silhouette wider than 1 cell + tolerance (use the named constants from models.ts; no magic numbers).
7. installBoatKit rejects inverted fire anchors (fire_top not above deck_top, or whatever the code actually checks — cite the line).

Placement: 1–5 in client/test, 6–7 in plugins/boats/test. Match neighbouring file naming.

Run tests per package only, never workspace-wide:
  cd <worktree>/client && timeout 240 npx vitest run <your files>
  cd <worktree>/plugins/boats && timeout 240 npx vitest run <your files>
Also: cd <worktree> && pnpm typecheck (report result verbatim if it fails; two pre-existing client failures pickAgreesWithMesh / vertexGrid are NOT yours — do not touch them).

If a contract cannot be tested thinly (would need heavy mocking of GLTFLoader/WebGL), do NOT bloat it: skip that test, and report exactly why with file:line.

Commit message: conventional, e.g. `test(client): GLB loader and plugin preload contracts` — no attribution lines, no footers.

Final report (short): commit hash, files added with line counts, vitest output summary per package, typecheck result, any skipped contract + reason.
