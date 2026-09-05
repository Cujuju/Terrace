#!/usr/bin/env python3
"""Generate Terrace's PLACEHOLDER audio assets (audio-host plan §2.5).

Not sound design: they exist so the asset PATH is real end to end before an
authored asset is dropped in. Reproducible from this file alone — fixed seed,
no external tool. WAV because this box has no ffmpeg or sox.

Run from the repo root:  python3 scripts/audio-placeholders.py
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np

# --- Format ------------------------------------------------------------------

# Half CD rate: uncompressed, committed, and nothing here goes above ~10 kHz.
# Mono because the graph positions these, never the file.
SAMPLE_RATE_HZ = 22050
SAMPLE_WIDTH_BYTES = 2
CHANNELS = 1

INT16_PEAK = 32767
# -3 dBFS: the host's gains multiply on top, so full scale would clip on layering.
PEAK_HEADROOM = 0.7

# One seeded generator, so a regenerated placeholder is not a spurious diff.
RANDOM_SEED = 20260904
rng = np.random.default_rng(RANDOM_SEED)

# --- Thunder -----------------------------------------------------------------

# Under the plan's 3 s cap; long enough to read as a clap, not a click.
THUNDER_SECONDS = 2.4
# Tail is ~1% of peak by 2.4 s, so the file ends silent and the voice cannot click.
THUNDER_DECAY_TAU_SECONDS = 0.55
# One-pole, applied twice (12 dB/oct); corner near 220 Hz — a distant clap's band.
THUNDER_LOWPASS_ALPHA = 0.06
THUNDER_LOWPASS_PASSES = 2
# Unfiltered noise over the rumble, so it starts with an edge instead of swelling.
THUNDER_CRACK_SECONDS = 0.05
THUNDER_CRACK_LEVEL = 0.35

# --- Rain loop ---------------------------------------------------------------

# Under the 8 s cap; long enough that the loop point is not heard coming round.
RAIN_SECONDS = 6.0
# Corner near 1.6 kHz, where the hiss of rain lives.
RAIN_HIGHPASS_ALPHA = 0.6
# Long enough to hide the splice in broadband noise, short enough not to eat the loop.
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
    # Extra material folded back over the head, so head and tail come from one
    # continuous stretch of noise and the splice is inaudible, not merely quiet.
    raw = rng.uniform(-1.0, 1.0, body_count + fade_count)
    hiss = one_pole_highpass(raw, RAIN_HIGHPASS_ALPHA)

    body = hiss[:body_count].copy()
    tail = hiss[body_count:]
    # EQUAL POWER: linear gains dip 3 dB mid-fade — a hole once per loop.
    angle = np.linspace(0.0, np.pi / 2, fade_count)
    body[:fade_count] = body[:fade_count] * np.sin(angle) + tail * np.cos(angle)
    return normalize(body)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    write_wav(root / "plugins/thunderstorm/client/assets/thunder.wav", make_thunder())
    write_wav(root / "plugins/rain/client/assets/rain-loop.wav", make_rain_loop())


if __name__ == "__main__":
    main()
