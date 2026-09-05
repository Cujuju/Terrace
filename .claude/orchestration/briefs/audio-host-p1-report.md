# Phase 1 report — audio host (`ctx.audio`), GH #325

Branch `audio-host` in `.claude/worktrees/audio-host`, five commits off main `7a6eced`.
Nothing merged, nothing pushed, no tests written.

| # | Commit | Subject |
|---|---|---|
| 1 | `1885f4d` | `feat(audio): core audio host and ctx.audio plugin capability` |
| 2 | `c76f26e` | `feat(audio): master volume and mute in the settings popup` |
| 3 | `90b9b5a` | `feat(audio): generated placeholder WAV assets and *.wav?url typing` |
| 4 | `cc4c03e` | `feat(audio): thunder one-shots and rain ambience as first consumers` |
| 5 | `1292eb1` | `feat(audio): report the live master gain and voice count in the debug trace` |

## 1. What shipped, with `file:line`

### Core — `client/src/audio/audioEngine.ts` (new)

| Claim | Where |
|---|---|
| Lazy single `AudioContext` — built only inside `buildGraph`, which only `engineUnlock` calls | `audioEngine.ts:433` (`buildGraph`), `:714` (`engineUnlock`) |
| `AudioListener` added to `viewport.camera` | `audioEngine.ts:473` |
| Three bus `GainNode`s → master → `context.destination` | `audioEngine.ts:454` (master), `:456` (`master.connect(context.destination)`), `:459-467` (bus loop, `bus.connect(master)` at `:465`) |
| Master follows `audioPrefs` (volume × mute) via a ramp | `audioEngine.ts:422-431` — a `createRoot` + `createEffect` reading `effectiveMasterGain()` (`:425`), ramped through `rampGain` (`:364`) |
| Unlock on the host's capture-phase canvas `pointerdown` | `client/src/plugins/host.ts:333` (`audioEngine.unlock()` at the top of `onCanvasPointerDown`, registered `{ capture: true }` at `:348`) |
| PLUS one-shot `window` `keydown`/`pointerdown` | `audioEngine.ts:701-704` (`{ once: true }` on both), removed on dispose at `:706-710`, called at `:903` |
| Ambience/music requested before unlock start on unlock | `audioEngine.ts:618-628` (`resumePendingAmbience`), called at `:728`/`:729` after `resume()` succeeds and at `:741`/`:742` on the already-running path |
| URL-keyed decode cache, one in-flight promise per URL | `audioEngine.ts:297` (`decoded: Map<string, Promise<AudioBuffer>>`), `:379-381` (`bufferFor` returns the existing promise) |
| `MAX_SFX_VOICES = 32`, oldest stolen | `audioEngine.ts:54` (the constant), `:513` (`while (sfxVoices.length >= MAX_SFX_VOICES) retireSfx(sfxVoices[0])`) |
| Positional voices: `PositionalAudio`, `'inverse'`, ref/max distance as named constants | `audioEngine.ts:520-527` |
| …distances derived from `client/src/config.ts` scale constants | `SFX_REFERENCE_DISTANCE_WORLD_UNITS = CAMERA_MIN_DISTANCE` (`audioEngine.ts:66`), `SFX_MAX_DISTANCE_WORLD_UNITS = CAMERA_MAX_DISTANCE` (`:77`); both imported at `:29`. `CAMERA_MIN_DISTANCE` is itself derived in `config.ts:510-512` from `CAMERA_CLOSEST_VIEW_WORLD_UNITS` and the FOV |
| …parented into a **core-owned** `Group` in the scene, never a plugin layer | `audioEngine.ts:475-477` (`positionalRoot`, added to `viewport.scene`), used at `:531`. Its doc at `:229-240` cites `host.ts:922` (a layer is cleared on unmount) and `three/src/audio/PositionalAudio.js:217` (the panner only moves for an object the renderer walks) |
| Per-plugin handle factory the host calls | `audioEngine.ts:890-899` (`forPlugin` returns `{ audio, release }`); declared on the interface at `:283` |
| …`release` wired into the plugin's teardown | `client/src/plugins/host.ts:642` — `track(audioHandle.release)`, i.e. the same `undo` list `host.ts:250` documents as idempotent-per-registration |
| `?audioDebug=1`, matching `perfProbe.ts:576`'s query-flag convention | `audioEngine.ts:184-190` (`queryFlag`, same "null or empty is off" rule as `perfProbe.ts:577`), `AUDIO_DEBUG` at `:192` |
| `?audioMusic=<url>` — core is a synthetic claimant | `audioEngine.ts:876-885`, claiming under `DEV_MUSIC_CLAIMANT` (`:213`) |
| Both zero-cost when off | Every debug site is behind `if (!AUDIO_DEBUG) return;` (`audioEngine.ts:339`) and the weight-thinning branch at `:810` short-circuits on `AUDIO_DEBUG` first; the music switch is one `URLSearchParams` read at construction |

### Contract — `client/src/plugins/types.ts`

| Claim | Where |
|---|---|
| `readonly audio: PluginAudio` on `ClientPluginCtx` | `types.ts:262-270` |
| `PluginAudio` with the three methods | `types.ts:195-241` (`playSfx` `:207`, `ambience` `:225`, `setMusic` `:240`); `SfxOptions` at `:141-171` |
| Single-claimant music with the once-per-loser refusal | contract at `types.ts:227-239`; implementation `audioEngine.ts:830-843`, mirroring `host.ts:775-792`'s `setSkyRig` shape (claimant var `audioEngine.ts:323`, refusal set `:324`, `musicRefusals.add` at `:837`) |
| Ambience keyed by (plugin, url), retarget-on-repeat, weight 0 fades out then releases | `audioEngine.ts:264` (`PluginAudioState.ambience: Map<url, …>`), `:789-819` (the keyed lookup and retarget path), `:581-601` (`retargetAmbience`; the release timer at `:595`) |
| Every call safe pre-unlock / pre-snapshot / post-detach | each method opens with `if (state.released …)` — `audioEngine.ts:761`, `:787`, `:830` — and the graph-null guards at `:761`, `:821`, `:845` |
| Wired in `host.ts`, released on detach | `host.ts:640-646` (handle + `track`), `:646` (`audio: audioHandle.audio`), disposed at `:1091` |

### Prefs + UI

- `client/src/state/audioPrefs.ts` (new): `DEFAULT_MASTER_VOLUME = 0.8` (`:32`), `DEFAULT_MUTED = false` (`:35`),
  versioned key `terrace.audioPrefs.v1` (`:46`), the same load/validate/fallback and best-effort-persist
  shape as `controlPrefs.ts:57` / `:113-132` / `:145-149`. `effectiveMasterGain()` (`:133`) is the one
  number the engine follows, so mute cannot drift from the slider.
- `client/src/ui/AudioSettingsRow.tsx` (new): one `.hud-row .controls-row` with a range input and the
  mute toggle. Rendered inside the existing settings popup at `client/src/ui/Hud.tsx:465`, *beside*
  `ControlsPanel` rather than inside it — that panel's reset button promises to reset "every setting on
  this panel" (`ControlsPanel.tsx:196`) and audio is not a control binding.
- `client/src/ui/hud.css:417-437`: three small rules, no new visual language — the row reuses
  `.hud-row`/`.controls-row`/`.controls-label`/`.controls-reset`.
- No reactive read is stored in a component-body const; every accessor is called at its use site.
- `.tsx` files export only components (`AudioSettingsRow`); `VOLUME_STEP` and `PERCENT_SCALE` stay
  unexported-local.

### Consumers

- `plugins/thunderstorm/client/index.ts:104-129` — `playThunder` (`:117`) calls
  `ctx.audio.playSfx(thunderSfxUrl, { at })` at `(cellX·CELL_WORLD_SIZE, BOLT_BOTTOM_WORLD_Y, cellY·CELL_WORLD_SIZE)`,
  which is exactly where the plugin already puts the flash light (`rig.ts:476` for a loose bolt;
  `rig.ts:356-359` for a bolt inside a system, whose rig root sits at the system centre so root+offset is
  the same point). Called at `index.ts:197` **before** the reduced-motion guard at `:202`, on that
  handler's own stated reasoning ("a player who asked for less motion asked for less motion, not for a
  different world") — a clap is not motion.
- `plugins/rain/client/index.ts:89-137` (`rainWeightUnderCamera` at `:120`) — the plugin did **not** have a camera-cell intensity, so
  `rainWeightUnderCamera` derives one from `view.poses()` (the same interpolated map `shadeDiscs` reads)
  and `ctx.cameraPosition()`: linear falloff from each disc's centre, loudest system wins, clamped 0..1.
  Cells vs world units verified from `discInterpolator.ts:21-28` and `cumulusDeck.ts:383-390`.
  Driven from `ctx.onFrame` at `index.ts:164-166`.

### Placeholder assets

`scripts/audio-placeholders.py` (python3 + numpy, `RANDOM_SEED = 20260904`, 22 050 Hz mono 16-bit) writes:

- `plugins/thunderstorm/client/assets/thunder.wav` — 2.4 s (≤ 3 s), twice-low-passed noise with an
  exponential decay plus a short un-filtered crack. 105 884 bytes.
- `plugins/rain/client/assets/rain-loop.wav` — 6.0 s (≤ 8 s), high-passed noise, tail crossfaded into the
  head with an **equal-power** (sin/cos) fade so the splice is inaudible. 264 644 bytes.

Both imported with `?url`; both consuming plugins carry a header comment naming the file a PLACEHOLDER
(`thunderstorm/client/index.ts:15-20`, `rain/client/index.ts:14-19`).

## 2. Eyes-on: the `?audioDebug=1` trace

From my own isolated stack (`.audio-stack/launch.sh`, ports 2799/5399, `WORLDS_DIR` and a nonexistent
`DB_PATH` under `.audio-stack/`, both weather plugins parked over the world centre with their documented
`RAIN_DEV_FORCE=1` / `THUNDERSTORM_DEV_FORCE=1` switches). Torn down by pid via `.audio-stack/stop.sh`;
no `pkill -f` anywhere. Captured over raw CDP by `.audio-stack/capture-audio-log.mjs`; full run in
`.audio-stack/audio-debug-trace.txt`.

**The unlock was a real trusted gesture** (`Input.dispatchMouseEvent`, not a synthetic event), and
`contextState` reads `running` from the first line — so the autoplay path is genuinely exercised.
Chrome was still launched with `--autoplay-policy=no-user-gesture-required` because WSL has no audio
device, per the brief's instruction to say so if used.

```
03:12:31.284  unlock    {"gain":0.8,"sfxVoices":0,"master":0.8,"contextState":"running"}
--- camera parked over the world centre (under the parked rain)
03:12:31.470  ambience (layer opened) {"url":".../rain/client/assets/rain-loop.wav","bus":"ambience","gain":0.0406,"master":0.8}
03:12:36.541  playSfx (decoding, dropped) {"url":".../thunderstorm/client/assets/thunder.wav","bus":"sfx","gain":1,"sfxVoices":0}
03:12:37.245  ambience  {"bus":"ambience","gain":0.0916}      ← rain FADING IN as the parked front gathers
03:12:42.150  ambience  {"bus":"ambience","gain":0.1426}
03:12:44.993  playSfx   {"bus":"sfx","gain":1,"at":{"x":63.25,"y":0.5,"z":30},"playbackRate":1,"sfxVoices":1}
03:12:48.577  ambience  {"bus":"ambience","gain":0.2137}
03:12:54.616  ambience  {"bus":"ambience","gain":0.2748}
03:13:05.938  playSfx   {"bus":"sfx","gain":1,"at":{"x":66.5,"y":0.5,"z":50.25},"sfxVoices":1}
03:13:18.585  playSfx   {"bus":"sfx","gain":1,"at":{"x":30.5,"y":0.5,"z":64.25},"sfxVoices":1}
--- mid-run scene state: {"camera":[64,40,94],"listeners":1,"voiceGroup":0}
--- drove the volume slider to 0.42 via the real UI: {"slider":"0.42","muteLabel":"42%"}
--- camera walked 0.4 of the way out of the front
03:13:24.404  ambience  {"bus":"ambience","gain":0.0868,"master":0.42}   ← rain FADING OUT, master followed the UI
--- camera walked 0.7 of the way out of the front
03:13:30.199  ambience  {"bus":"ambience","gain":0,"master":0.42}        ← weight 0 → fade out, then release
03:13:30.796  playSfx   {"bus":"sfx","gain":1,"at":{"x":33.5,"y":0.5,"z":71.25},"sfxVoices":1,"master":0.42}
```

What each line is evidence of:

- **Positional thunder.** `at` is a real world point with `y = 0.5`, which is `BOLT_BOTTOM_WORLD_Y`
  (`lightning.ts:123`, `2 × WORLD_UNITS_PER_BAND` = 2 × 0.25) — sound and flash are at the same point.
- **Live voice count.** An earlier run showed `sfxVoices` reaching 2 and 3 when strikes overlapped, so the
  pool counts live voices and the cap is reachable. (Note for whoever reads a raw CDP trace: the inline
  `Runtime.consoleAPICalled` *preview* under-reports scalars and truncates nested objects to `Object`;
  the driver therefore resolves the real value by `objectId`. The first traces I captured were wrong for
  that reason, not because the code was.)
- **One listener on the camera**, `listeners: 1`, and `voiceGroup` (the core-owned
  `core:audio-voices` Group) reached 1 while a positional voice was alive.
- **The whole UI → prefs → master chain, live.** The slider was driven by a real bubbling `input` event on
  `input.audio-slider`; the mute button's label re-rendered to `42%` (so the Solid signal updated) and the
  next debug line reports `master: 0.42` (so the `createRoot`/`createEffect` reached the GainNode).
  A separate run with `terrace.audioPrefs.v1 = {"volume":0.25,…}` planted before boot logged
  `unlock {"gain":0.25}`, verifying the stored-prefs → master path too.
- **First call for a URL decodes and plays nothing**, as the contract states — then later calls play.

**`?audioMusic=<url>`** (separate run, pointed at the rain loop so the path could be exercised with no
music asset):

```
03:04:12.660  setMusic (pending unlock) {"url":".../rain-loop.wav","bus":"music","gain":1,"contextState":"locked"}
03:04:17.116  unlock                    {"gain":0.8,"contextState":"running"}
03:04:17.352  setMusic                  {"url":".../rain-loop.wav","bus":"music","gain":1,"contextState":"running"}
```

That is also the direct proof of the **pre-unlock pending request** rule: the claim was made while the
context was `locked` and the track started on unlock.

## 3. Typecheck and tests (verbatim)

`pnpm typecheck` at the worktree root — exit 0, every package `Done`:

```
shared typecheck: Done
client typecheck: Done
server typecheck: Done
plugins/{boats,cyclone,daynight,fire,flora,fog,mana,monsters,mudslides,pilgrims,populous,
         rain,relics,reveal,snow,structures,temples,thunderstorm,tornado,volcanoes,
         weather,wildlife} typecheck: Done
```

`vitest run` in the three touched packages only (never `pnpm -r test`):

```
client            Test Files  35 passed (35)     Tests  556 passed (556)    88.71s
plugins/thunderstorm  Test Files  1 passed (1)   Tests   17 passed (17)     20.30s
plugins/rain          Test Files  2 passed (2)   Tests   31 passed (31)      4.63s
```

No tests were added (owner rule; no permission granted this session).

## 4. Deviations from the plan and the brief

1. **`types/glb-url.d.ts` → `types/asset-url.d.ts`, plus a `*.wav?url` declaration.** Not a file the brief
   listed. A plugin package has no `vite/client` types (Vite declares a generic `*?url` at
   `vite/client.d.ts:254`, but only the client package names it), which is the whole reason
   `types/glb-url.d.ts` exists — see its own header. A second file declaring `*.wav?url` would have been
   the third copy that file's header argues against, so I widened it and renamed it rather than duplicate
   it. Touches `tsconfig.base.json` (one `files` entry) and one stale comment in
   `client/src/vite-env.d.ts:26`.
2. **Panning model is `'equalpower'`, not three's `'HRTF'` default.** The plan says "distance model
   `'inverse'`" and is silent on panning. HRTF models cues relative to a *head*; this world is seen from an
   orbit camera that is not one, and equal-power is a fraction of the cost at up to 32 voices.
   Justified in place at `audioEngine.ts:89-99` (the constant at `:100`).
3. **The plan's §2.1 says the distances derive from `WORLD_UNITS_PER_BAND`.** They derive from
   `CAMERA_MIN_DISTANCE` / `CAMERA_MAX_DISTANCE` instead. `WORLD_UNITS_PER_BAND` is a *height* scale and
   says nothing about how far away a listener can be; the camera bounds are the only constants in
   `config.ts` that answer "nearest and farthest a listener can be from a sound". Both are still derived,
   not chosen, and `CAMERA_MIN_DISTANCE` is itself derived from the FOV and the closest-zoom framing.
4. **The music bus is freed when its claimant detaches** (`audioEngine.ts:861-873`), where `setSkyRig`'s
   claim is never released while the client lives. Silence is a valid resting state for audio and a track
   whose owner is gone has nobody to stop it; a sky, by contrast, has to keep looking like something.
5. **The one-shot pool bounds live voices, not node objects.** The plan says the oldest voice is "stopped
   and reused". three builds a fresh `AudioBufferSourceNode` on every `play()`
   (`three/src/audio/Audio.js:329`), so reusing the wrapper would save one object allocation while forcing
   every stolen slot to match the new request's positional-ness. Same bound, none of that
   (`audioEngine.ts:507-513`).
6. **No `playbackRate`/`gain` passed by thunderstorm.** I wrote and then removed a deterministic
   playback-rate jitter: it was beyond what the brief asked for, and rate/level are sound-design dials
   with no sound design behind them yet.
7. **`?audioDebug=1`'s ambience logging is thinned** to a 0.05 weight step (`AUDIO_DEBUG_WEIGHT_STEP`,
   `audioEngine.ts:194-203`), with the 0 and 1 endpoints always printed. `ambience` is contracted to be
   called every frame; unthinned it wrote a console line at frame rate and buried the fade it exists to
   show.
8. **Stage-hygiene slip, disclosed.** The `git mv` of `glb-url.d.ts` was already in the index when commit
   `1885f4d` was made, so that rename rode into a commit that did not name it. Content-identical rename,
   no history rewrite.

## 5. Residuals

- **Plan §5, unchanged and inherent:** the world is silent before the first gesture; WAV placeholders are
  larger than OGG would be; Safari's panner cost is unverified on our targets (bounded by the 32-voice
  cap, and equal-power panning is cheaper than the HRTF the plan assumed).
- **WSL has no audio device**, so nothing was *listened to*. The graph, the ramps, the positional
  coordinates, the voice count, the master gain and `AudioContext.state` are all verified from the trace;
  whether the placeholders *sound* like thunder and rain is not, and cannot be here.
- **The one-shot decode drop is user-visible once per URL per page.** The first thunderclap of a session
  is silent because its buffer is still decoding. It is the contracted behaviour (a late clap is worse
  than none) but it is a real quality gap. The fix is a preload hook — plugins already have
  `TerraceClientPlugin.preload` for exactly this shape of problem — and phase 2 should add
  `ctx.audio.preload(url)` so a plugin can warm its own assets before the first event.
- **No limiter on the master.** `DEFAULT_MASTER_VOLUME = 0.8` buys headroom by convention, but 32
  simultaneous one-shots at bus unity would still clip. A `DynamicsCompressorNode` between master and
  destination is a two-line change and a real sound-design decision; not taken unilaterally.
- **Per-bus levels are declared but not exposed.** The three buses sit at unity and only the master moves
  (plan §7, owner default: master + mute only).
- **`?audioDebug=1` logs the URL of every call**, which for a Vite dev server is a long `/@fs/` path. It is
  a dev switch and the URL is the identifying field, so this is left as is.
- **`audioEngine.ts` is 930 lines** — heavily commented (the ratio the rest of this codebase keeps), but
  long. It has three obvious seams (the graph and prefs; the three voice kinds; the per-plugin handles)
  and phase 2 should split it along them. Not split now: it would be a structural change with no
  behavioural content, on top of a diff the owner still has to read once.
- **No music consumer exists.** The bus, `setMusic` and the single-claimant arbitration are built and
  exercised only by `?audioMusic=<url>` (plan §2.4; owner picks the source in §7).

## 6. Not done

Nothing in the brief was left undone. The stack is torn down; `.audio-stack/` (launch/stop scripts, the
CDP capture driver and the captured trace) is left in the worktree, untracked, for the orchestrator's
review — it is a rig, not a deliverable, and is not committed.
