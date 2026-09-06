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
## ─────────────────────────────────────────────────────────────────────────────
# WINDOW SIZE — THE THING EVERY EARLIER RUN LEFT UNSAID.
#
#   --fullscreen  no window size at all: --start-fullscreen, so the canvas is
#                 the whole display with no browser chrome above it. THIS IS THE
#                 TARGET (owner, 2026-09-06): full-screen 1440p is what the game
#                 is actually played at and therefore what it must be fast at.
#   TERRACE_PROBE_WINDOW=WxH   an explicit window size instead.
#
# The default stays 1600x900 so a run can still be compared with the numbers in
# docs/plans/frame-rate-decay-2026-09-05.md, every one of which was taken at
# that size — 1.44 Mpx, 39% of full-screen 1440p's 3.69 Mpx. Frame time is a
# function of pixel count, so those numbers do not describe the target and were
# never meant to be read as if they did. Every sample now carries its own
# drawing-buffer size (client/src/render/frameStats.ts), so no future reading
# can be ambiguous about which of these it is.
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
#
# ─────────────────────────────────────────────────────────────────────────────
# ONE RUN AT A TIME, MACHINE-WIDE. There is one GPU and one desktop here, and
# several agents share this repo. Concurrent runs are not merely noisy: until
# 2026-09-06 the second launch force-killed the first run's Chrome and deleted
# its profile, and the victim saw only NO SAMPLE, which reads exactly like a rig
# failure (#380). A run now takes an exclusive lock and fails fast naming the
# holder, and its profile directory carries its own pid, so a run can only ever
# destroy its own.
set -uo pipefail

RAISE=none
HEADLESS=0
FULLSCREEN=0
# 1600x900 for continuity with every historical sample; see the header.
PROBE_WINDOW=${TERRACE_PROBE_WINDOW:-1600x900}
while [ $# -gt 0 ]; do
  case "$1" in
    --raise-once) RAISE=once; shift ;;
    --raise-hold) RAISE=hold; shift ;;
    --headless) HEADLESS=1; shift ;;
    --fullscreen) FULLSCREEN=1; shift ;;
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

# Extra query flags appended to the probe URL, e.g. '&blocks=90&interval=60000'
# for a long `drift` soak. Scenario-specific flags belong to the scenario, not
# to this script's argument list, so they pass through rather than being parsed.
EXTRA_QUERY=${TERRACE_PROBE_EXTRA_QUERY:-}

# How long the page is left alone before the scenario starts, in milliseconds.
# Passed through to the probe's `settle` query flag, which defaults to the same
# number; overridable for a small world that streams in faster.
SETTLE_MS=${TERRACE_PROBE_SETTLE_MS:-45000}

# Slack on top of the settle, in seconds, before this script gives up waiting
# for a sample. 180 s covers the worst case a scenario can legitimately take:
# Vite's dependency optimiser reloading the page once on a cold profile (which
# restarts the settle timer from zero), plus the cyclone scenario's 30 s wait
# for the server's first storm broadcast, plus the sampling itself.
# Overridable because a scenario's own length is not knowable here: `drift`
# samples for four minutes by design, and would otherwise be declared a
# no-sample failure while it was still running correctly.
SCENARIO_SLACK_SECONDS=${TERRACE_PROBE_SLACK_SECONDS:-180}
SAMPLE_TIMEOUT_SECONDS=$(( SETTLE_MS / 1000 + SCENARIO_SLACK_SECONDS ))

# THE BENCH LOCK — machine-wide, deliberately not repo-relative: agents run this
# from separate worktrees but share one GPU, so a lock under any one checkout
# would be invisible to the run it has to exclude. flock is held by the process,
# so a killed run releases it and there is no stale lock to clear by hand.
BENCH_LOCK_FILE=${TERRACE_BENCH_LOCK:-/tmp/terrace-gpu-bench.lock}
# Append-open, not `>`: `>` truncates on open, wiping the holder's line before
# we know whether we won the lock.
exec 9>>"$BENCH_LOCK_FILE" || {
  echo "cannot open the bench lock $BENCH_LOCK_FILE" >&2; exit 2; }
if ! flock -n 9; then
  echo "BENCH LOCK HELD by $(cat "$BENCH_LOCK_FILE" 2>/dev/null || echo 'an unnamed run')" >&2
  echo "another benchmark owns this machine's GPU; wait for it — a shared run makes both numbers dishonest" >&2
  exit 3
fi
# Exit 3, distinct from 1 (no sample) and 2 (bad usage), so a caller can tell
# 'someone else is benching' from 'the rig is broken'.
printf 'pid %s, label %s, scenario %s, since %s\n' \
  "$$" "$LABEL" "$SCENARIO" "$(date -Is)" > "$BENCH_LOCK_FILE"

WINDOWS_HOME=$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')
: "${WINDOWS_HOME:?could not read the Windows USERPROFILE — refusing to guess a profile path to delete}"
WINDOWS_HOME_WSL="$(wslpath -u "$WINDOWS_HOME")"
# A THROWAWAY PROFILE, recreated every run. A force-killed Chrome profile comes
# back with a session-restore prompt, and that instance never reaches the probe
# URL; a fresh one also guarantees no stored camera pose, which is what makes
# the probe's parked bearing identical from run to run (perfProbe.ts's dollyTo).
# SUFFIXED WITH THIS RUN'S PID, so every match below — the kill, the delete, the
# window raise — can only ever name this run's own Chrome.
BENCH_PROFILE_PREFIX=terrace-chrome-bench
BENCH_PROFILE_DIR="${BENCH_PROFILE_PREFIX}-$$"
CHROME_PROFILE_WIN="${WINDOWS_HOME}\\${BENCH_PROFILE_DIR}"
CHROME_PROFILE_WSL="$(wslpath -u "$CHROME_PROFILE_WIN")"
CHROME_EXE='C:\Program Files\Google\Chrome\Application\chrome.exe'
# The same binary as a WSL path, for the direct launch below.
CHROME_EXE_WSL=$(wslpath -u "$CHROME_EXE")
FOREGROUND_PS1_WIN="$(wslpath -w "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gpu-bench-foreground.ps1")"

# Kill ONLY this benchmark's Chrome, matched on the throwaway profile prefix in
# its command line. Never a bare pkill: that self-matches this script's own
# command line and would take down whatever else happened to mention chrome.
# The prefix sweeps EVERY bench profile, not just this run's, which the lock
# above makes safe by construction: while it is held no other bench is live, so
# each surviving profile belongs to a run that has already finished. That is
# what keeps per-run profile directories from accumulating.
powershell.exe -NoProfile -Command \
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*${BENCH_PROFILE_PREFIX}*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
  >/dev/null 2>&1
find "$WINDOWS_HOME_WSL" -maxdepth 1 -type d -name "${BENCH_PROFILE_PREFIX}*" \
  -exec rm -rf {} + 2>/dev/null

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
# --start-fullscreen wins over --window-size: fullscreen is defined by the
# display, and passing both leaves it ambiguous which one Chrome honoured.
SIZE_FLAGS=("--window-size=${PROBE_WINDOW/x/,}")
[ "$FULLSCREEN" = 1 ] && SIZE_FLAGS=(--start-fullscreen)
HEADLESS_FLAGS=()
# --headless=new keeps a real GPU-backed compositor (the old --headless did
# not); it is still checked at the end, because a headless Chrome that cannot
# reach the adapter silently falls back to SwiftShader.
[ "$HEADLESS" = 1 ] && HEADLESS_FLAGS=(--headless=new)

# LAUNCHED DIRECTLY, NOT THROUGH `cmd.exe /c start` (fixed 2026-09-05).
# cmd re-parses its command line and treats `&` as a command separator, so
# everything after the FIRST `&` of the probe URL was silently dropped: the
# `settle` flag below never reached the page, and any scenario flag after it
# could not either. It went unnoticed because the script's default settle and
# the probe's own default are the same number. WSL execs a Windows binary with
# a real argv, so nothing re-parses the URL.
"$CHROME_EXE_WSL" \
  --user-data-dir="$CHROME_PROFILE_WIN" \
  --no-first-run --no-default-browser-check --new-window \
  "${SIZE_FLAGS[@]}" \
  "${HEADLESS_FLAGS[@]}" \
  --disable-gpu-vsync --disable-frame-rate-limit \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=CalculateNativeWinOcclusion \
  "${PROBE_URL}/?perfprobe=${SCENARIO}&settle=${SETTLE_MS}${EXTRA_QUERY}" >/dev/null 2>&1 &

case "$RAISE" in
  once)
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$FOREGROUND_PS1_WIN" \
      -ProfileMatch "$BENCH_PROFILE_DIR" -HoldSeconds "$SAMPLE_TIMEOUT_SECONDS" -Once \
      >/dev/null 2>&1 &
    ;;
  hold)
    # STEALS WINDOWS DESKTOP FOCUS for the length of the run. Opt-in only.
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$FOREGROUND_PS1_WIN" \
      -ProfileMatch "$BENCH_PROFILE_DIR" -HoldSeconds "$SAMPLE_TIMEOUT_SECONDS" \
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
