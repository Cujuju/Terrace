# Phase 2a report — procedural music composer (GH #325)

Worktree `.claude/worktrees/audio-composer`, branch `audio-composer`, on top of
`36c9e41`. Two commits, not merged, not pushed:

| commit | subject |
|---|---|
| `f942973` | feat(music): procedural composer on plain Web Audio |
| `30cd000` | feat(client): preview page for the procedural music composer |

Files added (nothing else touched — verified with `git show --stat`):

- `plugins/music/client/composer/prng.ts`
- `plugins/music/client/composer/theory.ts`
- `plugins/music/client/composer/voices.ts`
- `plugins/music/client/composer/composer.ts`
- `client/preview-music.html`
- `client/src/previewMusic.ts`

No `plugins/music/server/`, no `protocol.ts`, no `client/index.ts` — so the
server host cannot auto-load a `music` plugin yet, which was the constraint.

## API as shipped

| symbol | file:line | note |
|---|---|---|
| `ComposerMood` | `plugins/music/client/composer/theory.ts:106` | as briefed: `dayPhase`, `weather`, `tension`, each 0..1. Declared beside the code that reads it and re-exported from `composer.ts:52`, so a consumer imports one module. |
| `Composer` | `plugins/music/client/composer/composer.ts:112` | `start()` `:114`, `stop(fadeSeconds)` `:117`, `setMood(mood)` `:120` — signatures exactly as briefed. |
| `Composer.stats()` | `plugins/music/client/composer/composer.ts:123` | **ADDITIVE, not in the brief's interface.** The brief also asks the preview to display live node count and last tick cost; nothing in the briefed interface exposes either. One accessor returning `ComposerStats` (`:104`) is the smallest way to satisfy both. Phase 2b may ignore it. |
| `createComposer(context, destination, seed)` | `plugins/music/client/composer/composer.ts:276` | as briefed. Does NOT resume the context — unlocking needs a gesture and belongs to whoever owns page input. |
| `renderComposition(context, destination, seed, mood, seconds)` | `plugins/music/client/composer/composer.ts:333` | **ADDITIVE.** The offline render path the brief's `?render=` mode requires. A realtime composer's `setInterval` cannot drive an `OfflineAudioContext` (its clock does not advance until rendering starts), so the note stream lives in an internal engine (`:135`) that both modes drive — realtime by lookahead, offline by one `pumpUntil(seconds)`. Every note, envelope and gain is therefore the same code in both. |

`start()`/`stop()` are idempotent; `stop()` is terminal (a stopped composer does
not restart) and `setMood()` is safe before start and after stop.

## Musical design as built

- Pad: one triad per chord, 3 detuned sawtooth voices per chord tone, 3 s
  attack, release beginning as the next chord's attack does, so the four-chord
  loop crossfades and never re-strikes.
- Melody: single triangle plucks on an eighth grid, probability-gated per
  subdivision, pentatonic so no draw can clash with the chord under it.
- Drone: two sines (root −12 and its fifth), always running, gain glided by
  `tension` — starting/stopping a sub-bass voice is the one thing that would
  click.
- Mood: `dayPhase` → daylight via a raised cosine → filter cutoff, melody
  density and melody octave; `weather` closes the filter and, at/above the
  threshold, swaps both progression and scale to their minor forms; `tension`
  raises density and the drone.
- Continuous parameters glide with `setTargetAtTime`; mode is sampled ONLY at a
  chord boundary (`composer.ts:211`), so there is no key jump mid-bar.

## Constants

Every literal is named. Justifications are in the source at these lines.

| constant | value | file:line |
|---|---|---|
| `TEMPO_BEATS_PER_MINUTE` | 56 | theory.ts:21 |
| `BEATS_PER_BAR` / `BARS_PER_CHORD` | 4 / 2 | theory.ts:27, :34 |
| `MELODY_SUBDIVISIONS_PER_BEAT` | 2 | theory.ts:47 |
| `ROOT_MIDI_NOTE` | 45 (A2, 110 Hz) | theory.ts:65 |
| `BRIGHT_PROGRESSION` | I–vi–IV–V | theory.ts:77 |
| `OVERCAST_PROGRESSION` | i–VI–III–VII | theory.ts:89 |
| `BRIGHT_SCALE_SEMITONES` | major pentatonic | theory.ts:100 |
| `OVERCAST_SCALE_SEMITONES` | minor pentatonic | theory.ts:103 |
| `MINOR_LEAN_WEATHER_THRESHOLD` | 0.35 | theory.ts:121 |
| `FILTER_NIGHT_CUTOFF_HZ` / `FILTER_DAY_CUTOFF_HZ` | 380 / 2100 | theory.ts:124, :127 |
| `FILTER_WEATHER_CLOSE_FRACTION` | 0.45 | theory.ts:134 |
| `MELODY_NIGHT_DENSITY` / `MELODY_DAY_DENSITY` | 0.08 / 0.30 | theory.ts:137, :140 |
| `MELODY_TENSION_DENSITY` / `MELODY_MAX_DENSITY` | 0.18 / 0.50 | theory.ts:143, :150 |
| `MELODY_BASE_OFFSET_SEMITONES` | 24 | theory.ts:156 |
| `MELODY_BRIGHT_OCTAVE_THRESHOLD` | 0.6 | theory.ts:162 |
| `DRONE_MAX_GAIN` | 0.18 | theory.ts:165 |
| `PAD_VOICES_PER_TONE` / `PAD_DETUNE_CENTS` | 3 / 7 cents | voices.ts:22, :27 |
| `PAD_TONE_PEAK_GAIN` | 0.09 | voices.ts:38 |
| `PAD_ATTACK_SECONDS` / `PAD_RELEASE_SECONDS` | 3 / 3.5 | voices.ts:44, :50 |
| `PLUCK_PEAK_GAIN` / `PLUCK_ATTACK_SECONDS` / `PLUCK_DURATION_SECONDS` | 0.16 / 0.012 / 2.2 | voices.ts:59, :63, :68 |
| `SILENT_GAIN` | 1e-4 | voices.ts:73 |
| `DRONE_OCTAVE_DROP_SEMITONES` / `DRONE_FIFTH_SEMITONES` | 12 / 7 | voices.ts:81, :86 |
| `VOICE_STOP_MARGIN_SECONDS` | 0.05 | voices.ts:92 |
| `SCHEDULER_TICK_MS` / `SCHEDULE_AHEAD_SECONDS` | 250 ms / 1.5 s | composer.ts:58, :64 |
| `START_LEAD_SECONDS` / `START_FADE_SECONDS` | 0.12 / 0.4 | composer.ts:71, :76 |
| `OUTPUT_LEVEL` | 0.85 | composer.ts:80 |
| `MOOD_GLIDE_TIME_CONSTANT_SECONDS` | 1.5 | composer.ts:86 |
| `FILTER_RESONANCE_Q` | 0.7 | composer.ts:91 |
| `TEARDOWN_SLACK_SECONDS` | 0.1 | composer.ts:97 |
| PRNG mixing constants | mulberry32 as published | prng.ts:16–40 |
| `RENDER_SAMPLE_RATE_HZ` / `RENDER_CHANNELS` / `MAX_RENDER_SECONDS` | 48000 / 1 / 300 | previewMusic.ts:55, :60, :65 |
| `DIGEST_BLOCK_FRAMES` / `INT16_FULL_SCALE` | 4096 / 32767 | previewMusic.ts:79, :71 |

## The digest, and the brief's "PCM hash" — a deviation, with the measurement

**The brief asked for a hash of the rendered PCM. A per-sample hash does not
work on this machine, and I have the numbers.**

Two `OfflineAudioContext` renders of the IDENTICAL score are not bit-identical
on chrome-headless-shell 1234: they diverge from the second sample onward by up
to ~2.4e-6 in amplitude. A hash over per-sample int16 values therefore flips
whenever any one of ~10^6 samples lands on a rounding boundary, and it did —
the same 5 s of seed 1 hashed `229c9f94`, then `de7f7f83`, then `93b255b7`, then
`289fd7eb` on four consecutive runs.

Isolation, so the claim is not a guess:
- A bare oscillator (sine, sawtooth, triangle) rendered twice in one page hashed
  identically both times — so Web Audio is not randomising per render.
- Two renders of the full score were compared sample by sample: 134991 of 240000
  samples differed, first difference at sample 2, **max absolute difference
  1.94e-7** on a 5 s render and 2.41e-6 on 20 s. That is −114 dBFS at worst,
  ~54 dB below 16-bit's least significant bit — i.e. the notes are identical and
  the difference is the renderer's own float summation, not the composition.
- A first, wrong hypothesis (voices being disconnected mid-render by their
  `ended` handlers, changing summation order) was implemented, measured, and
  **reverted** when the difference persisted. Nothing of it remains in the diff.

So the shipped artefact is a **block-RMS digest** (`previewMusic.ts:124`,
4096-frame blocks, RMS quantised to the int16 grid) — the noise averages away
far below the quantisation step — plus, printed alongside it, the max sample
difference between two renders the page does itself. The page prints
`match`/`MISMATCH` between its own two digests, so a boundary flip could never
be silent.

Named residual: an RMS digest is blind to a change that moves energy inside one
85 ms block without changing its total. Nothing the composer can do produces
that (a different note is a different frequency; every envelope is longer than a
block), and the alternative is a hash that reports differences which are not
there.

### The numbers the brief asked for

Both at 20 s, 48 kHz, mono, five renders across three browser processes, all
digests stable and all self-checks `match`:

| case | `pcm-digest` | repeat max abs diff |
|---|---|---|
| `seed=1`, mood (dayPhase 0.5, weather 0, tension 0) | **`93f5dae3`** | 2.38e-7 |
| `seed=1`, mood (dayPhase 0.0, weather 1, tension 0) | **`18f8ab84`** | 2.41e-6 |
| `seed=2`, mood (0.5, 0, 0) — control | `75a2f9ba` | 2.53e-7 |

Reproduce: serve `client/` and open
`preview-music.html?render=20&seed=1&day=0.5&weather=0&tension=0`.
The control line matters: a different seed gives a different digest, so the
digest is actually a function of the composition and not a constant.

## Node count and tick cost

Measured by driving the realtime page in chrome-headless-shell for 60 s and
sampling the readout twice a second (120 samples):

| mood | live nodes min / median / max | tick ms min / median / max |
|---|---|---|
| seed 1, (0.5, 0, 0) | 15 / 27 / **35** | 0 / 0 / **0.4** |
| seed 7, (0.5, 0.6, 1.0) — densest | 15 / 29 / **41** | 0 / 0 / **0.7** |

Steady state is ~27 nodes (12 per chord × two overlapping chords, plus 3 for the
drone, plus live plucks), bounded at 41 under the densest mood. The count
oscillates with the chord crossfade and does not trend upward over the run,
which is the leak check.

Tick cost: median below the readout's resolution (0.00 ms), worst observed
**0.7 ms** on the tick that schedules a chord — 12 nodes with 4 automation
events each. That is over the brief's ≤0.5 ms target on the chord tick and far
under it on every other tick; at four ticks a second the composer's total main-
thread cost is ~0.1 % of one core. Flagged rather than optimised: splitting a
chord across ticks would buy 0.2 ms on one tick in eight and cost the
crossfade's exactness.

## Verification run

```
$ pnpm typecheck        # workspace root
… client typecheck: Done … server typecheck: Done   (every workspace package, 0 errors)

$ cd client && timeout 120 ./node_modules/.bin/vitest run
 Test Files  35 passed (35)
      Tests  556 passed (556)
   Duration  84.36s
```

No tests were written (owner rule; permission not granted this session).

## Residuals

1. **`plugins/music/` is not a workspace package**, so `pnpm typecheck` does not
   run `tsc` there directly. The composer IS typechecked — `client`'s program
   follows the import from `previewMusic.ts`, the same way the client typechecks
   every other plugin's client half — but a future `plugins/music/package.json`
   (phase 2b, when the plugin gets a server half) is what makes that
   independent. Adding one now would have meant a lockfile change, which the
   brief forbids.
2. **Chord-tick cost is 0.7 ms**, over the 0.5 ms target. See above.
3. **Mono.** No panner anywhere, so the score is centre-image. Stereo width
   would be one `StereoPannerNode` per chord tone (+3 nodes per chord) and is a
   phase-2b judgement once it is audible through the music bus.
4. **Nobody has heard it.** WSL has no audio output; every claim here is about
   the note stream and the numbers, not about whether it sounds good. The
   realtime half of the preview page exists for exactly that check on a machine
   with speakers.
5. **`?render=` uses a fixed mood** for the whole render. A mood TIMELINE (glide
   from noon to midnight and hash that) would exercise the glide path too; it is
   not built, because the brief asked for two fixed-mood digests and the glides
   are audible-path-only.
