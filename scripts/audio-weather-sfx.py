#!/usr/bin/env python3
"""Synthesise Terrace's weather sound effects: thunder one-shots and the rain loop.

Reproducible from this file alone — fixed seed, numpy + scipy, no external
tool. WAV because this box has no ffmpeg or sox.

Run from the repo root:  python3 scripts/audio-weather-sfx.py
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt, sosfiltfilt

# --- Format ------------------------------------------------------------------

# Half CD rate: Nyquist at 11 kHz, above where either of these sounds has energy.
SAMPLE_RATE_HZ = 22050
SAMPLE_WIDTH_BYTES = 2
CHANNELS = 1

INT16_PEAK = 32767
# -3 dBFS: the host's gains multiply on top, so full scale would clip on layering.
PEAK_HEADROOM = 0.7

# One seeded generator, so a regenerated asset is not a spurious diff.
RANDOM_SEED = 20260905
rng = np.random.default_rng(RANDOM_SEED)

FILTER_ORDER = 4


def bandpass(signal: np.ndarray, low_hz: float, high_hz: float) -> np.ndarray:
    sos = butter(FILTER_ORDER, [low_hz, high_hz], btype="band", fs=SAMPLE_RATE_HZ, output="sos")
    return sosfilt(sos, signal)


def lowpass(signal: np.ndarray, hz: float) -> np.ndarray:
    sos = butter(FILTER_ORDER, hz, btype="low", fs=SAMPLE_RATE_HZ, output="sos")
    return sosfilt(sos, signal)


def highpass(signal: np.ndarray, hz: float) -> np.ndarray:
    sos = butter(FILTER_ORDER, hz, btype="high", fs=SAMPLE_RATE_HZ, output="sos")
    return sosfilt(sos, signal)


def seconds_axis(count: int) -> np.ndarray:
    return np.arange(count) / SAMPLE_RATE_HZ


def slow_noise(count: int, cutoff_hz: float) -> np.ndarray:
    """Noise with only sub-audio movement, for gusts and rolling. Zero-phase, so
    its features are not delayed against the signal it modulates. Unit peak."""
    sos = butter(2, cutoff_hz, btype="low", fs=SAMPLE_RATE_HZ, output="sos")
    shaped = sosfiltfilt(sos, rng.standard_normal(count))
    return shaped / max(float(np.max(np.abs(shaped))), 1e-9)


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
    print(f"wrote {path} ({path.stat().st_size} bytes, {samples.size / SAMPLE_RATE_HZ:.1f} s)")


# --- Thunder -----------------------------------------------------------------
#
# Three things a listener hears in a nearby strike, layered:
#   1. the CRACK — a tearing burst of broadband clicks as the channel breaks
#      (tens of ms, bright), followed by one deep thump as the shockwave lands;
#   2. the ROLL — low rumble whose loudness lurches as sound from different
#      lengths of the bolt arrives, decaying over several seconds;
#   3. the ECHOES — a few softer, duller copies of the roll off terrain.

# Long enough for the roll to die away; ends silent so the voice cannot click.
THUNDER_SECONDS = 6.0

# Crack: one bright burst with a real attack (an instant edge is a click), a
# fast decay, and a tearing texture from fast amplitude modulation rather than
# from discrete clicks — clicks read as a glitch, not a bolt.
CRACK_ATTACK_SECONDS = 0.004
CRACK_TAU_SECONDS = 0.07
CRACK_BODY_TAU_SECONDS = 0.18
CRACK_BODY_LEVEL = 0.4
CRACK_TEAR_HZ = 90.0
CRACK_TEAR_DEPTH = 0.6
CRACK_BAND_HZ = (700.0, 5500.0)
CRACK_LEVEL = 0.7
# The shockwave landing under the crack: one low thump.
THUMP_ATTACK_SECONDS = 0.003
THUMP_TAU_SECONDS = 0.09
THUMP_BAND_HZ = (40.0, 160.0)
THUMP_LEVEL = 1.6

# Roll: rumble whose envelope is several lumps arriving over the first two
# seconds, then decays.
ROLL_LUMPS = 6
ROLL_LUMP_SPREAD_SECONDS = 2.2
ROLL_LUMP_TAU_SECONDS = 0.35
# A lump swells in; a step onset on filtered noise is a broadband click.
ROLL_LUMP_ATTACK_SECONDS = 0.06
ROLL_BAND_HZ = (45.0, 320.0)
ROLL_DECAY_TAU_SECONDS = 1.4
# Sub-audio wobble on the roll so it rolls instead of hissing at one level.
ROLL_WOBBLE_HZ = 3.0
ROLL_WOBBLE_DEPTH = 0.45
ROLL_LEVEL = 1.2
# The very low body under the roll; felt more than heard.
SUB_BAND_HZ = (25.0, 70.0)
SUB_LEVEL = 0.6

# Echoes: delayed, duller, quieter copies of the roll.
ECHO_DELAYS_SECONDS = (0.9, 1.7, 2.8)
ECHO_LEVELS = (0.45, 0.28, 0.16)
ECHO_LOWPASS_HZ = 180.0

# Soft clip on the LOW layers only: rounds the thump and glues the roll. The
# crack stays clean — clipping a bright transient is what distortion sounds like.
THUNDER_DRIVE = 1.4

# Different seeds give different strikes; the plugin picks one per strike.
THUNDER_VARIANTS = 3


def decaying_bursts(
    count: int, times: np.ndarray, tau: float, levels: np.ndarray, attack: float = 0.0
) -> np.ndarray:
    """Sum of exponential decays starting at `times`, scaled by `levels`,
    each rising over `attack` seconds first (zero attack is a step)."""
    seconds = seconds_axis(count)
    envelope = np.zeros(count)
    for start, level in zip(times, levels):
        active = seconds >= start
        since = seconds[active] - start
        rise = np.minimum(since / attack, 1.0) if attack > 0.0 else 1.0
        envelope[active] += level * rise * np.exp(-since / tau)
    return envelope


def make_thunder() -> np.ndarray:
    count = int(THUNDER_SECONDS * SAMPLE_RATE_HZ)
    seconds = seconds_axis(count)
    noise = rng.standard_normal(count)

    crack_envelope = np.minimum(seconds / CRACK_ATTACK_SECONDS, 1.0) * (
        np.exp(-seconds / CRACK_TAU_SECONDS)
        + CRACK_BODY_LEVEL * np.exp(-seconds / CRACK_BODY_TAU_SECONDS)
    )
    crack_envelope *= 1.0 - CRACK_TEAR_DEPTH * (0.5 + 0.5 * slow_noise(count, CRACK_TEAR_HZ))
    crack = bandpass(noise, *CRACK_BAND_HZ) * crack_envelope

    thump = bandpass(noise, *THUMP_BAND_HZ) * (
        np.minimum(seconds / THUMP_ATTACK_SECONDS, 1.0) * np.exp(-seconds / THUMP_TAU_SECONDS)
    )

    lump_times = np.sort(rng.uniform(0.0, ROLL_LUMP_SPREAD_SECONDS, ROLL_LUMPS))
    lump_times[0] = 0.0
    lump_levels = rng.uniform(0.5, 1.0, ROLL_LUMPS)
    roll_envelope = decaying_bursts(
        count, lump_times, ROLL_LUMP_TAU_SECONDS, lump_levels, ROLL_LUMP_ATTACK_SECONDS
    )
    roll_envelope *= np.exp(-seconds / ROLL_DECAY_TAU_SECONDS)
    roll_envelope *= 1.0 - ROLL_WOBBLE_DEPTH * (0.5 + 0.5 * slow_noise(count, ROLL_WOBBLE_HZ))
    roll = bandpass(noise, *ROLL_BAND_HZ) * roll_envelope
    sub = bandpass(rng.standard_normal(count), *SUB_BAND_HZ) * roll_envelope

    echoes = np.zeros(count)
    dull_roll = lowpass(roll, ECHO_LOWPASS_HZ)
    for delay, level in zip(ECHO_DELAYS_SECONDS, ECHO_LEVELS):
        offset = int(delay * SAMPLE_RATE_HZ)
        echoes[offset:] += level * dull_roll[: count - offset]

    low = (
        THUMP_LEVEL * thump / np.max(np.abs(thump))
        + ROLL_LEVEL * roll / np.max(np.abs(roll))
        + SUB_LEVEL * sub / np.max(np.abs(sub))
        + echoes / np.max(np.abs(roll))
    )
    shaped = np.tanh(THUNDER_DRIVE * low / np.max(np.abs(low)))
    shaped += CRACK_LEVEL * crack / np.max(np.abs(crack))
    # Guarantee a silent end regardless of the echo tails.
    fade_count = int(0.5 * SAMPLE_RATE_HZ)
    shaped[-fade_count:] *= np.linspace(1.0, 0.0, fade_count)
    return normalize(shaped)


# --- Rain loop ---------------------------------------------------------------
#
# Rain is drops, all the way down: there is no steady hiss under it, only a
# density of drops too high to pick apart. A stationary noise bed reads as
# white noise with rain on top, so every layer here is granular:
#   FINE   — thousands of tiny bright grains a second: the wash itself;
#   DROPS  — a few hundred ringing drops a second, each a damped sine at its
#            own pitch, so the texture sparkles instead of hissing;
#   PLOPS  — a handful of heavier, lower drops on something near.
# A slow gust rides the fine layer so a long listen never goes static.

# Under the 8 s cap; long enough that the loop point is not heard coming round.
RAIN_SECONDS = 8.0
# Long enough to hide the splice in dense grains, short enough not to eat the loop.
RAIN_CROSSFADE_SECONDS = 1.0

# Fine grains: rate × tau ≈ 3 overlapping at any instant — dense, yet churning.
FINE_PER_SECOND = 3000
FINE_TAU_SECONDS = 0.001
FINE_BAND_HZ = (1200.0, 7500.0)
FINE_LEVEL = 1.0
# Gusting: sub-audio movement of the fine layer.
GUST_HZ = 0.35
GUST_DEPTH = 0.35

# Ringing drops: a damped sine per drop, pitch drawn per drop.
DROPS_PER_SECOND = 220
DROP_TAU_SECONDS = 0.004
DROP_PITCH_HZ = (1800.0, 5200.0)
DROP_LEVEL = 0.7
# Heavier drops on a surface nearby, lower and longer.
PLOPS_PER_SECOND = 7
PLOP_TAU_SECONDS = 0.014
PLOP_PITCH_HZ = (260.0, 700.0)
PLOP_LEVEL = 0.45

# The final band: nothing below the drops, and the very top rolled off so it
# is not fizzy.
RAIN_BAND_HZ = (350.0, 8500.0)


def grain_layer(count: int, per_second: float, tau: float, band: tuple[float, float]) -> np.ndarray:
    """Noise gated by a dense train of exponential grains: the wash."""
    total = int(per_second * count / SAMPLE_RATE_HZ)
    starts = rng.integers(0, count, total)
    kernel_count = int(tau * 8 * SAMPLE_RATE_HZ)
    kernel = np.exp(-seconds_axis(kernel_count) / tau)
    impulses = np.zeros(count + kernel_count)
    np.add.at(impulses, starts, rng.uniform(0.3, 1.0, total))
    envelope = np.convolve(impulses, kernel)[:count]
    return bandpass(rng.standard_normal(count), *band) * envelope


def ringing_drops(
    count: int, per_second: float, tau: float, pitch_hz: tuple[float, float]
) -> np.ndarray:
    """One damped sine per drop at its own pitch and phase."""
    total = int(per_second * count / SAMPLE_RATE_HZ)
    ring_count = int(tau * 8 * SAMPLE_RATE_HZ)
    ring_seconds = seconds_axis(ring_count)
    decay = np.exp(-ring_seconds / tau)
    out = np.zeros(count + ring_count)
    for start in rng.integers(0, count, total):
        pitch = rng.uniform(*pitch_hz)
        phase = rng.uniform(0.0, 2 * np.pi)
        out[start : start + ring_count] += (
            rng.uniform(0.3, 1.0) * decay * np.sin(2 * np.pi * pitch * ring_seconds + phase)
        )
    return out[:count]


def make_rain_loop() -> np.ndarray:
    fade_count = int(RAIN_CROSSFADE_SECONDS * SAMPLE_RATE_HZ)
    body_count = int(RAIN_SECONDS * SAMPLE_RATE_HZ)
    # Extra material folded back over the head, so head and tail come from one
    # continuous stretch and the splice is inaudible, not merely quiet.
    count = body_count + fade_count

    fine = grain_layer(count, FINE_PER_SECOND, FINE_TAU_SECONDS, FINE_BAND_HZ)
    fine *= 1.0 - GUST_DEPTH * (0.5 + 0.5 * slow_noise(count, GUST_HZ))
    drops = ringing_drops(count, DROPS_PER_SECOND, DROP_TAU_SECONDS, DROP_PITCH_HZ)
    plops = ringing_drops(count, PLOPS_PER_SECOND, PLOP_TAU_SECONDS, PLOP_PITCH_HZ)

    mix = (
        FINE_LEVEL * fine / np.sqrt(np.mean(fine**2))
        + DROP_LEVEL * drops / np.sqrt(np.mean(drops**2))
        + PLOP_LEVEL * plops / np.sqrt(np.mean(plops**2))
    )
    mix = bandpass(mix, *RAIN_BAND_HZ)

    body = mix[:body_count].copy()
    tail = mix[body_count:]
    # EQUAL POWER: linear gains dip 3 dB mid-fade — a hole once per loop.
    angle = np.linspace(0.0, np.pi / 2, fade_count)
    body[:fade_count] = body[:fade_count] * np.sin(angle) + tail * np.cos(angle)
    return normalize(body)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    for index in range(THUNDER_VARIANTS):
        write_wav(root / f"plugins/thunderstorm/client/assets/thunder-{index}.wav", make_thunder())
    write_wav(root / "plugins/rain/client/assets/rain-loop.wav", make_rain_loop())


if __name__ == "__main__":
    main()
