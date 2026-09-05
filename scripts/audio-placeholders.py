#!/usr/bin/env python3
"""Generate Terrace's PLACEHOLDER audio assets (audio-host plan §2.5).

These are not sound design. They exist so the asset PATH is real — a plugin
imports a file with `?url`, Vite fingerprints and serves it, the host fetches
and decodes it, and a voice plays it — which is the part that must be right
before an authored asset can simply be dropped in its place.

WHY A SCRIPT AND NOT COMMITTED-BY-HAND BINARIES. The two WAVs below are
reproducible from this file alone: fixed seed, no randomness outside numpy's
seeded generator, and no external tool. This box has python3 + numpy and
neither ffmpeg nor sox, which is also why the format is WAV rather than the
OGG/Opus a real asset should be (plan §5, named residual).

Run from the repo root:

    python3 scripts/audio-placeholders.py
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np

# --- Format ------------------------------------------------------------------

# 22.05 kHz mono 16-bit. Half of CD rate: a WAV is uncompressed, these are
# placeholders that get committed, and nothing here has content above ~10 kHz
# worth paying double the bytes for. Mono because both sounds are positioned or
# spread by the audio graph, never by the file.
SAMPLE_RATE_HZ = 22050
SAMPLE_WIDTH_BYTES = 2
CHANNELS = 1

# Full-scale for signed 16-bit PCM, and the headroom every render is scaled to.
INT16_PEAK = 32767
# -3 dBFS of headroom: the host's own gains multiply on top of these, and a
# file that already touches full scale clips the moment anything is layered.
PEAK_HEADROOM = 0.7

# One deterministic generator for the whole script — the seed is what makes two
# runs byte-identical, so a regenerated placeholder is not a spurious diff.
RANDOM_SEED = 20260904
rng = np.random.default_rng(RANDOM_SEED)

# --- Thunder -----------------------------------------------------------------

# Under the 3 s cap the plan sets. A real thunderclap rolls for longer; this one
# only has to be long enough to read as a clap rather than a click.
THUNDER_SECONDS = 2.4
# Exponential decay time constant. At 0.55 s the tail is ~1% of the peak by
# 2.4 s, so the sound has ended before the file does and the end is silent —
# which is what stops the one-shot from clicking when its buffer runs out.
THUNDER_DECAY_TAU_SECONDS = 0.55
# A one-pole low-pass coefficient, applied twice (12 dB/octave). 0.06 puts the
# corner near 220 Hz at this sample rate, which is the band a distant clap keeps
# once the air has taken the crack off it.
THUNDER_LOWPASS_ALPHA = 0.06
THUNDER_LOWPASS_PASSES = 2
# The initial crack: a short burst of un-filtered noise mixed over the rumble,
# so the sound starts with an edge instead of swelling.
THUNDER_CRACK_SECONDS = 0.05
THUNDER_CRACK_LEVEL = 0.35

# --- Rain loop ---------------------------------------------------------------

# Under the 8 s cap. Long enough that the ear does not hear the loop point come
# round; short enough to stay a small committed file.
RAIN_SECONDS = 6.0
# Rain is high-passed noise: a one-pole high-pass with this coefficient puts the
# corner near 1.6 kHz, which is where the hiss of rain lives once the low
# rumble of everything else is out of it.
RAIN_HIGHPASS_ALPHA = 0.6
# How much of the tail is crossfaded into the head to make the loop seamless.
# 0.5 s of equal-power crossfade: long enough to hide the splice in broadband
# noise, short enough not to eat a tenth of the loop.
RAIN_CROSSFADE_SECONDS = 0.5


def one_pole_lowpass(signal: np.ndarray, alpha: float, passes: int = 1) -> np.ndarray:
    """y[n] = y[n-1] + alpha * (x[n] - y[n-1]), applied `passes` times."""
    out = signal
    for _ in range(passes):
        filtered = np.empty_like(out)
        state = 0.0
        for i, sample in enumerate(out):
            state += alpha * (sample - state)
            filtered[i] = state
        out = filtered
    return out


def one_pole_highpass(signal: np.ndarray, alpha: float) -> np.ndarray:
    """A one-pole high-pass: the signal minus its own low-passed self."""
    return signal - one_pole_lowpass(signal, alpha)


def normalize(signal: np.ndarray) -> np.ndarray:
    """Scale to PEAK_HEADROOM of full scale; silence stays silence."""
    peak = float(np.max(np.abs(signal)))
    if peak == 0.0:
        return signal
    return signal * (PEAK_HEADROOM / peak)


def write_wav(path: Path, signal: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = np.clip(np.round(signal * INT16_PEAK), -INT16_PEAK, INT16_PEAK)
    frames = struct.pack(f"<{samples.size}h", *samples.astype(np.int16))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(CHANNELS)
        handle.setsampwidth(SAMPLE_WIDTH_BYTES)
        handle.setframerate(SAMPLE_RATE_HZ)
        handle.writeframes(frames)
    print(f"wrote {path} ({path.stat().st_size} bytes)")


def make_thunder() -> np.ndarray:
    count = int(THUNDER_SECONDS * SAMPLE_RATE_HZ)
    seconds = np.arange(count) / SAMPLE_RATE_HZ
    noise = rng.uniform(-1.0, 1.0, count)

    rumble = one_pole_lowpass(noise, THUNDER_LOWPASS_ALPHA, THUNDER_LOWPASS_PASSES)
    rumble *= np.exp(-seconds / THUNDER_DECAY_TAU_SECONDS)

    crack_count = int(THUNDER_CRACK_SECONDS * SAMPLE_RATE_HZ)
    crack = np.zeros(count)
    crack_envelope = np.linspace(1.0, 0.0, crack_count)
    crack[:crack_count] = noise[:crack_count] * crack_envelope * THUNDER_CRACK_LEVEL

    return normalize(rumble + crack)


def make_rain_loop() -> np.ndarray:
    fade_count = int(RAIN_CROSSFADE_SECONDS * SAMPLE_RATE_HZ)
    body_count = int(RAIN_SECONDS * SAMPLE_RATE_HZ)
    # Render the crossfade's worth of EXTRA material, then fold it back over the
    # head: the last `fade_count` samples and the first `fade_count` samples then
    # come from one continuous stretch of noise, which is what makes the splice
    # inaudible rather than merely quiet.
    raw = rng.uniform(-1.0, 1.0, body_count + fade_count)
    hiss = one_pole_highpass(raw, RAIN_HIGHPASS_ALPHA)

    body = hiss[:body_count].copy()
    tail = hiss[body_count:]
    # EQUAL POWER (sin/cos), not linear: two uncorrelated noise signals summed
    # with linear gains dip by 3 dB in the middle of the fade, which is audible
    # as a hole once per loop.
    angle = np.linspace(0.0, np.pi / 2, fade_count)
    body[:fade_count] = body[:fade_count] * np.sin(angle) + tail * np.cos(angle)
    return normalize(body)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    write_wav(root / "plugins/thunderstorm/client/assets/thunder.wav", make_thunder())
    write_wav(root / "plugins/rain/client/assets/rain-loop.wav", make_rain_loop())


if __name__ == "__main__":
    main()
