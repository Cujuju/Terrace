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

# Seeded PER ASSET, so regenerating is not a spurious diff and retuning one
# asset cannot re-roll another.
RANDOM_SEED = 20260905
rng = np.random.default_rng(RANDOM_SEED)


def seed_asset(name: str, variant: int = 0) -> None:
    global rng
    rng = np.random.default_rng([RANDOM_SEED, variant, *name.encode()])

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
# A THUNDER SHEET, the foley rig: a big thin metal sheet struck once, ringing
# on. Modelled as what it physically is — a plate with hundreds of
# inharmonic modes, struck at one point:
#   * mode frequencies follow a thin plate, f ∝ (m/W)² + (n/H)², so the
#     spectrum is dense and unmusical;
#   * each mode's level is the plate's shape at the strike point;
#   * high modes die in a fraction of a second, low modes ring for seconds;
#   * the whole sheet flexes as it is shaken, bending every mode's pitch
#     together — the wobble that makes a sheet sound like thunder.
# Under it a PUNCH (a kick-style hit) and a short CRACK for the strike itself.

# Long enough for the low modes to die away; ends silent so the voice cannot click.
THUNDER_SECONDS = 6.0

# The plate: a BIG sheet, its fundamental below hearing so the low modes are
# dense — a small sheet's sparse low modes ring like a gong, not thunder.
SHEET_FUNDAMENTAL_HZ = 9.0
SHEET_ASPECT = 1.4
SHEET_MODES_PER_AXIS = 40
SHEET_BOTTOM_HZ = 30.0
SHEET_TOP_HZ = 6000.0
# Where it is struck, as a fraction of width and height, per variant.
SHEET_STRIKE_RANGE = (0.15, 0.45)
# Ring time of the fundamental, and how much faster higher modes die:
# tau ∝ f ** -SHEET_DAMPING_SLOPE.
SHEET_FUNDAMENTAL_TAU_SECONDS = 10.0
SHEET_DAMPING_SLOPE = 0.7
# Flex: the sheet is shaken after the hit, bending every pitch together. A
# few percent, at a rate that itself dies down as the shaking settles.
SHEET_FLEX_DEPTH = 0.06
SHEET_FLEX_HZ = 2.2
SHEET_FLEX_TAU_SECONDS = 1.8
# The sheet's own swell: a sheet rolls up over tens of ms, not instantly.
SHEET_ATTACK_SECONDS = 0.02
# Pulled toward the low end, as a sheet heard from the back of a hall is.
SHEET_TILT_HZ = 900.0
SHEET_LEVEL = 1.0

# The PUNCH: a pitch-dropping sine hit, the way a kick drum is built — the
# one thing in the mix with a hard edge.
PUNCH_ATTACK_SECONDS = 0.001
PUNCH_TAU_SECONDS = 0.14
PUNCH_PITCH_START_HZ = 220.0
PUNCH_PITCH_END_HZ = 45.0
PUNCH_PITCH_TAU_SECONDS = 0.05
PUNCH_LEVEL = 2.0

# Crack: one SHORT mid-band transient with a real attack (an instant edge is a
# click), the mallet on the metal.
CRACK_ATTACK_SECONDS = 0.002
CRACK_TAU_SECONDS = 0.02
CRACK_BAND_HZ = (300.0, 3500.0)
CRACK_LEVEL = 0.45

# Soft clip on the sheet and punch: rounds the hit and glues the modes. The
# crack stays clean — clipping a bright transient is what distortion sounds like.
THUNDER_DRIVE = 1.6

# Different strike points and shakes give different claps; the plugin picks
# one per strike.
THUNDER_VARIANTS = 3


def sheet_modes() -> tuple[np.ndarray, np.ndarray]:
    """Frequencies and per-mode levels for one strike point on the plate."""
    m = np.arange(1, SHEET_MODES_PER_AXIS + 1)
    mm, nn = np.meshgrid(m, m, indexing="ij")
    frequencies = SHEET_FUNDAMENTAL_HZ * (mm**2 + (nn / SHEET_ASPECT) ** 2) / (
        1 + 1 / SHEET_ASPECT**2
    )
    strike_x, strike_y = rng.uniform(*SHEET_STRIKE_RANGE, 2)
    levels = np.sin(np.pi * mm * strike_x) * np.sin(np.pi * nn * strike_y)
    keep = (frequencies.ravel() >= SHEET_BOTTOM_HZ) & (frequencies.ravel() <= SHEET_TOP_HZ)
    return frequencies.ravel()[keep], levels.ravel()[keep]


def make_sheet(count: int, seconds: np.ndarray) -> np.ndarray:
    frequencies, levels = sheet_modes()
    taus = SHEET_FUNDAMENTAL_TAU_SECONDS * (frequencies / SHEET_FUNDAMENTAL_HZ) ** (
        -SHEET_DAMPING_SLOPE
    )
    flex = 1.0 + SHEET_FLEX_DEPTH * np.exp(-seconds / SHEET_FLEX_TAU_SECONDS) * slow_noise(
        count, SHEET_FLEX_HZ
    )
    swell = np.minimum(seconds / SHEET_ATTACK_SECONDS, 1.0)
    phases = rng.uniform(0.0, 2 * np.pi, frequencies.size)
    out = np.zeros(count)
    for frequency, level, tau, phase in zip(frequencies, levels, taus, phases):
        angle = 2 * np.pi * frequency * np.cumsum(flex) / SAMPLE_RATE_HZ
        out += level * np.exp(-seconds / tau) * np.sin(angle + phase)
    return lowpass(out * swell, SHEET_TILT_HZ)


def make_thunder() -> np.ndarray:
    count = int(THUNDER_SECONDS * SAMPLE_RATE_HZ)
    seconds = seconds_axis(count)
    noise = rng.standard_normal(count)

    sheet = make_sheet(count, seconds)

    pitch = PUNCH_PITCH_END_HZ + (PUNCH_PITCH_START_HZ - PUNCH_PITCH_END_HZ) * np.exp(
        -seconds / PUNCH_PITCH_TAU_SECONDS
    )
    punch = np.sin(2 * np.pi * np.cumsum(pitch) / SAMPLE_RATE_HZ) * (
        np.minimum(seconds / PUNCH_ATTACK_SECONDS, 1.0) * np.exp(-seconds / PUNCH_TAU_SECONDS)
    )

    crack = bandpass(noise, *CRACK_BAND_HZ) * (
        np.minimum(seconds / CRACK_ATTACK_SECONDS, 1.0) * np.exp(-seconds / CRACK_TAU_SECONDS)
    )

    low = SHEET_LEVEL * sheet / np.max(np.abs(sheet)) + PUNCH_LEVEL * punch
    shaped = np.tanh(THUNDER_DRIVE * low / np.max(np.abs(low)))
    shaped += CRACK_LEVEL * crack / np.max(np.abs(crack))
    # Guarantee a silent end regardless of the mode tails.
    fade_count = int(0.5 * SAMPLE_RATE_HZ)
    shaped[-fade_count:] *= np.linspace(1.0, 0.0, fade_count)
    return normalize(shaped)


# --- Rain loop ---------------------------------------------------------------
#
# Rain is a wash of noise gated by a dense train of short grains: broadband,
# tilted down at the top, dense enough to read as a steady bed yet grainy
# enough not to be flat white noise. No separate drops — owner call
# (2026-09-05): they read as ticks on top of the rain, not as rain. A slow
# gust rides the wash so a long listen never goes static.

# Under the 8 s cap; long enough that the loop point is not heard coming round.
RAIN_SECONDS = 8.0
# Long enough to hide the splice in grains, short enough not to eat the loop.
RAIN_CROSSFADE_SECONDS = 1.0

# Wash: rate × tau ≈ 9 grains sounding at any instant — smooth enough to be a
# bed, grainy enough not to be a solid hiss. Fewer, or shorter, is static.
WASH_PER_SECOND = 3500
WASH_TAU_SECONDS = 0.0025
WASH_BAND_HZ = (500.0, 9000.0)
WASH_TILT_HZ = 2500.0
WASH_LEVEL = 1.0
# Gusting: sub-audio movement of the wash level.
GUST_HZ = 0.35
GUST_DEPTH = 0.3


def grain_layer(count: int, per_second: float, tau: float, band: tuple[float, float]) -> np.ndarray:
    """Noise gated by a train of exponential grains at random times and levels."""
    total = int(per_second * count / SAMPLE_RATE_HZ)
    starts = rng.integers(0, count, total)
    kernel_count = int(tau * 8 * SAMPLE_RATE_HZ)
    kernel = np.exp(-seconds_axis(kernel_count) / tau)
    impulses = np.zeros(count + kernel_count)
    np.add.at(impulses, starts, rng.uniform(0.3, 1.0, total))
    envelope = np.convolve(impulses, kernel)[:count]
    return bandpass(rng.standard_normal(count), *band) * envelope


def make_rain_loop() -> np.ndarray:
    fade_count = int(RAIN_CROSSFADE_SECONDS * SAMPLE_RATE_HZ)
    body_count = int(RAIN_SECONDS * SAMPLE_RATE_HZ)
    # Extra material folded back over the head, so head and tail come from one
    # continuous stretch and the splice is inaudible, not merely quiet.
    count = body_count + fade_count

    wash = lowpass(grain_layer(count, WASH_PER_SECOND, WASH_TAU_SECONDS, WASH_BAND_HZ), WASH_TILT_HZ)
    wash *= 1.0 - GUST_DEPTH * (0.5 + 0.5 * slow_noise(count, GUST_HZ))
    mix = WASH_LEVEL * wash

    body = mix[:body_count].copy()
    tail = mix[body_count:]
    # EQUAL POWER: linear gains dip 3 dB mid-fade — a hole once per loop.
    angle = np.linspace(0.0, np.pi / 2, fade_count)
    body[:fade_count] = body[:fade_count] * np.sin(angle) + tail * np.cos(angle)
    return normalize(body)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    for index in range(THUNDER_VARIANTS):
        seed_asset("thunder", index)
        write_wav(root / f"plugins/thunderstorm/client/assets/thunder-{index}.wav", make_thunder())
    seed_asset("rain")
    write_wav(root / "plugins/rain/client/assets/rain-loop.wav", make_rain_loop())


if __name__ == "__main__":
    main()
