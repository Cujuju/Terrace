# Restart and persistence

Dated decisions moved out of `docs/DESIGN.md` on 2026-09-01. Settled with the owner; do not relitigate without new information.

## Decisions made 2026-08-25 (restart is one button; a slice carries its version)

Phase 1 of `docs/plans/plugin-hot-unload.md` — the operator path for "I have a
new version of a plugin's code and I want it live". Node's ESM module map has no
eviction, so the PROCESS is the unit of code identity and a restart is how new
code arrives; the whole of this work is making that restart cheap, honest and
safe rather than making it unnecessary.

**Restart is an admin action, not a terminal command.** `serverRestart` is a
world-admin message gated by the same key as everything else in that union,
announced and counted down whenever somebody other than the operator is
connected (`WORLD_SWITCH_COUNTDOWN_S`, shared with the world switch because it
is the same courtesy to the same people). The exit sequence has exactly one
correct order — `await gameServer.gracefullyShutdown(false)`, so the existing
`onBeforeShutdown` still stops the tick loop and writes the final snapshot, and
only then `process.exit(TERRACE_RESTART_EXIT_CODE)`. Passing `false` is
mandatory, not stylistic: the default form ends in its own
`process.exit(0|1)` and never returns, which would make the distinguished code
unreachable.

**The code is 75** (`EX_TEMPFAIL`, "temporary failure, retry me"). It has to be
in 1–255 and clear of every code a supervisor already reads: 0 clean exit, 1
boot failure, 2 shell misuse, 128+N a signalled death. Verified through
`pnpm start`, which propagates it unchanged.

**run_server.py gained a restart branch, not a reclassification.** It had no
restart-on-exit path for ANY code, so the in-game button would have taken the
whole dev stack down. On 75 it relaunches the server, re-takes the watch
snapshot first, and leaves Vite running — with a loop guard of 3 restarts inside
60 monotonic seconds, after which it gives up so a failure is visible instead of
spinning. It overlaps the existing `r` key deliberately: `r` restarts both
halves from the terminal, the button restarts the server only and is reachable
by an admin who is not at that terminal, warns connected players first, and
works in docker and systemd where there is no terminal at all.

**Per-plugin build stamps, derived from content.** Discovery stamps each plugin
`<package version>+<git tree hash of plugins/<name>>`, with a
`-dirty.<digest of its status + diff>` suffix when there are uncommitted
changes. The TREE hash, not "the last commit that touched the directory":
identical bytes must stamp identically and a revert must stamp as the bytes it
went back to. The dirty marker carries CONTENT rather than being a flag,
because a bare `-dirty` would make two different edits stamp the same and the
second edit would be invisible — which is the dev loop the stamp exists to
serve. Shown in the boot log, on `worldPluginListing`, and beside each toggle in
the world panel.

**The client's page reload keys on a build identity, never on `serverVersion`.**
`serverVersion` is a git-HEAD stamp: byte-identical across a restart that picked
up an uncommitted edit, and the constant `'unversioned'` wherever there is no
`.git`, so a reload keyed on it would fail to fire in both cases it exists for.
`JoinSnapshotMessage.buildIdentity` is a digest over core's stamp, every
plugin's stamp, and the served bundle's `index.html` (whose asset URLs carry
Vite's content hashes, so a core-client change — which belongs to no plugin —
moves it too). No per-boot nonce: that would reload after a restart that changed
nothing. The client reloads once, at most once per identity ever (remembered in
`sessionStorage`, so a browser that hands the reload a cached `index.html` gets
one warning instead of a loop).

**Docker must inject `TERRACE_VERSION` at image build** or both stamp families
are dead there — the image ships no `.git`. It is a server-stage build arg
written into the image environment, passed through by compose. Unset is safe but
conservative: the stamps fall back to a per-boot value, so every restart looks
like a new build and open pages reload. In docker a restart usually IS a
redeploy, so that is rarely a false alarm.

**A snapshot slice now carries its version, and the host owns it.** Nine of the
sixteen plugins have a slice; six had invented a version field of their own,
three had none at all, and NONE of them could tell a slice written by a NEWER
build. Every one of the six answered that case by returning its own empty state
— which the next snapshot then wrote over the real one, demolishing the town,
erasing the forest or losing the chronicle about a minute after a downgrade. So:
`PersistenceSlice.version` is required, the host wraps every save as
`{ v, data }`, and `load(data, fromVersion)` may return `'refuse'`.

- **A stored value with no envelope is version 1**, handed to `load(data, 1)`
  and rewritten in envelope form on the next save. This is 100 % of the bytes on
  every world file that exists, and it is PERMANENT rather than a one-boot
  migration: `restore_points` hold old `plugin_slices` rows forever, so a
  rollback reads through the same rule for as long as that point exists.
  **History is never rewritten.** A restore point is a record of a moment, and
  restamping its bytes into a shape the moment did not have would falsify it.
- **A stored version ahead of the code, or a refusal, PARKS the slice**: the
  bytes are re-emitted verbatim and the plugin runs stateless with a logged
  warning. Parking needed a host-side WRITE-SUPPRESS set, not just the existing
  dormant map: `collectPersistence` writes every enabled plugin's save over the
  record it seeds from that map, so a parked plugin's own empty save would
  overwrite the parked bytes at the next snapshot. The rule in one line: **a
  slice key has exactly one writer per session, and parking makes the host that
  writer.**
- **The six self-describing plugins prefer their OWN version field** when the
  data has one, and use `fromVersion` only as the fallback. This is a deliberate
  departure from the plan's "the envelope's `v` is the authority": a
  pre-envelope monsters slice reads as version 1 while its own data says 3, so
  trusting the envelope would run a v1 migration over v3 bytes on the first boot
  after this change. The envelope is authoritative for what the envelope wrote;
  the plugin's field is authoritative for what predates it.

**Press-to-playable, MEASURED (2026-08-25, not estimated).** On an isolated rig
(own port, own worlds directory, one real browser client, a 256² world), from the
restart notice appearing to the page having terrain again: **21.1 s** (5 runs,
min 21.06 s, median 21.08 s, max 21.27 s — remarkably tight). Decomposed:

- **~8.5 s** press → the listening socket closing. Colyseus's own
  `gracefullyShutdown`, after the final snapshot is written.
- **~9.3 s** of the boot importing the sixteen plugin server modules.
- **~7.5 s** more to world open and listen.

The plan's estimate was 2–5 s and was wrong by a factor of four, for one
reason: this checkout lives on `/mnt/e`, a WSL2 drvfs mount, and module import
off it is an order slower than a native filesystem. The number to quote for a
deployment on real storage is therefore NOT this one — but the number to quote
for the owner's dev loop is, and it is why the client's one-shot reload matters:
twenty seconds is long enough that a stale page would otherwise be noticed and
manually refreshed. Two things would move it if it ever needs moving: Colyseus's
shutdown wait, and where the repo lives.
