# Phase 2b report — the `music` plugin, GH #325

Branch `audio-music`, cut from main 8798463. Every line:number below is in this
worktree at the branch tip and was read from source, not from a comment.

## Shipped API

### Generator lane (plan §8.2a)

| Symbol | Where |
|---|---|
| `MusicOutlet` | `client/src/plugins/types.ts:176` |
| `MusicGenerator` | `client/src/plugins/types.ts:182` |
| `PluginAudio.setMusicGenerator` | `client/src/plugins/types.ts:256` |
| `AudioVoices.setMusicGenerator` | `client/src/audio/audioVoices.ts:111`, impl `:354` |
| `AudioVoices.releaseMusic` | `client/src/audio/audioVoices.ts:113`, impl `:217` |
| `MusicSource` union | `client/src/audio/audioVoices.ts:78` |
| `claimMusic` (one claim, both setters) | `client/src/audio/audioEngine.ts:133` |
| `buildHandle.setMusicGenerator` | `client/src/audio/audioEngine.ts:225` |
| `releasePlugin` → `releaseMusic()` | `client/src/audio/audioEngine.ts:243` |
| silent engine `setMusicGenerator` | `client/src/audio/audioEngine.ts:321` (arbitrates, never calls `start`) |

Lane behaviour, as §8.2a specifies: on start a `GainNode` is created at
`SILENT_GAIN`, connected to `buses.music`, handed to `start` as `destination`,
then ramped to `MUSIC_TRACK_GAIN` over `MUSIC_CROSSFADE_SECONDS`
(`audioVoices.ts:365-376`). On release the lane ramps to silent, `stop(fade)` is
called, and the lane is disconnected after
`MUSIC_CROSSFADE_SECONDS + FADE_STOP_SLACK_SECONDS` (`:236-248`) — the ramp
silences a generator that ignores `stop`.

`musicUrl()` keeps its name and returns null while a generator plays
(`audioVoices.ts:314`). Debug line `setMusicGenerator` with `bus:'music'`
(`:358`, `:377`).

### Gauges (plan §8.2b)

| Symbol | Where |
|---|---|
| `ClientPluginCtx.publishGauge` | `client/src/plugins/types.ts:664` |
| `ClientPluginCtx.gauge` | `client/src/plugins/types.ts:673` |
| `gaugeLookups` (`"<plugin>:<key>"`) | `client/src/plugins/host.ts:506` |
| `gauge` reader (throw → null) | `client/src/plugins/host.ts:598` |
| `publishGauge` wiring, `track()` teardown, "same lookup" guard | `client/src/plugins/host.ts:753-761` |

No frame-phase consequence: `gaugeLookups` is deliberately absent from the
phase decision at `host.ts:857`, which still keys only on movers and shade.

### Publishers (plan §8.2b)

- daynight `phase` — `plugins/daynight/client/index.ts:83`, key const `:60`,
  unpublished in the existing dispose at `:143`.
- rain `weightUnderCamera` — `plugins/rain/client/index.ts:147`, calling the
  existing `rainWeightUnderCamera` (`:102`) unmoved; dispose `:158`.
- thunderstorm `weightUnderCamera` — `plugins/thunderstorm/client/index.ts:244`,
  fed by a thunderstorm-local `stormWeightUnderCamera` (`:195`) whose header
  says it is a documented copy of rain's disc loop; dispose `:266`.

### The plugin (plan §8.2c)

`plugins/music/{package.json,tsconfig.json,client/index.ts,client/env.d.ts}`,
registered LAST in `client/src/plugins/registry.ts:66` with a one-line comment.
`MUSIC_PLUGIN_NAME` `index.ts:17`, attach `:119`, dispose `:143`.

## Constants and why they hold those values

| Constant | Value | Justification |
|---|---|---|
| `MUSIC_DRAW_OBJECTS` (`music/client/index.ts:23`) | 0 | The plugin draws nothing; the budget is an expression of its own cap, like every sibling's. |
| `MUSIC_SEED` (`:30`) | 1 | `ClientPluginCtx` exposes no world identity and the score is not meant to be recognisable per world; named so a per-world seed is one edit (§8.2c). |
| `MOOD_SAMPLE_MS` (`:37`) | 1000 | `MOOD_GLIDE_TIME_CONSTANT_SECONDS` = 1.5 (`composer/composer.ts:86`), and `setTargetAtTime` needs ~3 time constants (~4.5 s) to settle, so a faster resample is inaudible. Wall-clock timer, never `onFrame`. |
| `FALLBACK_DAY_PHASE / _WEATHER / _TENSION` (`:61-63`) | 0.5 / 0 / 0 | A documented copy of the composer's own `DEFAULT_MOOD` (`composer/composer.ts:127`), which is **not exported** — midday, clear, calm. |
| `MOOD_LOG_STEP` (`:66`) | 0.05 | Same step `AUDIO_DEBUG_WEIGHT_STEP` (`audioDebug.ts:27`) uses to thin a per-call debug trace, applied to the mood's components. |
| `MILLISECONDS_PER_SECOND` (`audioVoices.ts:72`) | 1000 | Names the `* 1000` that was already inline twice in that file; every fade there is stated in seconds and `setTimeout` takes ms. |
| `NO_FADE_SECONDS` (`audioVoices.ts:75`) | 0 | `stopAll` is engine teardown: there is no graph left to fade into. |
| Reused unchanged | — | `MUSIC_CROSSFADE_SECONDS`, `MUSIC_TRACK_GAIN`, `FADE_STOP_SLACK_SECONDS`, `SILENT_GAIN`. |

## Verification

`pnpm typecheck` (workspace root) — every package `Done`, zero `error`/`failed`
lines (grepped).

```
client       Test Files  38 passed (38)   Tests  580 passed (580)   80.02s
rain         Test Files   2 passed (2)    Tests   31 passed (31)    10.03s
thunderstorm Test Files   1 passed (1)    Tests   17 passed (17)    13.50s
daynight     Test Files   3 passed (3)    Tests   29 passed (29)     9.63s
music        No test files found, exiting with code 0
```

No tests were written (owner rule). `music`'s `test` script is
`vitest run --passWithNoTests`, copying `plugins/fire/package.json:8`, the
existing precedent for a package with no test directory.

### Traces

Own stack, both torn down by pid: Vite on 5199 (`--strictPort`), server on
PORT=2591, headless Chrome on 9333 with
`--autoplay-policy=no-user-gesture-required --use-angle=swiftshader
--enable-unsafe-swiftshader` (plain swiftshader gives no WebGL context and the
client throws in `createViewport`). Console captured over CDP with Node 24's
global `WebSocket` (`.audio-verify/trace.mjs`, uncommitted).

**Claim → lane ramp → mood, `?audioDebug=1`, 120 s.** Abbreviated:

```
[terrace audio] music mood {dayPhase:0 weather:0 tension:0 liveNodeCount:17 lastTickMilliseconds:3.7}
[terrace audio] setMusicGenerator {url:null bus:music gain:1 busGain:1 ...}
[terrace audio] music mood {dayPhase:0 weather:0.579 tension:0 liveNodeCount:15 ...}
[terrace audio] music mood {dayPhase:0.6654 weather:0.579 tension:0 liveNodeCount:15 ...}
[terrace audio] music mood {dayPhase:0.66715 weather:0.5035 tension:0 liveNodeCount:31 ...}
[terrace audio] music mood {dayPhase:0.6714 weather:0.4247 tension:0 liveNodeCount:31 ...}
[terrace audio] music mood {dayPhase:0.6770 weather:0.3542 tension:0 liveNodeCount:15 ...}
[terrace audio] music mood {dayPhase:0.6803 weather:0.2903 tension:0 liveNodeCount:15 ...}
```

`weather` tracks rain's `ambience` gain line for line as the front drifts off
the camera — the whole chain (rain publisher → `gaugeLookups` → music) end to
end. `dayPhase` comes from daynight's interpolated phase. `liveNodeCount` stays
in 15–31 over the run: bounded, no growth. `lastTickMilliseconds` peaks at
3.7 ms on the first tick and is ≤ 1.1 ms after.

**Refused claim, `?audioDebug=1&audioMusic=<rain-loop.wav>`:**

```
music bus already claimed by "(dev:audioMusic)"; ignoring updates from "music"
[terrace audio] setMusic {url:…/rain-loop.wav bus:music gain:1 ...}
```

Refused exactly once, the file plays, and no `music mood` line ever appears —
`start` was never called, so no composer exists.

**Detach.** `clientPlugin.dispose()` invoked in-page through the dev module
graph (the host exposes no plugin-disable handle — see deviations):

```
[terrace audio] setMusicGenerator {url:null bus:music gain:0 ...}
DISPOSE CALLED
[terrace audio] ambience {…gain:0.1506…}   ← rain unaffected, still fading
```

Mood lines stop at that instant and never resume: the interval was cleared.
No exception, and the other plugins' voices carry on.

## Deviations from §8, with reasons

1. **A `clientOnly` flag on `TerraceClientPlugin`** (`types.ts:839`,
   `host.ts:1092` and `:1102`), set by music (`music/client/index.ts:120`).
   §8.1 read `server/src/plugins/discovery.ts:167-170` correctly — the server
   skips a plugin with no server half — but the CLIENT half of that contract
   disagrees: `syncLivePlugins` unmounts every mounted plugin the server's live
   set does not name (`host.ts:1089`). The first trace caught it: music claimed
   the bus, then was disposed one second later when the first set arrived
   (`setMusicGenerator gain:1` immediately followed by `gain:0`). Root cause in
   one sentence: the server permits a client-only plugin but the client host has
   no way to tell "absent because client-only" from "absent because disabled",
   so the plugin declares it. Rejected: giving music a stub server half — it
   would put a plugin on the wire purely to appear in a list, and §8.2c says no
   server half; and leaving it, which would mean the plugin never survives the
   join snapshot. This bug pre-dates the arc and would kill any client-only
   plugin.
2. **`FALLBACK_*` constants instead of importing the composer's `DEFAULT_MOOD`.**
   §8.2c's sketch reads `DEFAULT_MOOD.dayPhase`; `composer.ts:127` declares it
   `const`, not `export const`, and `plugins/music/client/composer/**` is
   off-limits. Documented copies, named, cited back to that line.
3. **`plugins/music/client/env.d.ts`.** Importing `AUDIO_DEBUG` from
   `client/src/audio/audioDebug.ts` (as the brief directs) pulls
   `client/src/config.ts` and `client/src/render/scene.ts` into music's tsc
   program, both of which read `import.meta.env` — 4 errors without a shim.
   Copied `plugins/mana/client/env.d.ts` verbatim in shape and reason.
4. **The "already playing" short-circuit moved from `audioEngine` into
   `audioVoices.setMusic`** (`audioVoices.ts:324-326`). The old test was
   `activeVoices.musicUrl() === url` in the engine (`audioEngine.ts`, phase-2a);
   with a generator on the bus `musicUrl()` is null, so `setMusic(null)` would
   have short-circuited and left the generator playing. Only `audioVoices` knows
   the whole source state, so the decision belongs there.
5. **`music`'s `test` script is `--passWithNoTests`** (see above).
6. **`releaseMusic` added to `AudioVoices`.** §8.2a describes the release
   behaviour but not its shape; one function is what makes `setMusic(null)`,
   `setMusicGenerator(null)` and `releasePlugin` provably agree.
7. **`start` is wrapped in try/catch** (`audioVoices.ts:365-374`): a generator
   that throws leaves the bus empty and logs, rather than holding a silent lane
   for the session. The host's stance on plugin faults, applied here.

## Residuals

- §8.4's background-tab throttling residual stands unchanged: `MOOD_SAMPLE_MS`
  is a `setInterval`, so a hidden tab resamples the mood at 1 Hz and, under
  Chrome's intensive throttling, once a minute. The composer's own
  `SCHEDULE_AHEAD_SECONDS` = 1.5 (`composer.ts:64`) covers the 1 Hz case only.
- Tension has no publisher: `TENSION_GAUGE` names `monsters:tension`
  (`music/client/index.ts:55`) and reads null, so tension is 0. Owner decision
  (§8.6).
- **Nobody has listened.** Everything above is a trace, not an ear.
- The suspended-context path was NOT exercised: the headless run used
  `--autoplay-policy=no-user-gesture-required`, so the context was running
  before `start`. What is verified is that `start` runs with no gesture at all
  and the composer schedules from `context.currentTime`; the "produces nothing
  until resume" behaviour is still only `composer.ts:270-275`'s documented
  claim.
- `music` declares `@terrace/shared` and `three` as dependencies though its own
  file imports neither: both arrive through the client contract it type-only
  imports. Kept per the brief and to match every sibling package.
