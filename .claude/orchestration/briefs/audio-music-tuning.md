# Brief — live music tuning panel in Settings (`music` plugin), GH #325

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-tuning` (branch `audio-tuning`,
cut from main 242d60d). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-tuning" })`.
Run `pnpm install --offline --frozen-lockfile` once; after editing `plugins/music/package.json`
run `pnpm install --offline` once more and commit the lockfile (importers only; a new VERSION
appearing = stop and report). Paths relative to the worktree root. Commit as you go
(conventional commits, first line < 72 chars, NO attribution footers, stage exact paths only).
Do NOT merge, push, or touch the shared checkout or shared dev server. Own Vite/server/Chromium
on free ports, pid files, kill by pid, never `pkill -f`, torn down when done.

Read first, binding: `.claude/plans/audio-host.md` §8; root `CLAUDE.md` (SolidJS reactivity
rule: never store a reactive read in a component-body const; a `.tsx` exports only components);
`docs/decisions/plugin-host.md`. Then from source, not comments, with file:line:
`client/src/plugins/types.ts` (`registerHudPanel`), `client/src/ui/Hud.tsx` (how the
`'connection'` placement is rendered inside `.hud-connection-popup`, and the settings popup
that renders `ControlsPanel` then `AudioSettingsPanel`), `client/src/ui/AudioSettingsPanel.tsx`
(SliderRow pattern, classes `hud-row controls-row audio-row`, `audio-slider`, `audio-readout`,
`controls-reset`), `client/src/state/audioPrefs.ts` (versioned localStorage prefs with
module-scope signals — the persistence pattern to copy), `plugins/invite/client/{index.ts,
state.ts,InvitePanel.tsx}` (a plugin owning a Solid panel), `plugins/music/client/index.ts`,
`plugins/music/client/composer/{composer,theory,voices}.ts` (every constant you will turn
into a dial), `client/src/previewMusic.ts` (must keep compiling and working unchanged).

## Why

The owner is tuning the score by ear and wants the dials in-game (owner 2026-09-05). The
plugin owns its sound, so the plugin owns the panel; core only gains a place to put it.

## Deliverables, in commit order

1. **Contract: `'settings'` placement.** `registerHudPanel` placement union gains
   `'settings'`: rendered inside the settings popup, BELOW `AudioSettingsPanel`, same
   `<For>`/`<Dynamic>` filter pattern as `'connection'`. Doc comment ≤ 30 words. Nothing else
   in core changes.

2. **Composer tuning.** New `plugins/music/client/composer/tuning.ts` exporting
   `interface ComposerTuning` and `DEFAULT_TUNING: ComposerTuning` whose values are TODAY'S
   constants (move each constant's justification comment here, ≤ 30 words each). Fields:
   `tempoBpm` (64), `padToneGain` (0.044), `padDetuneCents` (7), `padAttackSeconds` (3),
   `padReleaseSeconds` (3.5), `shimmerGainFraction` (0.3), `pluckPeakGain` (0.18),
   `pluckDurationSeconds` (3.2), `melodyDensityScale` (1 — multiplies the mood-derived
   density before the max-density clamp), `offbeatDensityFactor` (0.55),
   `filterNightCutoffHz` (380), `filterDayCutoffHz` (2800).
   - `createComposer(context, destination, seed, tuning?: ComposerTuning)` defaults to
     `DEFAULT_TUNING`; `Composer` gains `setTuning(tuning: ComposerTuning): void`.
     `renderComposition` unchanged in signature (uses defaults) — previewMusic.ts untouched.
   - LEVELS ARE HEARD AT ONCE: add three glided `GainNode`s in the engine — `padBus`,
     `shimmerBus`, `melodyBus` — each → `moodFilter`. Voices no longer bake the level into
     the envelope: a pad tone's envelope peaks at unity and the bus carries `padToneGain`;
     each tone's shimmer oscillator gets its OWN envelope gain (same shape as the tone's)
     → `shimmerBus`, whose gain is `padToneGain * shimmerGainFraction`; plucks peak at
     `velocity` and `melodyBus` carries `pluckPeakGain`. `setTuning` retargets the three bus
     gains and the filter cutoffs with `setTargetAtTime` using the existing
     `MOOD_GLIDE_TIME_CONSTANT_SECONDS`. Keep `moodParameters` pure: pass the two cutoffs in
     (extend its signature with the tuning or the two numbers; your call, cite it).
   - FUTURE EVENTS read the rest: detune, attack/release, duration, density scale, offbeat
     factor are read from the CURRENT tuning at schedule time inside `pumpUntil`.
   - TEMPO changes land on the next CHORD BOUNDARY only, so the grid never tears: hold a
     `pendingTempo`; when `beatIndex % BEATS_PER_CHORD === 0` and it is set, re-anchor
     (`startTime = that beat's time`, `nextBeatIndex` reset so the boundary beat is index 0,
     chord counting continues from a separate counter — chord index must NOT restart).
     `SECONDS_PER_BEAT`/`SECONDS_PER_CHORD` in theory.ts become functions of the tuning (or
     the engine derives them); no consumer may keep a stale copy. Update the composer.ts
     header where it states determinism: same seed + same mood timeline + same tuning
     timeline ⇒ same note stream.
   - Headroom: document in tuning.ts the worst-case sum at the dial MAXIMA below and show
     it stays under 1.0 before `OUTPUT_LEVEL`, or cap the maxima so it does.

3. **Plugin state + panel.** `plugins/music/client/tuning-state.ts`: module-scope Solid
   signal holding a `ComposerTuning`, persisted in `localStorage` key
   `terrace.musicTuning.v1` (copy audioPrefs.ts's load/validate/save shape: every field
   checked finite and clamped into its dial range, unknown/invalid → default). Exports
   `musicTuning()`, `setMusicTuningField(field, value)`, `resetMusicTuning()`.
   `plugins/music/client/MusicTuningPanel.tsx`: exports ONLY the component. One slider row
   per field in the order above, `<input type="range">` with per-field min/max/step from a
   `DIALS` table in tuning-state.ts (`{ label, min, max, step, unit }`), readout showing the
   number with its unit (bpm, ¢, s, Hz, ×, or a percent for gains), a `Reset music` button
   (`controls-reset`), and a small heading row "Music" so it reads as its own block under
   the audio sliders. Reuse the audio classes; add NO new CSS unless a class is missing,
   and then add it beside the `.audio-*` rules in the client's existing stylesheet. Dial
   ranges: tempo 40–96 step 1; padToneGain 0–0.12 step 0.001; detune 0–20 step 0.5; attack
   0.2–6 step 0.1; release 0.2–8 step 0.1; shimmer 0–1 step 0.01; pluckPeakGain 0–0.4
   step 0.005; duration 0.5–6 step 0.1; densityScale 0–2 step 0.05; offbeat 0–1 step 0.05;
   night cutoff 100–1500 step 10; day cutoff 500–6000 step 50. Justify each range in one
   line in the table's comment (≤ 30 words).
   Add `solid-js` `^1.9.14` to `plugins/music/package.json` dependencies (rain's version).

4. **Wiring.** `plugins/music/client/index.ts`: `ctx.registerHudPanel(MusicTuningPanel,
   { placement: 'settings' })` in attach; create the composer with `musicTuning()`; a
   `createEffect`/`createRoot` (or a plain subscription — cite the pattern you copy from
   an existing plugin) pushes every tuning change to `composer.setTuning`, disposed in
   `dispose`. The `?audioDebug=1` mood log line adds the current `tempoBpm` and
   `padToneGain` so a trace shows tuning changes landing.

5. **Report** `.claude/orchestration/briefs/audio-music-tuning-report.md`: API with
   file:line; the DIALS table; headroom arithmetic; `pnpm typecheck` at root and `vitest
   run` (timeout 120) in `client` and `plugins/music` verbatim; a `?audioDebug=1` trace
   showing (a) a pad gain change heard within one glide, (b) a tempo change taking effect
   exactly at a chord boundary (log the re-anchor under the debug flag), (c) a reload
   restoring the persisted tuning; a screenshot of the settings popup with the Music block
   open, saved under `.claude/orchestration/refs/music-tuning/` and referenced from the
   report; deviations; residuals.

## Hard constraints
- No tests (owner rule; not granted). No new dependency versions. Web Audio only.
- Don't touch `shared/`, `server/`, `docs/`, `client/src/audio/**`, `client/src/state/**`,
  `client/src/previewMusic.ts`, `client/preview-music.html`, or any plugin other than music.
  In core, ONLY the `'settings'` placement (types.ts + Hud.tsx) and, if needed, the CSS file.
- Comments ≤ 30 words, only where necessary. No magic numbers.
- Solid reactivity rule from CLAUDE.md is binding in the panel.
- Determinism: the offline render path (`renderComposition`) must produce the same note
  stream as before your change at default tuning — verify by running the preview's
  `?render=20&seed=1` digest before and after and quoting both in the report.
