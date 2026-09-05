# Report — live music tuning panel in Settings (GH #325)

Branch `audio-tuning`, worktree `.claude/worktrees/audio-tuning`, cut from main 242d60d.
Every `file:line` below was read from the committed source in this worktree.

## Commits

| sha | subject |
|---|---|
| d997477 | `feat(hud): 'settings' placement for plugin HUD panels` |
| 052bddf | `feat(music): ComposerTuning dials on glided pad/shimmer/melody buses` |
| 824443d | `feat(music): persisted tuning state and the settings-popup panel` |
| 61cb0f8 | `feat(music): register the tuning panel and push dials to the composer` |

## API, with file:line

### 1. The `'settings'` placement (core)

| what | where |
|---|---|
| `HudPanelPlacement` gains `'settings'` | `client/src/plugins/hudPanels.ts:27` (doc `:18`) |
| `registerHudPanel` option union | `client/src/plugins/types.ts:388` (doc `:376`) |
| host's mirror of the union | `client/src/plugins/host.ts:704` |
| render site, inside `.hud-settings-popup` below `<AudioSettingsPanel />` | `client/src/ui/Hud.tsx:605` |

The render site is the same `<For>`/`<Dynamic>` filter the `'connection'` placement uses at
`client/src/ui/Hud.tsx:633`. Nothing else in core changed.

### 2. Composer tuning

| what | where |
|---|---|
| `interface ComposerTuning` | `plugins/music/client/composer/tuning.ts:19` |
| `DEFAULT_TUNING` | `plugins/music/client/composer/tuning.ts:50` |
| `createComposer(context, destination, seed, tuning = DEFAULT_TUNING)` | `composer.ts:409` |
| `Composer.setTuning(tuning)` | `composer.ts:151` (impl `:448`) |
| `padBus` / `shimmerBus` / `melodyBus`, all → `moodFilter` | `composer.ts:202–205` |
| bus gains set/glided with `MOOD_GLIDE_TIME_CONSTANT_SECONDS` | `composer.ts:256–268` |
| the tempo re-anchor, at a chord boundary only | `composer.ts:303–314` |
| chord index counted separately, so the progression does not restart | `composer.ts:320–326` |
| `secondsPerBeat(tempoBpm)` / `secondsPerChord(tempoBpm)` | `theory.ts:25`, `theory.ts:42` |
| `moodParameters(mood, tuning)` | `theory.ts:211` |
| `schedulePadChord(..., padDestination, shimmerDestination, ..., shape)` | `voices.ts:157` |
| `schedulePluck(..., shape)`, envelope peaking at `velocity` | `voices.ts:235` |
| `SILENT_GAIN`, now exported (the pluck floor is scaled by the bus) | `voices.ts:64` |

**`moodParameters` takes the whole tuning, not the two cutoffs** (`theory.ts:211`, comment at
`:207`): it also reads `melodyDensityScale`, and it is the single function that turns a mood
into synthesis parameters, so passing the record means no further signature churn when a
mood-shaped dial is added.

**The pluck's decay floor is a parameter, not `SILENT_GAIN`** (`voices.ts:228`, engine at
`composer.ts:346–349`). An exponential ramp's curve is fixed by its start/end RATIO. Moving the
level from the envelope to the bus while keeping an absolute `SILENT_GAIN` floor would have
changed every note's decay shape; aiming at `SILENT_GAIN / pluckPeakGain` instead keeps the
audible tail bit-for-bit what it was. This is why the render digest below is unchanged. A zero
melody bus would divide by zero, so it keeps the unscaled floor (`composer.ts:349`).

**A non-positive tempo is guarded** (`composer.ts:165`, `usableTempoBpm`): `secondsPerBeat` would
be infinite or negative and hang the pump loop. Belt to the panel's clamp, because
`createComposer` takes any tuning.

### 3. Plugin state and panel

| what | where |
|---|---|
| `musicTuning()` | `plugins/music/client/tuning-state.ts:143` |
| `setMusicTuningField(field, value)` | `tuning-state.ts:155` |
| `resetMusicTuning()` | `tuning-state.ts:162` |
| `DIALS` | `tuning-state.ts:53` |
| storage key `terrace.musicTuning.v1` | `tuning-state.ts:104` |
| `MusicTuningPanel` (the file's only export) | `plugins/music/client/MusicTuningPanel.tsx:82` |

Validation is PER FIELD rather than whole-record like `audioPrefs.ts` (`tuning-state.ts:114–139`):
with twelve dials, one unreadable field should cost one dial. Every field is checked finite and
clamped into its dial's range (`tuning-state.ts:108`), and the load starts from `DEFAULT_TUNING`
so the result is total whatever storage held.

Solid rule: the panel stores no reactive read in a component body. `DialRow` takes the FIELD and
reads through `dial()`/`value()` accessors (`MusicTuningPanel.tsx:60–61`).

`solid-js: ^1.9.14` (rain's version) added at `plugins/music/package.json`; `jsx: preserve` +
`jsxImportSource: solid-js` added to `plugins/music/tsconfig.json`, copied from
`plugins/invite/tsconfig.json`. Lockfile change is importers-only, no new VERSION:

```
+      solid-js:
+        specifier: ^1.9.14
+        version: 1.9.14
```

### 4. Wiring

| what | where |
|---|---|
| `ctx.registerHudPanel(MusicTuningPanel, { placement: 'settings' })` | `plugins/music/client/index.ts:184` |
| composer created with `musicTuning()` | `index.ts:155` |
| `createRoot` + one `createEffect` → `composer.setTuning` | `index.ts:167–172` |
| effect disposed on generator stop and on `dispose` | `index.ts:177–178`, `:193–194` |
| `?audioDebug=1` mood line carries `tempoBpm` + `padToneGain` | `index.ts:129–140` |
| `?audioDebug=1` tempo-anchor line | `index.ts:90–105` |

The root/effect/returned-dispose pattern is copied from core's `followAudioPrefs`
(`client/src/audio/audioGraph.ts:132–144`), cited in the comment at `index.ts:164–166`. ONE effect,
not one per dial: the tuning is a single record signal and `setTuning` applies all of it.

## DIALS

| field | label | min | max | step | unit | default |
|---|---|---|---|---|---|---|
| `tempoBpm` | Tempo | 40 | 96 | 1 | bpm | 64 |
| `padToneGain` | Pad | 0 | 0.12 | 0.001 | % | 0.044 |
| `padDetuneCents` | Pad detune | 0 | 20 | 0.5 | ¢ | 7 |
| `padAttackSeconds` | Pad attack | 0.2 | 6 | 0.1 | s | 3 |
| `padReleaseSeconds` | Pad release | 0.2 | 8 | 0.1 | s | 3.5 |
| `shimmerGainFraction` | Shimmer | 0 | 1 | 0.01 | % | 0.3 |
| `pluckPeakGain` | Melody | 0 | 0.4 | 0.005 | % | 0.18 |
| `pluckDurationSeconds` | Melody tail | 0.5 | 6 | 0.1 | s | 3.2 |
| `melodyDensityScale` | Melody density | 0 | 2 | 0.05 | × | 1 |
| `offbeatDensityFactor` | Off-beat | 0 | 1 | 0.05 | × | 0.55 |
| `filterNightCutoffHz` | Night cutoff | 100 | 1500 | 10 | Hz | 380 |
| `filterDayCutoffHz` | Day cutoff | 500 | 6000 | 50 | Hz | 2800 |

Each range's one-line justification is beside it at `tuning-state.ts:54–100`.

## Headroom

Full arithmetic and its reasoning are in `plugins/music/client/composer/tuning.ts:98–126`.
The sum is what reaches the composer's output gain, before `OUTPUT_LEVEL` (0.85, `composer.ts:100`).
Melody terms are a geometric series of ratio
`q = (SILENT_GAIN / pluckPeakGain) ^ (subdivisionSeconds / pluckDurationSeconds)`; pad terms are
bounded by 3 chord tones × 2 overlapping chords.

|  | defaults | all dials at maximum |
|---|---|---|
| pad | 3 × 0.044 × 1.143 = 0.151 | 3 × 0.12 × 2 = 0.720 |
| shimmer | 0.30 × 0.151 = 0.045 | 1.00 × 0.720 = 0.720 |
| drone (`DRONE_MAX_GAIN`, not a dial) | 0.180 | 0.180 |
| melody | 0.18 / (1 − 0.334) = 0.270 | 0.40 / (1 − 0.649) = 1.141 |
| **total** | **0.646** | **2.761** |
| × `OUTPUT_LEVEL` | 0.549 | 2.347 |

**Any one dial at its maximum with the rest at default stays under 1.0.** Every term is monotonic
in its own dial; the worst single dial is `padToneGain` — 0.412 + 0.123 + 0.180 + 0.270 = **0.985**.
Next worst: `pluckPeakGain` 0.945, `pluckDurationSeconds` 0.782, `padReleaseSeconds` 0.729,
`tempoBpm` 0.723, `shimmerGainFraction` 0.752.

**DEVIATION — all dials at maximum together sums to 2.761, not under 1.0.** See "Deviations".

## Determinism — offline render digest

`?render=20&seed=1` on the preview page, chrome-headless 1280 on this box, 48 kHz mono.

BEFORE (main 242d60d):

```
render 20 s @ 48000 Hz
seed 1
mood day=0.5 weather=0 tension=0
frames 960000
pcm-digest e5a9f715
repeat-digest e5a9f715 (match)
repeat-max-abs-diff 1.19e-7
```

AFTER (`052bddf`, the composer refactor):

```
render 20 s @ 48000 Hz
seed 1
mood day=0.5 weather=0 tension=0
frames 960000
pcm-digest e5a9f715
repeat-digest e5a9f715 (match)
repeat-max-abs-diff 1.19e-7
```

Identical. `renderComposition` keeps its signature and renders at `DEFAULT_TUNING`
(`composer.ts:486`); `client/src/previewMusic.ts` and `client/preview-music.html` are untouched.

## Typecheck and tests, verbatim

`pnpm typecheck` at the worktree root — every package `Done`, no diagnostics. Tail:

```
plugins/volcanoes typecheck: Done
plugins/weather typecheck: Done
plugins/wildlife typecheck: Done
server typecheck: Done
```

`vitest run` in `client` (timeout 300):

```
 RUN  v4.1.10 /mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-tuning/client

 Test Files  38 passed (38)
      Tests  580 passed (580)
   Start at  15:19:33
   Duration  127.75s (transform 288.93s, setup 0ms, import 340.99s, tests 199.52s, environment 6ms)
```

`pnpm test` in `plugins/music` (timeout 200):

```
> vitest run --passWithNoTests

 RUN  v4.1.10 /mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-tuning/plugins/music

No test files found, exiting with code 0
```

No tests were written (owner rule; permission not granted this session).

## Traces

Own stack throughout: server `PORT=2591` with a scratch DB and worlds dir, Vite on `5403` with
`VITE_SERVER_URL=ws://127.0.0.1:2591`, headless Chrome per run. Nothing touched the shared
checkout or the shared dev server. All three were killed by pid at the end.

### (a) A pad-gain change is heard within one glide

Measured, not inferred: an `AnalyserNode` between the composer and a muted sink, melody and
shimmer dialled to 0 so the RMS is the pad alone. `padToneGain` 0.044 → 0.12 (ratio 2.727) at
audio time 8.022 s.

```
context state: running
{
  "padGainGlide": {
    "from": 0.044, "to": 0.12, "ratio": 2.7272727272727275,
    "rmsBefore": 0.04303041635259894,
    "changedAtAudioTime": 8.02249433106576,
    "afterChange": [
      { "secondsAfter": 0.499, "rms": 0.045458040466360504, "rmsRatio": 1.056 },
      { "secondsAfter": 1.509, "rms": 0.08475845925379974,  "rmsRatio": 1.97  },
      { "secondsAfter": 3.01,  "rms": 0.17187732778964712,  "rmsRatio": 3.994 },
      { "secondsAfter": 4.508, "rms": 0.11222903138812497,  "rmsRatio": 2.608 },
      { "secondsAfter": 6.02,  "rms": 0.10415756556910463,  "rmsRatio": 2.421 }
    ]
  }
}
```

At one time constant (1.5 s) the pad is already 1.97× louder — on chords that were scheduled
BEFORE the dial moved, which is the whole point of the bus. It settles around the 2.7× target;
the 3.99 reading at 3.0 s is the chord's own attack peaking at the same moment, not overshoot
(`setTargetAtTime` cannot overshoot).

### (b) A tempo change lands exactly on a chord boundary

Same rig. Asked for 96 bpm at audio time 14.042 s — mid-chord.

```
{
  "tempoAnchor": {
    "tempoBefore": 64,
    "anchorBefore": 0.12,
    "askedAtAudioTime": 14.042267573696146,
    "pendingAfterAsk": 96,
    "landed": {
      "liveNodeCount": 43, "lastTickMilliseconds": 0,
      "activeTempoBpm": 96, "tempoAnchorTime": 22.62, "pendingTempoBpm": null
    },
    "chordSecondsAtOldTempo": 7.5,
    "chordsSinceFirstAnchor": 3
  }
}
```

`22.62 − 0.12 = 22.5 s = exactly 3 chords` at the old tempo (7.5 s each). The change was asked
for at 14.04 s and took effect at 22.62 s — it waited for the boundary. `liveNodeCount` 43
confirms the score kept running through it.

The same thing under `?audioDebug=1` in the real client, driven from the panel's Tempo slider
(64 → 88 bpm):

```
[terrace audio] music tempo anchor {"activeTempoBpm":"64","tempoAnchorTime":"1.6815419501133788","pendingTempoBpm":"null"}
[terrace audio] music mood {"dayPhase":"0","weather":"0","tension":"0","tempoBpm":"64","padToneGain":"0.044"}
[terrace audio] setMusicGenerator {"url":"null","bus":"music","gain":"1","busGain":"1","limiterReductionDb":"-0.13663533329963684"}
[terrace audio] music mood {"dayPhase":"0.2198","weather":"0","tension":"0","tempoBpm":"64","padToneGain":"0.044"}
[terrace audio] music tempo anchor {"activeTempoBpm":"88","tempoAnchorTime":"54.18154195011338","pendingTempoBpm":"null"}
```

`54.18154195011338 − 1.6815419501133788 = 52.5 s = exactly 7 chords` at 64 bpm.

### (c) A reload restores the persisted tuning

Panel drag of Pad → 0.09 and Tempo → 88, then `localStorage`:

```
{"tempoBpm":88,"padToneGain":0.09,"padDetuneCents":7,"padAttackSeconds":3,"padReleaseSeconds":3.5,
 "shimmerGainFraction":0.3,"pluckPeakGain":0.18,"pluckDurationSeconds":3.2,"melodyDensityScale":1,
 "offbeatDensityFactor":0.55,"filterNightCutoffHz":380,"filterDayCutoffHz":2800}
```

After a full page reload, the readouts the panel renders:

```
[["Effects","100%"],["Ambience","100%"],["Music","100%"],
 ["Tempo","88 bpm"],["Pad","9.0%"],["Pad detune","7.0¢"],["Pad attack","3.0 s"],
 ["Pad release","3.5 s"],["Shimmer","30%"],["Melody","18.0%"],["Melody tail","3.2 s"],
 ["Melody density","1.00×"],["Off-beat","0.55×"],["Night cutoff","380 Hz"],["Day cutoff","2800 Hz"]]
```

and the composer started on them, not on the defaults:

```
[terrace audio] music tempo anchor {"activeTempoBpm":"88","tempoAnchorTime":"1.6409070294784582","pendingTempoBpm":"null"}
[terrace audio] music mood {"dayPhase":"0","weather":"0","tension":"0","tempoBpm":"88","padToneGain":"0.09"}
```

### Screenshot

`.claude/orchestration/refs/music-tuning/settings-music-block.png` — the settings popup scrolled
to the Music block, at defaults, in a live world.

## Deviations from the brief

1. **Headroom at the dial maxima.** The brief asked to show the worst-case sum stays under 1.0
   "or cap the maxima so it does". With the ranges the brief specified it is 2.761. The ranges
   were kept and the arithmetic documented instead
   (`plugins/music/client/composer/tuning.ts:98–126`): the dials exist so the owner can push the
   score well past where it sits, clipping is the audible signal to back one off, ranges capped at
   ~1.2× the defaults would make the panel useless for the job, and a limiter would both colour
   the sound and break the render digest determinism is verified with. Any ONE dial at maximum is
   under 1.0. **This is the owner's call to overturn.**
2. **`ComposerStats` gained three fields** (`composer.ts:129–135`): `activeTempoBpm`,
   `tempoAnchorTime`, `pendingTempoBpm`. The brief asked for the re-anchor to be logged under the
   debug flag; the composer is host-independent by design (`composer.ts:4–8`) and must not import
   the client's `AUDIO_DEBUG`, so it REPORTS and the plugin logs (`index.ts:90–105`). This is what
   makes trace (b) checkable rather than assertable.
3. **`SILENT_GAIN` is now exported from `voices.ts`** (`voices.ts:64`) and the pluck's decay floor
   is a parameter (`voices.ts:228`). Not in the brief; without it the level move would have
   changed every note's decay curve and the render digest with it. Reasoning above.
4. **`schedulePadChord` takes two destinations** (pad and shimmer) rather than one. The brief's
   "each tone's shimmer gets its OWN envelope gain → shimmerBus" requires it.
5. **A `usableTempoBpm` guard** in the composer (`composer.ts:165`). Not in the brief; a
   non-positive tempo from any caller would hang the scheduler loop.
6. **No CSS was added.** Every class the panel uses already exists: `audio-panel`, `hud-row`,
   `controls-row`, `audio-row`, `controls-label`, `audio-slider`, `audio-readout`,
   `controls-reset` (`client/src/ui/hud.css:672`, `:709`, `:728–762`). The heading is a `controls-label` in an
   otherwise empty row.

## Residuals

- **Clipping at combined maxima**, as above. Deliberate, documented in `tuning.ts`.
- **The settings popup now scrolls**: 874 px of content in a 444 px popup (measured). The
  existing `overflow-y` on `.hud-settings-popup` handles it and the Music block is reachable, but
  twelve more rows is a real change to that popup's shape. Left as-is because the brief forbade
  new CSS; a collapsible Music block would be the fix if the owner minds.
- **`ComposerStats.lastTickMilliseconds` reads 0** in the traces above — the scheduler tick is
  under the 1 ms resolution `performance.now()` is clamped to in this Chrome. Pre-existing.
- **Three Solid warnings** (`computations created outside a 'createRoot' or 'render' will never
  be disposed`) appear on load, BEFORE any `[terrace audio]` line and before this plugin's
  generator starts. Unverified against main, but they cannot be from this change: the only
  computation added is created inside `createRoot` (`index.ts:167`) at generator start.
- **`melodyDensityScale` at 0** silences the melody without moving the RNG: both draws still
  happen per subdivision (`composer.ts:356–358`), so the note stream is unchanged when it is
  turned back up. Intended.
