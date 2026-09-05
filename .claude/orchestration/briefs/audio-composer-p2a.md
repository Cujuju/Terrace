# Phase 2a brief — procedural music composer (`plugins/music/client/composer/`), GH #325

You are a fresh implementation agent, running IN PARALLEL with the phase-1 audio-host agent.
Work ONLY in the worktree `/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-composer`
(branch `audio-composer`, == main 7a6eced). First action:
`EnterWorktree({ path: "/mnt/e/Development/Projects/Terrace/.claude/worktrees/audio-composer" })`.
Run `pnpm install --offline --frozen-lockfile` there once. Paths below are relative to the
worktree root. Commit as you go (conventional commits, first line < 72 chars, NO attribution
footers, stage exact paths only). Do NOT merge to main. Do NOT push.

Read first (binding): `.claude/plans/audio-host.md` §2 and §3 "Phase 2" (owner 2026-09-04:
procedural music now, authored tracks are a later drop-in); root `CLAUDE.md`, `docs/DESIGN.md`
rules; `client/src/plugins/kit/reducedMotion.ts` (kit style); one existing preview page pair
(`client/preview-fire.html` + `client/src/previewFire.ts` or similar) for the standalone-page
convention; `plugins/daynight/protocol.ts` (phase in [0,1)) and `plugins/rain/protocol.ts`
(the mood inputs the later wiring will feed you — you do NOT subscribe to them here).

## What you build

A self-contained, host-independent generative music module. It takes an `AudioContext` and
a destination `AudioNode` and produces continuous ambient music. It knows NOTHING about
plugins, ctx, the host, Three.js, or the HUD — phase 2b wires it in once the audio host
merges. Because the host is not merged yet, everything here must compile and run against
plain Web Audio only.

```ts
// plugins/music/client/composer/composer.ts
export interface ComposerMood {
  /** 0..1, 0 = midnight, 0.5 = noon (same convention as daynight's phase). */
  readonly dayPhase: number;
  /** 0..1 how much weather is over the listener (rain/storm weight). */
  readonly weather: number;
  /** 0..1 danger (monsters near, volcano erupting); phase 2b decides the source. */
  readonly tension: number;
}
export interface Composer {
  /** Begin scheduling from the context's current time. Idempotent. */
  start(): void;
  /** Ramp everything to silence over `fadeSeconds` then release all nodes. Idempotent. */
  stop(fadeSeconds: number): void;
  /** Retarget the mood; parameters glide, never step (no clicks, no key jumps mid-bar). */
  setMood(mood: ComposerMood): void;
}
export function createComposer(context: AudioContext, destination: AudioNode, seed: number): Composer;
```

Musical design (keep it boring and pleasant; this is a terraforming god-game, not a shooter):
- Slow pad: 3–4 detuned oscillator voices per chord tone through a low-pass filter, chords
  from a small progression in a pentatonic/modal scale; chord changes every N seconds on
  the bar grid. Sparse melody: single plucked/sine notes from the scale, probability-gated
  per beat, quantised to the grid, octave and density driven by mood (`dayPhase` near noon
  = brighter, higher, denser; night = lower, sparser, more filter closed; `weather` adds a
  minor-mode lean and closes the filter; `tension` raises density and adds a low drone).
- All timing on the AUDIO clock with the standard lookahead scheduler: a `setTimeout` (or
  `setInterval`) tick every `SCHEDULER_TICK_MS` that schedules every event falling within
  `SCHEDULE_AHEAD_SECONDS`. No requestAnimationFrame, no per-frame work at all.
- Deterministic given `seed` (own small PRNG; do not use Math.random) so a mood sequence
  replays identically — this is how the orchestrator will verify it.
- Every constant named with a justification (tempo, scale, progression, detune cents,
  filter Hz ranges, envelope times, densities, glide times). No magic numbers.
- Node hygiene: every oscillator is `stop()`ped and disconnected after its envelope ends;
  live node count must stay bounded (report the steady-state count).
- CPU: target ≤ 0.5 ms of JS per scheduler tick on this box; measure with `performance.now()`
  around one tick in the preview and report the number.

Preview page: `client/preview-music.html` + `client/src/previewMusic.ts` in the existing
preview-page convention. Sliders for the three mood values, a seed field, start/stop, a
readout of live node count and last tick cost. Include a `?render=<seconds>` mode that uses an
`OfflineAudioContext` to render N seconds deterministically and prints a hash of the resulting
PCM to the page and console — this is the verification artefact, since WSL has no audio
output. Keep preview code out of the plugin folder.

## Hard constraints
- No tests (owner rule; none granted). No new dependencies. Web Audio only.
- Don't touch `client/src/plugins/**`, `client/src/audio/**`, `client/src/ui/**`,
  `client/src/state/**`, any other plugin, `shared/`, `server/`, `docs/`, `.claude/**`
  (except your report). `plugins/music/` gets ONLY `client/composer/**` — no `server/`, no
  `protocol.ts`, no `client/index.ts` (phase 2b adds those; a `plugins/music` with a
  `server/index.ts` would be auto-loaded by the host, which must not happen yet).
- `pnpm typecheck` clean at the worktree root; `vitest run` only in `client` with `timeout 120`.
- You MAY run your own Vite from the worktree on a free port to load the preview page in
  headless Chromium (`--autoplay-policy=no-user-gesture-required`); kill by pid file, never
  inline `pkill -f`. Tear down when done.
- Report `.claude/orchestration/briefs/audio-composer-p2a-report.md`: API as shipped with
  `file:line`; the constants table; the PCM hash for `seed=1, 20 s, mood (0.5,0,0)` and for
  `(0.0,1,0)`; steady-state node count; tick cost; residuals.
