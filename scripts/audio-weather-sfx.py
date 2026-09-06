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

# Crack: a cluster of clicks, each a millisecond-scale burst of bright noise.
CRACK_CLICKS = 14
CRACK_SPREAD_SECONDS = 0.12
CRACK_CLICK_TAU_SECONDS = 0.004
CRACK_BAND_HZ = (900.0, 7000.0)
CRACK_LEVEL = 0.8
# The shockwave landing under the crack: one low thump.
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

# Soft clip: rounds the thump and glues the layers; the drive picks how much.
THUNDER_DRIVE = 1.8

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

    click_times = np.sort(rng.uniform(0.0, CRACK_SPREAD_SECONDS, CRACK_CLICKS))
    click_times[0] = 0.0
    click_levels = rng.uniform(0.4, 1.0, CRACK_CLICKS)
    crack = bandpass(noise, *CRACK_BAND_HZ) * decaying_bursts(
        count, click_times, CRACK_CLICK_TAU_SECONDS, click_levels
    )

    thump = bandpass(noise, *THUMP_BAND_HZ) * np.exp(-seconds / THUMP_TAU_SECONDS)

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

    mix = (
        CRACK_LEVEL * crack / np.max(np.abs(crack))
        + THUMP_LEVEL * thump / np.max(np.abs(thump))
        + ROLL_LEVEL * roll / np.max(np.abs(roll))
        + SUB_LEVEL * sub / np.max(np.abs(sub))
        + echoes / np.max(np.abs(roll))
    )
    shaped = np.tanh(THUNDER_DRIVE * mix / np.max(np.abs(mix)))
    # Guarantee a silent end regardless of the echo tails.
    fade_count = int(0.5 * SAMPLE_RATE_HZ)
    shaped[-fade_count:] *= np.linspace(1.0, 0.0, fade_count)
    return normalize(shaped)


# --- Rain loop ---------------------------------------------------------------
#
# Two layers: the WASH — the steady hiss of countless drops, tilted down at the
# top so it is not white noise — and the DROPS — individual splats close by,
# each a short bright tick, so the ear hears rain and not a broken speaker.
# A slow gust modulation keeps a long listen from going static.

# Under the 8 s cap; long enough that the loop point is not heard coming round.
RAIN_SECONDS = 8.0
# Long enough to hide the splice in broadband noise, short enough not to eat the loop.
RAIN_CROSSFADE_SECONDS = 1.0

# Wash: band of the hiss, and the one-pole tilt that pulls the top down.
WASH_BAND_HZ = (500.0, 9000.0)
WASH_TILT_HZ = 3000.0
WASH_LEVEL = 1.0
# Gusting: sub-audio movement of the wash level.
GUST_HZ = 0.35
GUST_DEPTH = 0.3

# Drops: how many per second, how long each rings, its band, and how loud.
DROPS_PER_SECOND = 90
DROP_TAU_SECONDS = 0.003
DROP_BAND_HZ = (1500.0, 6500.0)
DROP_LEVEL = 0.8
# A few heavier drops on a surface nearby, lower and longer.
PLOPS_PER_SECOND = 6
PLOP_TAU_SECONDS = 0.012
PLOP_BAND_HZ = (300.0, 1200.0)
PLOP_LEVEL = 0.5


def drop_layer(count: int, per_second: float, tau: float, band: tuple[float, float]) -> np.ndarray:
    total = int(per_second * count / SAMPLE_RATE_HZ)
    starts = np.sort(rng.integers(0, count, total))
    kernel_count = int(tau * 8 * SAMPLE_RATE_HZ)
    kernel = np.exp(-seconds_axis(kernel_count) / tau)
    impulses = np.zeros(count + kernel_count)
    for start in starts:
        impulses[start] += rng.uniform(0.3, 1.0)
    envelope = np.convolve(impulses, kernel)[:count]
    return bandpass(rng.standard_normal(count), *band) * envelope


def make_rain_loop() -> np.ndarray:
    fade_count = int(RAIN_CROSSFADE_SECONDS * SAMPLE_RATE_HZ)
    body_count = int(RAIN_SECONDS * SAMPLE_RATE_HZ)
    # Extra material folded back over the head, so head and tail come from one
    # continuous stretch and the splice is inaudible, not merely quiet.
    count = body_count + fade_count

    wash = lowpass(bandpass(rng.standard_normal(count), *WASH_BAND_HZ), WASH_TILT_HZ)
    wash *= 1.0 - GUST_DEPTH * (0.5 + 0.5 * slow_noise(count, GUST_HZ))
    drops = drop_layer(count, DROPS_PER_SECOND, DROP_TAU_SECONDS, DROP_BAND_HZ)
    plops = drop_layer(count, PLOPS_PER_SECOND, PLOP_TAU_SECONDS, PLOP_BAND_HZ)

    mix = (
        WASH_LEVEL * wash / np.sqrt(np.mean(wash**2))
        + DROP_LEVEL * drops / np.sqrt(np.mean(drops**2))
        + PLOP_LEVEL * plops / np.sqrt(np.mean(plops**2))
    )

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
