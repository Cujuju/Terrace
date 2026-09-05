# Phase 2b brief — the `music` plugin: generator lane + gauges + wiring, GH #325

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-music` (branch `audio-music`,
cut from main 8798463). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-music" })`.
Run `pnpm install --offline --frozen-lockfile` there once; after you add
`plugins/music/package.json`, run `pnpm install --offline` once more and commit the
`pnpm-lock.yaml` change (importers only — no new versions may appear; if one does, stop
and report). Paths below are relative to the worktree root. Commit as you go (conventional
commits, first line < 72 chars, NO attribution footers, stage exact paths only). Do NOT
merge to main. Do NOT push. Do NOT start the shared dev server; run your own Vite on a free
port, pid file, kill by pid, never `pkill -f`.

Read first, binding: `.claude/plans/audio-host.md` §8 (the whole design — this brief only
adds the mechanics), root `CLAUDE.md`, `docs/DESIGN.md` rules, `docs/decisions/plugin-host.md`
(2026-08-26 sibling decision, 2026-09-01 isolation rule). Then, from source, not comments:
`client/src/plugins/types.ts` (`PluginAudio`, `publishMovers`, `moverPose`),
`client/src/plugins/host.ts` (`moverLookups`, `publishMovers`, `moverPose`, the `audioHandle`
wiring), `client/src/audio/audioEngine.ts` (`musicClaimant`, `buildHandle.setMusic`,
`releasePlugin`, `createSilentAudioEngine`), `client/src/audio/audioVoices.ts` (`setMusic`,
`musicUrl`, `stopAll`), `client/src/audio/audioDebug.ts`, `plugins/music/client/composer/composer.ts`
(`createComposer`, `Composer`, `DEFAULT_MOOD`), `plugins/rain/client/index.ts`
(`rainWeightUnderCamera`, the ambience onFrame), `plugins/thunderstorm/client/index.ts`
(`view.poses()`, `shadeDiscs`), `plugins/daynight/client/index.ts` (the onFrame that calls
`interpolator.samplePhase()`), `plugins/rain/{package.json,tsconfig.json}`,
`client/src/plugins/registry.ts`. Comments are claims; verify each mechanism at file:line
before relying on it, and cite file:line in the report.

## Deliverables, in commit order

1. **Contract: generator lane.** `types.ts`: add `MusicOutlet`, `MusicGenerator`,
   `PluginAudio.setMusicGenerator` exactly as plan §8.2(a), with the doc comments there
   (≤ 30 words per comment — the repo's cap; the plan's prose is the source, compress it).
   `audioVoices.ts`: a lane `GainNode` per generator claim on `buses.music`; start/release
   ramps per §8.2(a); one `currentMusicSource` discriminating `{ kind:'url', url } |
   { kind:'generator' } | null` so `setMusic`, `setMusicGenerator`, `musicUrl()` (keep its
   name and behaviour: null while a generator plays) and `stopAll` all agree. Constants
   reused: `MUSIC_CROSSFADE_SECONDS`, `MUSIC_TRACK_GAIN`, `FADE_STOP_SLACK_SECONDS`,
   `SILENT_GAIN`. `audioEngine.ts`: `buildHandle.setMusicGenerator` goes through the SAME
   claim/refuse path as `setMusic`; `releasePlugin` releases a generator like a url;
   `createSilentAudioEngine` arbitrates but never calls `start`. Debug log line per §8.2(a).
2. **Contract: gauges.** `types.ts` `publishGauge` / `gauge` per §8.2(b); `host.ts`
   `gaugeLookups` keyed `"<plugin>:<key>"`, mirroring `moverLookups` including the
   `track()` teardown and the "same lookup still registered" guard on unpublish.
3. **Publishers.** daynight `phase`; rain `weightUnderCamera` (call the existing function,
   do not move it); thunderstorm `weightUnderCamera` with a thunderstorm-local disc loop
   (same shape as rain's — a documented copy, header comment says so in ≤ 30 words). Each
   publisher's unpublish runs in the plugin's existing dispose path.
4. **Plugin package.** `plugins/music/package.json` (`@terrace/plugin-music`, scripts and
   devDeps as rain's, dependencies `@terrace/shared` + `three` only — drop anything the
   code does not import; verify), `plugins/music/tsconfig.json` (rain's, include
   `["client"]`), then lockfile refresh per the preamble.
5. **Plugin.** `plugins/music/client/index.ts` per §8.2(c): `MUSIC_PLUGIN_NAME = 'music'`,
   `MUSIC_SEED`, `MOOD_SAMPLE_MS`, `MOOD_GAUGES` (documented copies of the three
   publisher names/keys), `TENSION_GAUGE` (present, unpublished — read returns null →
   tension 0), `drawBudget` 0 (verify what a non-drawing plugin declares — copy the
   convention, e.g. chronicle or invite). Under `AUDIO_DEBUG` only (import the flag from
   `client/src/audio/audioDebug.ts` by relative path, as plugins import `types.ts`), log
   each sampled mood once per change ≥ 0.05 in any component. Register LAST in
   `registry.ts` with a one-line comment.
6. **Report** `.claude/orchestration/briefs/audio-music-p2b-report.md`: shipped API with
   file:line; the constants table with justifications; the `?audioDebug=1` traces listed in
   plan §8.5 (claim → lane ramp → mood lines while moving the camera under rain; refused
   claim with `?audioMusic=`; detach fade with node count stable after); typecheck +
   vitest output (client, rain, thunderstorm, daynight, music; `timeout 120` each);
   deviations from §8 with reasons; residuals.

## Hard constraints
- No tests (owner rule; not granted). No new dependency versions. Web Audio only.
- Don't touch `shared/`, `server/`, `docs/`, `client/src/ui/**`, `client/src/state/**`,
  `client/src/previewMusic.ts`, `client/preview-music.html`, `plugins/music/client/composer/**`
  (if the composer needs a change to be driven, STOP and report — it should not), or any
  plugin other than daynight / rain / thunderstorm / music.
- Comments: ≤ 30 words each, only where necessary. No magic numbers: every literal is a
  named constant with a one-line justification.
- Every `PluginAudio` method stays safe pre-unlock / pre-snapshot / post-detach; verify
  `setMusicGenerator` against a suspended context (start is called, composer produces
  nothing until resume — composer.ts's documented behaviour) and after `release`.
- Headless Chromium for the traces: `--autoplay-policy=no-user-gesture-required`; your own
  Vite + your own server instance on free ports, both by pid file, torn down when done.
