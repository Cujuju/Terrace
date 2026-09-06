#!/bin/sh
# Runs bench.html on the Windows GPU (WSL Chrome only has SwiftShader).
# The page is found next to this script, so a worktree benches its own source and not the
# shared checkout's. Windows Chrome needs the Windows spelling of the path.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
win=$(wslpath -m "$dir/bench.html" 2>/dev/null || echo "$dir/bench.html" | sed 's|^/mnt/\(.\)|\U\1:|')
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu-sandbox --enable-gpu --use-angle=d3d11 --virtual-time-budget=60000 \
  --dump-dom "file:///$win" 2>/dev/null \
  | awk '/<pre id="out">/{p=1} p{print} /<\/pre>/{if(p)exit}' | sed 's/<[^>]*>//g'
