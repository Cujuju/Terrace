#!/bin/sh
# Runs bench.html on the Windows GPU (WSL Chrome only has SwiftShader).
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --disable-gpu-sandbox --enable-gpu --use-angle=d3d11 --virtual-time-budget=60000 \
  --dump-dom "file:///E:/Development/Projects/Terrace/.void-bench/bench.html" 2>/dev/null \
  | awk '/<pre id="out">/{p=1} p{print} /<\/pre>/{if(p)exit}' | sed 's/<[^>]*>//g'
