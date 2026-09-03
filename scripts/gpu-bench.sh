#!/usr/bin/env bash
# THE REAL-GPU FRAME BENCHMARK — one command, one JSON line.
#
#   TERRACE_PERF_SINK=<absolute .jsonl> bash scripts/gpu-bench.sh [mode] <scenario> <label>
#
# Scenarios are the keys of SCENARIOS in client/src/perfProbe.ts (idle, sculpt,
# cyclone). scripts/gpu-bench.md has the stack this expects to be running and
# the field contract of the line this prints.
#
# ─────────────────────────────────────────────────────────────────────────────
# LAUNCH MODES. The default takes NO desktop focus — measured 2026-09-03 (the
# table in scripts/gpu-bench.md), not assumed. The escalations exist because
# Chrome stops running requestAnimationFrame in a page it thinks is hidden, and
# rAF is the sampling loop; if a future Chrome or Windows build stops honouring
# the occlusion switches below, a run reports nothing and the next mode up is
# the fix. Each one is more intrusive than the last, so each is opt-in:
#
#   (default)     window opens wherever it lands, nothing is raised, focus stays
#                 with whatever had it.
#   --raise-once  raise the bench window one time, then let focus go.
#   --raise-hold  hold it raised for the whole run. STEALS DESKTOP FOCUS.
#   --headless    --headless=new, no window at all. VERIFY the `gpu` field names
#                 the discrete adapter: headless can fall back to SwiftShader,
#                 and a SwiftShader number cannot judge anything here.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS SHAPE. Linux-side Chrome here has no /dev/dri, so every WSL browser —
# headless or under WSLg — renders on SwiftShader, where triangles cost
# everything and draw calls cost nothing. That inverts the exact tradeoff most
# of this renderer's work turns on, so no number measured inside WSL can judge
# it. Windows Chrome has the discrete GPU.
#
# The page therefore measures ITSELF and POSTs to the dev server's /__perf sink
# rather than being driven over CDP: only ONE direction of the WSL2 NAT boundary
# is open without firewall changes — Windows -> WSL localhost. An inbound CDP
# socket from WSL to Windows times out.
#
# WHAT THIS SCRIPT TOUCHES: its own throwaway Chrome profile directory, and the
# Chrome processes whose command line names it. Nothing else — no other browser,
# no other process, no port.
set -uo pipefail

RAISE=none
HEADLESS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --raise-once) RAISE=once; shift ;;
    --raise-hold) RAISE=hold; shift ;;
    --headless) HEADLESS=1; shift ;;
    --*) echo "unknown flag $1 (see this script's header for the launch modes)" >&2; exit 2 ;;
    *) break ;;
  esac
done

SCENARIO=${1:?scenario: one of the SCENARIOS keys in client/src/perfProbe.ts}
LABEL=${2:?label recorded with the sample, e.g. main-305-run1}
SINK=${TERRACE_PERF_SINK:?TERRACE_PERF_SINK must be the ABSOLUTE .jsonl path the running Vite was started with}
case "$SINK" in
  /*) ;;
  *) echo "TERRACE_PERF_SINK must be absolute (Vite runs in client/, this script in the repo root)" >&2; exit 2 ;;
esac

# The page the benchmark opens. 5199, not 5173: the owner's own stack owns 5173
# and 2567, and a bench must never touch them (scripts/gpu-bench.md).
PROBE_URL=${TERRACE_PROBE_URL:-http://localhost:5199}

# How long the page is left alone before the scenario starts, in milliseconds.
# Passed through to the probe's `settle` query flag, which defaults to the same
# number; overridable for a small world that streams in faster.
SETTLE_MS=${TERRACE_PROBE_SETTLE_MS:-45000}

# Slack on top of the settle, in seconds, before this script gives up waiting
# for a sample. 180 s covers the worst case a scenario can legitimately take:
# Vite's dependency optimiser reloading the page once on a cold profile (which
# restarts the settle timer from zero), plus the cyclone scenario's 30 s wait
# for the server's first storm broadcast, plus the sampling itself.
SCENARIO_SLACK_SECONDS=180
SAMPLE_TIMEOUT_SECONDS=$(( SETTLE_MS / 1000 + SCENARIO_SLACK_SECONDS ))

WINDOWS_HOME=$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')
# A THROWAWAY PROFILE, recreated every run. A force-killed Chrome profile comes
# back with a session-restore prompt, and that instance never reaches the probe
# URL; a fresh one also guarantees no stored camera pose, which is what makes
# the probe's parked bearing identical from run to run (perfProbe.ts's dollyTo).
CHROME_PROFILE_WIN="${WINDOWS_HOME}\\terrace-chrome-bench"
CHROME_PROFILE_WSL="$(wslpath -u "$CHROME_PROFILE_WIN")"
CHROME_EXE='C:\Program Files\Google\Chrome\Application\chrome.exe'
FOREGROUND_PS1_WIN="$(wslpath -w "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gpu-bench-foreground.ps1")"

# Kill ONLY this benchmark's Chrome, matched on the throwaway profile in its
# command line. Never a bare pkill: that self-matches this script's own
# command line and would take down whatever else happened to mention chrome.
powershell.exe -NoProfile -Command \
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*terrace-chrome-bench*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
  >/dev/null 2>&1
rm -rf "$CHROME_PROFILE_WSL"

# Create the sink if the stack has not written to it yet, so the poll below
# reads a real file instead of erroring once a second.
touch "$SINK"
BEFORE=$(wc -l < "$SINK")

# --disable-gpu-vsync/--disable-frame-rate-limit: with vsync on, this scene pins
#   to the 144 Hz display and the frame time stops discriminating between builds.
# --disable-*-throttling/backgrounding + CalculateNativeWinOcclusion: a Chrome
#   window Windows reports as occluded stops running requestAnimationFrame
#   entirely, and rAF IS the sampling loop. The window this opens lands behind
#   the terminal, so without the occlusion feature turned off the run simply
#   never reports. CalculateNativeWinOcclusion is the Windows-specific half —
#   --disable-backgrounding-occluded-windows alone does not stop it.
# --window-size: fixed, because frame time is a function of pixel count and a
#   bench whose window size varies is not comparable with itself.
HEADLESS_FLAGS=()
# --headless=new keeps a real GPU-backed compositor (the old --headless did
# not); it is still checked at the end, because a headless Chrome that cannot
# reach the adapter silently falls back to SwiftShader.
[ "$HEADLESS" = 1 ] && HEADLESS_FLAGS=(--headless=new)

cmd.exe /c start "" "$CHROME_EXE" \
  --user-data-dir="$CHROME_PROFILE_WIN" \
  --no-first-run --no-default-browser-check --new-window \
  --window-size=1600,900 \
  "${HEADLESS_FLAGS[@]}" \
  --disable-gpu-vsync --disable-frame-rate-limit \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=CalculateNativeWinOcclusion \
  "${PROBE_URL}/?perfprobe=${SCENARIO}&settle=${SETTLE_MS}" >/dev/null 2>&1 &

case "$RAISE" in
  once)
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$FOREGROUND_PS1_WIN" \
      -ProfileMatch terrace-chrome-bench -HoldSeconds "$SAMPLE_TIMEOUT_SECONDS" -Once \
      >/dev/null 2>&1 &
    ;;
  hold)
    # STEALS WINDOWS DESKTOP FOCUS for the length of the run. Opt-in only.
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$FOREGROUND_PS1_WIN" \
      -ProfileMatch terrace-chrome-bench -HoldSeconds "$SAMPLE_TIMEOUT_SECONDS" \
      >/dev/null 2>&1 &
    ;;
esac

# The probe posts heartbeats and then exactly one line carrying fpsMean (or one
# carrying `error`). Poll for either.
for _ in $(seq 1 "$SAMPLE_TIMEOUT_SECONDS"); do
  tail -n +"$((BEFORE + 1))" "$SINK" 2>/dev/null | grep -qE '"(fpsMean|error)"' && break
  sleep 1
done

RESULT=$(tail -n +"$((BEFORE + 1))" "$SINK" 2>/dev/null | grep -E '"(fpsMean|error)"' | tail -n 1)
if [ -z "$RESULT" ]; then
  echo "NO SAMPLE after ${SAMPLE_TIMEOUT_SECONDS}s — check that Chrome reached ${PROBE_URL} and that Vite was started with TERRACE_PERF_SINK=${SINK}" >&2
  exit 1
fi
printf '%s' "$RESULT" | python3 -c "
import json, sys
sample = json.load(sys.stdin)
sample['label'] = '$LABEL'
sample['scenario'] = '$SCENARIO'
# The launch mode is part of the measurement's provenance: a headless run that
# fell back to SwiftShader and a windowed one are not comparable, and the reader
# needs to see which was which without going back to the shell history.
sample['launchMode'] = '$RAISE' if '$HEADLESS' == '0' else 'headless'
print(json.dumps(sample))
"

# A SwiftShader number cannot judge anything here — say so rather than let it be
# quoted as a frame time.
case "$RESULT" in
  *SwiftShader*|*"Google SwiftShader"*|*llvmpipe*)
    echo "WARNING: this run rendered on a software rasteriser, not the discrete GPU — discard it" >&2
    ;;
esac
