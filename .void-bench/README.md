# Celestial void shader bench

`bench.html` times the wheel shader alone at 2560x1440 on the real GPU.
Chrome inside WSL only reaches SwiftShader, so run it through the Windows
Chrome from the project root:

    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
      --disable-gpu-sandbox --enable-gpu --use-angle=d3d11 \
      --dump-dom "file:///E:/Development/Projects/Terrace/.void-bench/bench.html" \
      | grep -A12 '<pre id="out">'

Regenerate the page's SHADERS block from the client's COMMON_GLSL + WHEEL_GLSL
(substitute the `${...}` constants) before each run. Numbers 2026-09-05,
RTX 3090: rev 10 1.7 ms, rev 15 6.1 ms, rev 16 2.1 ms per frame.
