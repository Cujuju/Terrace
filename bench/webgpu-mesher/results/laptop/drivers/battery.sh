#!/bin/zsh
# Gate 2 battery run driver.  battery.sh <run> <url> [loopstats]
# Sampler first, browser within ten seconds, top at minute five, loop stats and
# battery at minute ten, then quits the browser and summarises.
set -u
RUN=$1; URL=$2; LOOPSTATS=${3:-}
HERE=${0:A:h}
OUT=/Users/shawnwilton/Documents/GitHub/Terrace/bench/webgpu-mesher/results/laptop
VIVALDI=/Applications/Vivaldi.app/Contents/MacOS/Vivaldi
DURATION=600

pmset -g batt | grep -q "Battery Power" || { echo "abort: not on battery"; exit 3; }
LEVEL=$(pmset -g batt | grep -o '[0-9]*%' | tr -d %)
(( LEVEL > 60 )) || { echo "abort: battery $LEVEL% <= 60%"; exit 3; }
# The owner's own Vivaldi may be running; only a gate-profile instance blocks.
pgrep -f 'user-data-dir=/tmp/gate2' >/dev/null && { echo "abort: gate2 Vivaldi already running"; exit 3; }
sudo -n /usr/bin/powermetrics --samplers cpu_power -i 100 -n 1 >/dev/null 2>&1 || { echo "abort: sudo -n powermetrics not permitted"; exit 3; }

# Vivaldi restores the last session's tabs; a bench profile starts with none.
rm -rf /tmp/gate2/Default/Sessions
# pmset's percentage sticks at 100 near full; raw charge in mAh resolves drain.
battery_raw() { ioreg -rn AppleSmartBattery | grep -E '"(AppleRawCurrentCapacity|Voltage|InstantAmperage)" ='; }

START=$(date +%s)
sudo -n /usr/bin/powermetrics --samplers cpu_power,gpu_power -i 1000 -n $DURATION \
  -o "$OUT/$RUN-powermetrics.txt" >/dev/null 2>&1 &
SAMPLER=$!
pmset -g batt > "$OUT/$RUN-batt-start.txt"
date '+%Y-%m-%dT%H:%M:%S%z' >> "$OUT/$RUN-batt-start.txt"
battery_raw >> "$OUT/$RUN-batt-start.txt"

"$VIVALDI" --user-data-dir=/tmp/gate2 --enable-unsafe-webgpu --no-first-run \
  --no-default-browser-check --remote-debugging-port=9222 --window-size=1200,1000 \
  "$URL" >/dev/null 2>&1 &
BROWSER=$!
echo "sampler $SAMPLER browser $BROWSER started $(( $(date +%s) - START )) s after sampler"

sleep 12
node "$HERE/cdp.mjs" size "$URL" > "$OUT/$RUN-window.txt" 2>&1
node "$HERE/closeothers.mjs" "$URL" >> "$OUT/$RUN-window.txt" 2>&1
node "$HERE/cdp.mjs" targets >> "$OUT/$RUN-window.txt" 2>&1
cat "$OUT/$RUN-window.txt"

sleep $(( START + 300 - $(date +%s) ))
# First top sample has no CPU% delta; take two one second apart, keep the second.
# Only the gate instance: its main process and the helpers it spawned.
PIDS=" $BROWSER $(pgrep -P $BROWSER | tr '\n' ' ')"
top -l 2 -s 1 -stats pid,cpu,command | awk '/^Processes:/ {n++} n==2' \
  | awk -v pids="$PIDS" 'index(pids, " " $1 " ")' > "$OUT/$RUN-top.txt"
awk '{s+=$2} END {printf "gate instance total CPU %.1f%%\n", s}' "$OUT/$RUN-top.txt" >> "$OUT/$RUN-top.txt"
echo "minute five top:"; cat "$OUT/$RUN-top.txt"

sleep $(( START + DURATION - 5 - $(date +%s) ))
if [[ -n $LOOPSTATS ]]; then
  node "$HERE/cdp.mjs" eval "$URL" 'JSON.stringify(__loopStats())' | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)+"\n"))' \
    > "$OUT/$RUN-loopstats.json"
  cat "$OUT/$RUN-loopstats.json"
fi
pmset -g batt > "$OUT/$RUN-batt-end.txt"
date '+%Y-%m-%dT%H:%M:%S%z' >> "$OUT/$RUN-batt-end.txt"
battery_raw >> "$OUT/$RUN-batt-end.txt"
wait $SAMPLER
# The client probe samples after its settle expires, just past the window; keep
# the browser up until its result line (not a heartbeat) lands in the sink.
if [[ -n ${WAIT_SINK:-} ]]; then
  for i in {1..120}; do grep -qE '"(sample|error)"' "$WAIT_SINK" 2>/dev/null && break; sleep 1; done
  grep -E '"(sample|error)"' "$WAIT_SINK" | tail -1 | cut -c1-400 || echo "probe result never arrived"
fi
kill $BROWSER 2>/dev/null; wait $BROWSER 2>/dev/null
# GPU Power prints twice per sample (cpu_power and gpu_power sections) and the
# two can differ; take the first, the one that sums into Combined.
awk '/^CPU Power/ {c+=$3; n++; f=1} /^GPU Power/ && f {g+=$3; f=0} /^Combined Power/ {t+=$8}
  /^GPU HW active residency/ {r+=$5; rn++}
  END {printf "samples %d  CPU %.0f mW  GPU %.0f mW  combined %.0f mW  GPU active %.1f%%\n", n, c/n, g/n, t/n, r/rn}' \
  "$OUT/$RUN-powermetrics.txt" | tee "$OUT/$RUN-summary.txt"
cat "$OUT/$RUN-batt-start.txt" "$OUT/$RUN-batt-end.txt"
