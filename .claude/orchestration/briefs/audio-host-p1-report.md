# Phase 1 report — audio host (`ctx.audio`), GH #325

Branch `audio-host` in `.claude/worktrees/audio-host`, nine commits off main `7a6eced`.
Nothing merged, nothing pushed, no tests written.

| # | Commit | Subject |
|---|---|---|
| 1 | `1885f4d` | `feat(audio): core audio host and ctx.audio plugin capability` |
| 2 | `c76f26e` | `feat(audio): master volume and mute in the settings popup` |
| 3 | `90b9b5a` | `feat(audio): generated placeholder WAV assets and *.wav?url typing` |
| 4 | `cc4c03e` | `feat(audio): thunder one-shots and rain ambience as first consumers` |
| 5 | `1292eb1` | `feat(audio): report the live master gain and voice count in the debug trace` |
| 6 | `3485a84` | `docs(audio): phase 1 report for the audio host arc` |
| 7 | `d0ca65f` | `docs(audio): note the asset-url.d.ts rename for the merge` |
| 8 | `d339094` | `feat(audio): per-bus volume sliders and distance-delayed thunder` |
| 9 | `0408ab6` | `feat(audio): put each call's live bus gain in the debug trace` |

## 1. What shipped, with `file:line`

### Core — `client/src/audio/` (new)

> **Line numbers below are POST-SPLIT** (review item 4, commit `8fd8674`), which moved most of this
> code out of `audioEngine.ts` into `audioGraph.ts`, `audioVoices.ts`, `audioBuffers.ts` and
> `audioDebug.ts`. §4's table says what now lives where.

| Claim | Where |
|---|---|
| Lazy single `AudioContext` — built only inside `buildGraph`, which only `engineUnlock` calls | `audioGraph.ts:164` (`buildAudioGraph`), called unconditionally at `audioEngine.ts:74` |
| `AudioListener` added to `viewport.camera` | `audioGraph.ts:218` |
| Three bus `GainNode`s → master → `context.destination` | `audioGraph.ts:198` (master), `:200` (`master.connect(limiter)`), `:196` (limiter → destination), `:203-212` (bus loop, `bus.connect(master)` at `:210`) |
| Master follows `audioPrefs` (volume × mute) via a ramp | `audioGraph.ts:261-280` (`followAudioPrefs`) — a `createRoot` + one `createEffect` per gain, ramped through `rampGain` (`:289`) |
| Unlock on the host's capture-phase canvas `pointerdown` | `client/src/plugins/host.ts:333` (`audioEngine.unlock()` at the top of `onCanvasPointerDown`, registered `{ capture: true }` at `:348`); `unlock` itself at `audioEngine.ts:135` |
| PLUS one-shot `window` `keydown`/`pointerdown` | `audioEngine.ts:162-163` (`{ once: true }` on both), removed on dispose at `:323-324` |
| Ambience/music requested before unlock start on unlock | SUPERSEDED by review item 2 — the graph is eager, so a voice started while suspended is simply scheduled and becomes audible on resume; the pending bookkeeping was deleted. See §4 |
| URL-keyed decode cache, one in-flight promise per URL | `audioBuffers.ts:30` (`createAudioBufferCache`), `:32-34` (`get` returns the existing promise), `:55` (`peek`) |
| `MAX_SFX_VOICES = 32`, oldest stolen | `audioVoices.ts:43` (the constant), `:306` (`while (sfxVoices.length >= MAX_SFX_VOICES) retireSfx(sfxVoices[0])`); the reasoning at `:300-305` |
| Positional voices: `PositionalAudio`, `'inverse'`, ref/max distance as named constants | `audioVoices.ts:313-320` |
| …distances derived from `client/src/config.ts` scale constants | `SFX_REFERENCE_DISTANCE_WORLD_UNITS = CAMERA_MIN_DISTANCE` (`audioVoices.ts:55`), `SFX_MAX_DISTANCE_WORLD_UNITS = CAMERA_MAX_DISTANCE` (`:66`); both imported at `:14`. `CAMERA_MIN_DISTANCE` is itself derived in `config.ts:510-512` from `CAMERA_CLOSEST_VIEW_WORLD_UNITS` and the FOV |
| …parented into a **core-owned** `Group` in the scene, never a plugin layer | `audioGraph.ts:220-222` (`positionalRoot`, added to `viewport.scene`), used at `audioVoices.ts:324`. Its doc at `audioGraph.ts:136-148` cites `host.ts:922` (a layer is cleared on unmount) and `three/src/audio/PositionalAudio.js:217` (the panner only moves for an object the renderer walks) |
| Per-plugin handle factory the host calls | `audioEngine.ts:311-319` (`forPlugin` returns `{ audio, release }`); declared on the interface at `:69` |
| …`release` wired into the plugin's teardown | `client/src/plugins/host.ts:641-642` — `forPlugin` then `track(audioHandle.release)`, i.e. the same `undo` list `host.ts:250` documents as idempotent-per-registration |
| `?audioDebug=1`, matching `perfProbe.ts:576`'s query-flag convention | `audioDebug.ts:14-20` (`queryFlag`, same "null or empty is off" rule as `perfProbe.ts:577`), `AUDIO_DEBUG` at `:23` |
| `?audioMusic=<url>` — core is a synthetic claimant | `audioEngine.ts:304-306`, claiming under `DEV_MUSIC_CLAIMANT` (`audioDebug.ts:51`); the URL is read at `audioDebug.ts:30` |
| Both zero-cost when off | Every debug site is behind `if (!AUDIO_DEBUG) return;` (`audioDebug.ts:66`) and the weight-thinning branch at `audioEngine.ts:248` short-circuits on `AUDIO_DEBUG` first; the music switch is one `URLSearchParams` read at construction |

### Contract — `client/src/plugins/types.ts`

| Claim | Where |
|---|---|
| `readonly audio: PluginAudio` on `ClientPluginCtx` | `types.ts:323` (doc at `:315-322`) |
| `PluginAudio` with the three methods | `types.ts:220-294` (`preload` `:244`, `playSfx` `:260`, `ambience` `:278`, `setMusic` `:293`); `SfxOptions` at `:141-194` |
| Single-claimant music with the once-per-loser refusal | contract at `types.ts:280-292`; implementation `audioEngine.ts:265-278`, mirroring `host.ts:775-792`'s `setSkyRig` shape (claimant var `audioEngine.ts:111`, refusal set `:112`, `refuseMusic` at `:166`) |
| Ambience keyed by (plugin, url), retarget-on-repeat, weight 0 fades out then releases | `audioEngine.ts:52` (`PluginAudioState.ambience: Map<url, …>`), `:224-263` (the keyed lookup and retarget path), `audioVoices.ts:237-258` (`retargetAmbience`; the release timer at `:251`) |
| Every call safe pre-unlock / pre-snapshot / post-detach | each method opens with `if (state.released)` — `audioEngine.ts:182`, `:195`, `:225`, `:265`. The graph-null guards are gone: a browser without Web Audio gets `createSilentAudioEngine` (`:348`) instead, so the null case is decided once (see §4) |
| Wired in `host.ts`, released on detach | `host.ts:641-642` (handle + `track`), `:646` (`audio: audioHandle.audio`), disposed at `:1091`; `releasePlugin` at `audioEngine.ts:280` |

### Prefs + UI

- `client/src/state/audioPrefs.ts` (new): `DEFAULT_MASTER_VOLUME = 0.8` (`:33`), `DEFAULT_MUTED = false` (`:36`),
  a versioned key (`:100`, now v2 — see §3), the same load/validate/fallback and best-effort-persist
  shape as `controlPrefs.ts:57` / `:113-132` / `:145-149`. `effectiveMasterGain()` (`:246`) is the one
  number the master follows, so mute cannot drift from the slider.
- `client/src/ui/AudioSettingsPanel.tsx` (new; superseded the one-row `AudioSettingsRow.tsx` when §3
  added the bus sliders). Rendered inside the existing settings popup at `client/src/ui/Hud.tsx:465`,
  *beside* `ControlsPanel` rather than inside it — that panel's reset button promises to reset "every setting on
  this panel" (`ControlsPanel.tsx:196`) and audio is not a control binding.
- `client/src/ui/hud.css:418-455`: a handful of rules, no new visual language — every row reuses
  `.hud-row`/`.controls-row`/`.controls-label`/`.controls-reset`; `.audio-slider` at `:431`.
- No reactive read is stored in a component-body const; every accessor is called at its use site.
- `.tsx` files export only components (`AudioSettingsPanel`; `SliderRow` at `:59` is local);
  `VOLUME_STEP`, `PERCENT_SCALE` and `percentLabel` stay unexported-local.

### Consumers

- `plugins/thunderstorm/client/index.ts:182-207` — `playThunder` (`:195`) calls
  `ctx.audio.playSfx(thunderSfxUrl, { at, delaySeconds })` at `(cellX·CELL_WORLD_SIZE, BOLT_BOTTOM_WORLD_Y, cellY·CELL_WORLD_SIZE)`,
  which is exactly where the plugin already puts the flash light (`rig.ts:476` for a loose bolt;
  `rig.ts:356-359` for a bolt inside a system, whose rig root sits at the system centre so root+offset is
  the same point). Called at `index.ts:275` **before** the reduced-motion guard at `:280`, on that
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

## 3. Owner amendment (2026-09-04): per-bus sliders and delayed thunder

Both landed after the sections above; the trace in §2 was re-captured with them in place.

### Per-bus volume sliders

| Claim | Where |
|---|---|
| `audioPrefs.ts` persists master volume + mute AND one 0..1 level per bus | `audioPrefs.ts:113-117` (`StoredAudioPrefs`, now with `buses`), persisted at `:196-208` |
| A named default constant per bus, all 1.0 | `DEFAULT_SFX_LEVEL` / `DEFAULT_AMBIENCE_LEVEL` / `DEFAULT_MUSIC_LEVEL` at `audioPrefs.ts:77-79`, collected at `:81-85`. Master default stays 0.8 (`:33`) |
| Storage key bumped for the new shape | `terrace.audioPrefs.v1` → `terrace.audioPrefs.v2` (`audioPrefs.ts:100`), with the reasoning at `:102-110`; validated whole at `:145-149` |
| Bus names declared once | `AudioBusName` `audioPrefs.ts:51`, `AUDIO_BUS_NAMES` `:53`; `audioEngine.ts:30-35` imports both and its own local copy is gone (`:41-44` says why the declaration sits at the imported end) |
| Each bus `GainNode` follows its pref via a ramp, exactly like master | `audioEngine.ts:468-476` — one `createEffect` **per bus** inside the same `createRoot` as the master's (`:461-467`), both through `rampGain` at `MASTER_RAMP_SECONDS` |
| …and is seeded from the pref at build time, not from unity | `audioEngine.ts:515` (`bus.gain.value = effectiveBusGain(name)`), matching the master's own seed |
| One signal per bus, so one slider moves one node | `audioPrefs.ts:181-185`, with the reason at `:174-180`; `busLevel` `:190`, `setBusLevel` `:228`, `effectiveBusGain` `:261` |
| Mute stays the master's business, so the mix survives it | `audioPrefs.ts:252-260` — `effectiveBusGain` is the level and nothing else |
| One compact block in the existing settings popup | `client/src/ui/AudioSettingsPanel.tsx` (replaces `AudioSettingsRow.tsx`), rendered at `Hud.tsx:465` |
| …same `hud.css` vocabulary, no new visual language | `hud.css:418-455`: the separating rule moves to the block (`.audio-panel`, `:418`) so it is drawn once rather than per row; `.audio-readout` (`:442`, `:452`) shares the mute button's fixed width so the four sliders line up |
| Four rows, one row shape | `SliderRow` at `AudioSettingsPanel.tsx:59`, a `For` over `AUDIO_BUS_NAMES` at `:122`. Accessors are passed as props, never read into a component-body const |

Verified live in the trace: the four labels render `["Volume","Effects","Ambience","Music"]`, driving the
Effects and Music sliders through real `input` events gives readouts `["42%","30%","100%","15%"]`, and
localStorage holds
`{"volume":0.42,"muted":false,"buses":{"sfx":0.3,"ambience":1,"music":0.15}}`. The proof that this
reaches the graph and does so *independently* is the `busGain` field, read off the live `GainNode` on
every log line: the sfx lines go `busGain: 1` → `busGain: 0.30000001192092896` after the drag while the
ambience lines stay at `busGain: 1`.

### Thunder delayed by distance

| Claim | Where |
|---|---|
| `playSfx` gains an optional `delaySeconds` | `types.ts:193`, contract at `:169-192` |
| Pure Web Audio scheduling — no timers, no per-frame work | `audioEngine.ts:608` (`voice.play(delay)`), which is three's `Audio.play(delay)` setting `_startedAt = context.currentTime + delay` and passing it to `source.start()` — verified at `three/src/audio/Audio.js:329-338`. Comment at `audioEngine.ts:580-586` |
| Sanitised at the door (negative / non-finite → 0) | `audioEngine.ts:396-400`, called at `:598` |
| A scheduled voice counts against the 32-voice pool from creation | `audioEngine.ts:614` — pushed immediately after `play`, before anything can be heard; the reason is at `:609-613`, and the steal at `:551` therefore reaches pending voices too |
| Delay = distance(camera → strike) / speed of sound | `plugins/thunderstorm/client/index.ts:173-179` (`thunderDelaySeconds`), used at `:206` |
| Speed derived from real 343 m/s and a config.ts scale constant | `index.ts:130-145`: `MAX_RELIEF_METRES / MAX_RELIEF_WORLD_UNITS` → `WORLD_UNIT_METRES` = 10, then `SPEED_OF_SOUND_METRES_PER_SECOND` (343, `:134`) / that = **34.3 world units per second** (`:144-145`) |
| Capped, with justification | `MAX_THUNDER_DELAY_SECONDS = 4` at `index.ts:163`, reasoned at `:148-162` |

**The scale constant, and why that one.** `MAX_RELIEF_WORLD_UNITS` is the only constant exported from
`client/src/config.ts` (`:110`, re-exported from `@terrace/shared` so a plugin can reach it at all) that
states a real-world dimension of this world — its own comment calls it "THE relief fact ... how
mountainous the world looks". The single judgement call is `MAX_RELIEF_METRES = 160`, and it is
**cross-checked against a drawn object rather than asserted**: flora's conifer is
`TRUNK_HEIGHT + CONIFER_CROWN_HEIGHT` = 0.45 + 1.05 = 1.5 world units
(`plugins/flora/client/models.ts:75`, `:96`), and a conifer is about 15 m — the same 10 m per world unit
from an independent direction. Third check: `DEFAULT_WORLD_SPAN` = 512 world units
(`shared/src/constants.ts:59`) is then 5.1 km, an island, which is what it is.

Verified live in the trace, with the arithmetic checkable from the line itself — camera at
`[64, 40, 94]`, strike at `{"x":33.75,"y":0.5,"z":68.5}`, so distance = √(30.25² + 39.5² + 25.5²) = 55.9
world units, and 55.9 / 34.3 = **1.63 s**, which is exactly the `delaySeconds: 1.6299338298560528` the
trace reports. Three strikes at the world centre came in at 1.63 / 1.75 / 1.53 s; walking the camera out
raised them to 2.72 / 2.73 s; moving to the far corner produced `delaySeconds: 4`, the cap, visibly
firing.

**Residuals added by these two.** (1) Past ~137 world units the delay is capped and no longer
proportional, so two very distant strikes sound equally far *in time* — they are still separated by
loudness, so the cue degrades rather than disappearing (named in place at `index.ts:158-162`). (2) The
v2 storage-key bump discards a v1-stored master volume once, by design (`audioPrefs.ts:102-110`). (3) The
metre scale is a **judgement anchored on three agreeing readings, not a declared fact** — if the owner
ever declares a real-world scale centrally, `WORLD_UNIT_METRES` should derive from that instead.

## 4. Review follow-ups

Five items came back from review. Item 1 was already shipped; 2–4 are below; 5 was a note to the
orchestrator and needed no action. Every line reference here was re-checked after the split.

| Commit | Subject |
|---|---|
| `965f813` | `feat(audio): preload on the contract so the first sound is never silent` |
| `2fa229b` | `feat(audio): build the graph eagerly so assets decode before the first click` |
| `f2a1b2a` | `feat(audio): safety limiter between the master and the destination` |
| `5c7d22b` | `fix(audio): one unlock per gesture, not one per listener` |
| `8fd8674` | `refactor(audio): split the engine along its three seams` |

### Item 1 — owner scope: already shipped

Not missed: both halves landed in `d339094` (per-bus sliders and distance-delayed thunder), `0408ab6`
and `0531959`, before the review arrived. §3 above documents them with `file:line`, and the trace in
§2 shows both working. The only deviation from the wording of the review note is that the component
is `AudioSettingsPanel.tsx` rather than `AudioSettingsRow.tsx` — it stopped being one row when it
grew four sliders, so it was renamed.

### Item 2 — the silent first strike, fixed at the contract

- `preload(url)` on `PluginAudio` — `types.ts:244`, doc at `:221-243`. Idempotent (the decode cache
  makes it so for free), never throws (`audioEngine.ts:181-190` attaches the `catch` that keeps that
  promise).
- **The graph is now built eagerly**, at engine construction: `buildAudioGraph` at
  `audioGraph.ts:164`, called unconditionally at `audioEngine.ts:74`. The reasoning is at
  `audioGraph.ts:150-163`. `unlock()` is resume-only — `audioEngine.ts:135-149`.
- The pending-request bookkeeping this replaced (`pendingMusicUrl`, `resumePendingAmbience`) is
  **deleted rather than left dead**: with a context from the start there is nothing to defer, because
  a voice started against a suspended context is already scheduled and simply becomes audible when
  the clock starts.
- `playSfx` still never waits. `buffers.peek(url)` (`audioBuffers.ts:26`, `:55`) is what lets it ask
  "is this ready?" without committing to play whatever arrives; the drop path is
  `audioEngine.ts:196-206` and is now only reachable by a plugin that skipped `preload`.
- Consumers preload in attach: `plugins/thunderstorm/client/index.ts:269`,
  `plugins/rain/client/index.ts:160`.

**Verified in the rig, and it needed a second run to be verified honestly.** The first attempt still
carried `--autoplay-policy=no-user-gesture-required`, which lets a context auto-start and therefore
*hides* the very claim being checked. `STRICT_AUTOPLAY=1` drops the flag
(`.audio-stack/capture-audio-log.mjs`), and that run reads:

```
04:37:31.665  preload {"url":".../rain-loop.wav","contextState":"suspended"}
04:37:31.667  preload {"url":".../thunder.wav","contextState":"suspended"}
--- BEFORE any gesture: {"listenerOnCamera":true,"contextState":"suspended","voiceGroupBuilt":true}
04:37:36.938  unlock  {"gain":0.8,"contextState":"running"}
--- AFTER the gesture: {"contextState":"running"}
```

So: the context and the whole graph exist before any gesture, they are **suspended**, both assets are
already decoding, and the gesture flips it to **running**. And in the full trace (§2's, re-captured)
there is now **no `playSfx (decoding, dropped)` line at all** — the defect is gone, not merely
narrowed.

### Item 2b — one unlock per gesture (`5c7d22b`)

The strict run exposed a real if cosmetic defect the eager graph made visible: a single press reaches
`unlock` twice (the host's capture-phase canvas listener and the engine's own one-shot `window`
pointerdown), and both run before the first `resume()` settles, so the `state !== 'suspended'` guard
could not catch the second — two "unlocked" lines for one click. Guarded with an in-flight flag at
`audioEngine.ts:125`, cleared on both settle paths (`:141`, `:146`). The re-run shows one line.

### Item 3 — the limiter

`DynamicsCompressorNode` between master and destination: built at `audioGraph.ts:190-196`, master
feeds it at `:200`. Constants and their justifications at `audioGraph.ts:81` (threshold −2 dBFS),
`:91` (knee 0 — hard, because a soft knee is compression and would reshape the ordinary mix), `:101`
(ratio 20, Web Audio's maximum, which is what makes it a limiter), `:112` (attack 3 ms — fast enough
for a clap's transient, deliberately no faster, since an attack under one cycle tracks the waveform
and distorts low frequency), `:122` (release 250 ms — long enough not to pump between claps).

**It sits after the master, not before**, so a player pulling the master down can still bring the
signal under the ceiling; a limiter ahead of the master could not be turned off that way.

Observable in the trace: `limiterReductionDb` is on every log line (`audioDebug.ts:80`). It reads
`-0.00012` — transparent — through the whole ordinary run, and `-9.2 dB` on the one line captured at
`resume()`, when everything scheduled during suspension lands at once. That is the node doing exactly
its job at the only moment there was a stack. **Unverified on hardware** — WSL has no audio device, so
this is the meter's reading and not a listening test.

### Item 4 — the split (`8fd8674`), done last

| File | Total lines | Code lines (excl. comments) | Holds |
|---|---|---|---|
| `client/src/audio/audioGraph.ts` | 314 | **99** | context, listener, buses, master, limiter, the prefs effects, `rampGain` / `routeToBus` / `clampGain` |
| `client/src/audio/audioBuffers.ts` | 73 | **36** | the URL-keyed decode cache and `reportAssetFailure` |
| `client/src/audio/audioVoices.ts` | 424 | **207** | the three voice kinds and every constant that distinguishes them |
| `client/src/audio/audioDebug.ts` | 95 | **35** | the two dev switches and the log decorator |
| `client/src/audio/audioEngine.ts` | 394 | **238** | policy only: per-plugin handles, the music claim, unlock, teardown |

Every file is under the ~300 code-line bar. `createAudioEngine` remains the only export anything
outside this directory imports (`plugins/host.ts:14`), so the split is invisible to the rest of the
client.

Two structural consequences worth flagging, neither of which changes observable behaviour:

1. **`createSilentAudioEngine`** (`audioEngine.ts:348`). With the graph built eagerly, "no Web Audio
   at all" is knowable at construction, so the whole engine degrades to a silent one rather than
   threading a null check through every voice and every handle. It **still arbitrates the music
   claim** — otherwise the single-claimant rule would depend on whether the machine has an audio
   stack, and a plugin refused the bus on one browser would be granted it on another.
2. **`const active = graph`** (`audioEngine.ts:84`). This compiler does not carry a `const`'s
   narrowing into the closures below, and an aliased non-null binding is clearer than a `!` at thirty
   call sites.

`AudioVoices`' ambience functions are plain hoisted functions referenced by the returned object, not
methods — nothing in this directory depends on `this`, so a destructured reference behaves identically.

### Verification after every item

```
pnpm typecheck            exit 0 — every package Done
client                    Test Files  35 passed (35)   Tests  556 passed (556)
plugins/thunderstorm      Test Files   1 passed (1)    Tests   17 passed (17)
plugins/rain              Test Files   2 passed (2)    Tests   31 passed (31)
```

**The split was verified behaviourally, not just by the type checker**: the `?audioDebug=1` trace was
captured before and after and compared line for line — preload at attach, no dropped strike, ambience
fading in 0.051 → 0.102 → 0.163 → 0.254 → 0.305 and out to 0, positional coordinates, delays of
2.12 / 1.73 / 2.20 s with the 4 s cap firing at the far corner, `busGain` 1 → 0.3 on sfx while
ambience stays 1, `master` 0.8 → 0.42 from the real slider. Same behaviour on both sides.

## 5. Typecheck and tests (verbatim)

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

## 6. Deviations from the plan and the brief

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

## 7. Merge note for the orchestrator

`main` has moved to `5f42021` since this branch's base `7a6eced`, and it now contains
`plugins/wildlife/client/glb-url.d.ts` — a THIRD copy of the `*.glb?url` declaration, added after my
base, which is exactly the duplication `types/glb-url.d.ts`'s own header argues against. My deviation 1
renames `types/glb-url.d.ts` → `types/asset-url.d.ts` and updates `tsconfig.base.json`'s single `files`
entry, so the merge needs:

- the rename applied (git should follow it), and `tsconfig.base.json` reading `types/asset-url.d.ts`
  afterwards; and
- a decision about `plugins/wildlife/client/glb-url.d.ts` — it is redundant with the shared file either
  way and it is not mine to delete. Flagging it, not touching it.

## 8. Residuals

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
  simultaneous one-shots at bus unity would still clip — and now that the player can push a bus to 1.0
  themselves, they can reach that state deliberately. A `DynamicsCompressorNode` between master and
  destination is a two-line change and a real sound-design decision; not taken unilaterally.
- **`?audioDebug=1` logs the URL of every call**, which for a Vite dev server is a long `/@fs/` path. It is
  a dev switch and the URL is the identifying field, so this is left as is.
- **`audioEngine.ts` is ~990 lines** — heavily commented (the ratio the rest of this codebase keeps), but
  long. It has three obvious seams (the graph and prefs; the three voice kinds; the per-plugin handles)
  and phase 2 should split it along them. Not split now: it would be a structural change with no
  behavioural content, on top of a diff the owner still has to read once.
- **No music consumer exists.** The bus, `setMusic` and the single-claimant arbitration are built and
  exercised only by `?audioMusic=<url>` (plan §2.4; owner picks the source in §7).

## 9. Open question for the owner: comment style

Mid-task (after commit `0408ab6`) the global `code_style.md` changed from "use verbose commenting for all
critical code" to **"Prefer no comments. Add one only when necessary. Extremely terse; hard cap 30 words
per comment."** Every file in this branch is written the other way, because that is what the brief asked
for ("match its comment style — every member says WHY it exists and what it must not do") and what
`plugins/types.ts`, `plugins/host.ts` and `config.ts` all do.

**I did not rewrite anything.** Bringing this branch under a 30-word cap would mean deleting most of the
reasoning the brief and this codebase's own convention asked for, and would leave these files reading
unlike every file next to them. That is a repo-wide style decision for the owner, not one to take inside
one arc and only for the files it happens to touch. Flagging it rather than acting on it; if the owner
wants the new cap applied, it should be applied to the codebase as a whole and this branch will come
along with it.

## 10. Not done

Nothing in the brief was left undone. The stack is torn down; `.audio-stack/` (launch/stop scripts, the
CDP capture driver and the captured trace) is left in the worktree, untracked, for the orchestrator's
review — it is a rig, not a deliverable, and is not committed.

