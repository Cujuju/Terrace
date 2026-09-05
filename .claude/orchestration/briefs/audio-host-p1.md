# Phase 1 brief — audio host (`ctx.audio`), GH #325

You are a fresh implementation agent. Work ONLY in the worktree
`/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-host` (branch `audio-host`,
== main 7a6eced; `pnpm install` already done). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-host" })`.
Paths below are relative to the worktree root. Commit to the branch as you go
(conventional commits, first line < 72 chars, NO attribution footers, stage exact paths
only — never `-A`). Do NOT merge to main. Do NOT push.

Read first (binding, do not relitigate):
- `.claude/plans/audio-host.md` — §2 is the design you implement, §5 the residuals you
  document, §7 the defaults you follow.
- `client/src/plugins/types.ts` (the ctx contract; match its comment style — every member
  says WHY it exists and what it must not do), `client/src/plugins/host.ts` (esp. the
  `setSkyRig` single-claimant at :754 and the `track()` teardown pattern — reuse both),
  `client/src/render/scene.ts` (`Viewport`, `camera`, `onFrame` phases),
  `client/src/state/controlPrefs.ts` + `client/src/ui/ControlsPanel.tsx` + `Hud.tsx:453–460`
  (prefs + settings popup pattern), `plugins/thunderstorm/client/index.ts:156`,
  `plugins/rain/client/index.ts` (the two consumers).
- Root `CLAUDE.md` and `docs/DESIGN.md` rules. Global rules that bind you: no magic
  numbers (every literal is a named constant with a one-line justification); no new
  dependencies; never store a reactive read in a component-body const; a `.tsx` exports
  only components; 140 fps budget (audio does NO per-frame JS work beyond a gain
  comparison; Web Audio schedules on its own thread).

## Deliverables

1. **Core** `client/src/audio/`:
   - `audioEngine.ts`: lazy single `AudioContext`; `AudioListener` added to
     `viewport.camera`; three `GainNode` buses (`sfx`, `ambience`, `music`) → master gain →
     destination; master follows `audioPrefs` (volume × mute) via ramps; unlock on the
     host's capture-phase canvas `pointerdown` PLUS one-shot `window` `keydown`/`pointerdown`;
     pending ambience/music requests made before unlock start on unlock; URL-keyed decode
     cache (one in-flight promise per URL); one-shot voice pool `MAX_SFX_VOICES = 32`,
     oldest-stolen; positional voices (`PositionalAudio`, distance model `'inverse'`,
     `refDistance`/`maxDistance` as named constants expressed in world units derived from
     `client/src/config.ts` scale constants — cite which) parented into a core-owned
     `Group` in the scene, never a plugin layer.
   - Per-plugin handle factory the host calls: gives each plugin its own `PluginAudio`
     and a `release()` the host wires into the plugin's teardown so voices never outlive
     their plugin.
   - Dev switch `?audioDebug=1` (match the query-flag convention in
     `client/src/perfProbe.ts:576`): logs every playSfx/ambience/setMusic call with bus,
     gain, position, live voice count. Dev switch `?audioMusic=<url>`: core calls
     `setMusic(url)` on behalf of a synthetic claimant so the music path is exercised with
     no consumer plugin. Both off by default and zero-cost when off.
2. **Contract** in `client/src/plugins/types.ts`: `readonly audio: PluginAudio` with
   `playSfx(url, {at?, gain?, playbackRate?})`, `ambience(url, weight)`,
   `setMusic(url | null)` exactly as plan §2.2 (semantics: single-claimant music with the
   once-per-loser refusal; ambience keyed by (plugin, url), retarget-on-repeat, weight 0
   fades out then releases; every call safe pre-unlock / pre-snapshot / post-detach).
   Wire it in `host.ts`; release on detach.
3. **Prefs + UI**: `client/src/state/audioPrefs.ts` (master volume 0..1 default
   `DEFAULT_MASTER_VOLUME = 0.8`, muted default false; versioned localStorage key like
   controlPrefs) and one row (slider + mute toggle) in the existing settings popup. Keep
   it to the existing `hud.css` vocabulary; no new visual language.
4. **Consumers**:
   - `thunderstorm`: per strike, `ctx.audio.playSfx(THUNDER_SFX_URL, { at })` where `at`
     is the strike's world position the plugin already computes for its flash.
   - `rain`: `ctx.audio.ambience(RAIN_LOOP_URL, weight)` where weight is the rain
     intensity under the camera cell that the plugin already derives (verify from source
     what it has; if it does not have a camera-cell intensity today, derive it from the
     `systems` discs and `ctx.cameraPosition()` in the plugin's own onFrame, clamped 0..1).
5. **Placeholder assets**: `scripts/audio-placeholders.py` (python3 + numpy, fixed seed,
   22 050 Hz mono 16-bit WAV) writes `plugins/thunderstorm/client/assets/thunder.wav`
   (≤ 3 s, low-passed noise burst with decay) and `plugins/rain/client/assets/rain-loop.wav`
   (≤ 8 s, seamless loop: crossfade the tail into the head). Import with `?url`. Header
   comments in the consuming plugin name the file as a PLACEHOLDER.
6. **Report** `.claude/orchestration/briefs/audio-host-p1-report.md`: what shipped with
   `file:line` for every contract claim; the `?audioDebug=1` console log from your own
   stack showing ≥1 thunder strike (positional, voice count) and a rain fade in and out;
   typecheck + test output; every deviation from the plan and why; residuals.

## Hard constraints

- No tests. Owner rule: none without per-session permission, and none was granted.
- Comments are claims, not evidence: verify behaviour from source lines; cite `file:line`.
- Don't touch `docs/DESIGN.md`, `docs/decisions/*`, `.claude/**` (except your report),
  `shared/`, `server/`, any plugin other than `thunderstorm` and `rain`.
- You MAY start/stop your OWN isolated stack from the worktree to capture the debug log
  (owner permission for this session is delegated by the orchestrator for the worktree
  ONLY). Never the owner's stack, never from the main checkout. Copy an existing stack
  recipe (e.g. `.phase1-stack/launch.sh`/`stop.sh` if present in git history, or
  `.glb-eyes-on/` on the main checkout — read-only) into `.audio-stack/` in the worktree;
  free port (check `ss -ltn`); `WORLDS_DIR` + nonexistent `DB_PATH` under `.audio-stack/`;
  kill by pid file, NEVER an inline `pkill -f`/`pgrep -f`. Tear down when done. Browsers
  in WSL have no audio device: verify the graph via the debug log and
  `AudioContext.state`, not by listening. If headless Chromium refuses to unlock, use
  `--autoplay-policy=no-user-gesture-required` and say so in the report.
- `pnpm typecheck` at the worktree root must be clean. Run `vitest run` ONLY in `client`,
  `plugins/thunderstorm`, `plugins/rain`, each with `timeout 120`. Never `pnpm -r test`.
- If something in the plan is impossible as written, do everything else, name the gap in
  the report, and stop — do not redesign.
