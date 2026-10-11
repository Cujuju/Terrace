<#
.SYNOPSIS
  Draw-call census of a running Terrace client, taken from WINDOWS.

.DESCRIPTION
  Answers "who owns the draw calls" without anyone pasting console snippets.

  WHY THIS IS A WINDOWS SCRIPT AND NOT A BASH ONE. Only one direction of the
  WSL2 NAT boundary is open without firewall changes: Windows -> WSL localhost.
  An inbound CDP socket from WSL to Windows Chrome times out (measured; see
  scripts/gpu-bench.sh). And a Chrome launched INSIDE WSL has no /dev/dri, so it
  renders on SwiftShader, where triangles cost everything and draw calls cost
  nothing -- the exact inversion of what this measures. So the driver has to run
  on the side the GPU is on.

  It reports two different quantities, and confusing them is how earlier
  readings went wrong:

    drawables  objects with .visible true under each top-level layer. Scene
               COMPOSITION. An InstancedMesh counts once however many instances
               it carries.
    calls      renderer.info.render.drawCalls with every OTHER layer hidden. Actual
               DRAW CALLS, after frustum culling. (drawCalls, not calls: in three r185
               render.calls is the cumulative renderer.render() count since boot, while
               render.drawCalls is per-frame draws — the field frameStats uses.)

  The gap between the drawables total and the calls total is mostly culling --
  it is not, on its own, evidence of unattributed draws.

  ISOLATION, NOT DIFFERENCING. Each layer is measured alone rather than by
  subtracting an ablated run from a baseline. Differencing across runs is what
  produced two retracted per-plugin tables and one wrongly demoted ticket
  (#375); measuring one layer at a time in one frame cannot drift the same way.

  EVERY READING CARRIES ITS POSE. counters (pixelWidth/Height, cameraDistance,
  drawCalls, triangles, programs) come from __terracePerf.stats() and are
  written into the output, because a census taken at a different camera pose or
  window size is not comparable to another one. This is the mistake that forced
  the 2026-09-06 retraction.

.PARAMETER Url
  The client page. Defaults to the dev server Vite serves.

.PARAMETER Port
  CDP port. If something already answers there, this ATTACHES to it and no
  browser is launched -- so a Chrome you started yourself with
  --remote-debugging-port=9222 is measured in place, at your own camera pose.

.PARAMETER Out
  Where the JSON lands. Default: <repo>\.census\census-<stamp>.json

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File E:\Development\Projects\Terrace\scripts\draw-census.ps1

.EXAMPLE
  # Measure the tab you are already playing in, at your own pose:
  #   1. close Chrome, then start it once with the debug port:
  #      chrome.exe --remote-debugging-port=9222
  #   2. open the game, get the camera where you want it, then:
  powershell -ExecutionPolicy Bypass -File E:\...\draw-census.ps1 -Port 9222

.NOTES
  The page must be VISIBLE while this runs. Chrome stops servicing
  requestAnimationFrame in a tab it believes is hidden, and rAF is how each
  measured frame is stepped; a background tab makes this hang, not lie.

  It hides layers for a couple of frames each and restores them. The world
  flickers during the run. `callsAfterRestore` is written so a restore that did
  not take is visible rather than silent.
#>
[CmdletBinding()]
param(
  [string]$Url = 'http://localhost:5173/',
  [int]$Port = 9222,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

# The repo root, from this script's own location -- never a hard-coded path, so
# a checkout somewhere else still writes beside itself.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($Out)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Out = Join-Path $RepoRoot ".census\census-$stamp.json"
}
$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

function Get-CdpVersion {
  param([int]$P)
  try {
    return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$P/json/version").Content | ConvertFrom-Json
  } catch { return $null }
}

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw 'chrome.exe not found in the three usual install locations.'
}

# -- Attach if a debuggable Chrome is already up; otherwise launch our own. --
# ATTACHING IS THE BETTER MEASUREMENT when it is available: it reads YOUR tab,
# at your camera pose and window size, which is the pose the numbers have to
# describe. A launched browser gets whatever pose the page restores to.
$launched = $null
$version = Get-CdpVersion -P $Port
if ($null -ne $version) {
  Write-Host "attached to the Chrome already listening on $Port ($($version.Browser))" -ForegroundColor Green
} else {
  $chrome = Find-Chrome
  # Its OWN profile directory, so this cannot disturb the browser you use. The
  # same rule scripts/gpu-bench.sh follows.
  $profileDir = Join-Path $env:TEMP "terrace-census-profile-$PID"
  Write-Host "no CDP on $Port -- launching $chrome" -ForegroundColor Yellow
  $args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    $Url
  )
  $launched = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $version = Get-CdpVersion -P $Port
    if ($null -ne $version) { break }
  }
  if ($null -eq $version) { throw "Chrome did not open a CDP port on $Port within 20s." }
  # The client has to boot, connect and stream chunks before a census means
  # anything. The meter's own windows are 5s, so stats() is null before one closes.
  Write-Host 'waiting 15s for the client to boot and settle...'
  Start-Sleep -Seconds 15
}

# -- Pick the page target. --
$targets = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$Port/json/list").Content | ConvertFrom-Json
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -notlike 'devtools://*' } |
        Sort-Object { if ($_.url -like '*localhost*') { 0 } else { 1 } } | Select-Object -First 1
if ($null -eq $page) { throw 'no page target found on the CDP port.' }
Write-Host "target: $($page.url)"

# -- The census itself, evaluated in the page. --
$js = @'
(async () => {
  const r = globalThis.__terraceRenderer;
  const holder = globalThis.__terraceScene;
  const s = holder && holder.scene;
  if (!r || !s) {
    return { error: '__terraceRenderer/__terraceScene missing. These are dev-only (import.meta.env.DEV, client/src/render/scene.ts) -- a production build does not expose them.' };
  }
  const perf = globalThis.__terracePerf;
  const stats = (perf && perf.stats) ? perf.stats() : null;

  // Two rAFs, so the reading is from a frame that fully rendered after the
  // visibility change rather than the one it landed in the middle of.
  const frame = () => new Promise(res =>
    requestAnimationFrame(() => requestAnimationFrame(() => res(r.info.render.drawCalls))));

  const layers = s.children.filter(g => g.name);
  const unnamed = s.children.length - layers.length;

  const drawables = [];
  for (const g of layers) {
    let n = 0;
    g.traverseVisible(o => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) n++; });
    drawables.push({ layer: g.name, drawables: n });
  }

  const saved = layers.map(g => g.visible);
  const isolated = [];
  try {
    layers.forEach(g => { g.visible = false; });
    const baseline = await frame();
    for (const g of layers) {
      layers.forEach(x => { x.visible = false; });
      g.visible = true;
      isolated.push({ layer: g.name, calls: await frame() });
    }
    layers.forEach((g, i) => { g.visible = saved[i]; });
    const restored = await frame();
    return {
      takenAt: new Date().toISOString(),
      url: location.href,
      // The pose. A census at another pose is a different measurement.
      counters: stats ? stats.counters : null,
      frameMsP50: stats ? stats.frameMsP50 : null,
      renderMsP50: stats ? stats.renderMsP50 : null,
      intervalMsP50: stats ? stats.intervalMsP50 : null,
      gpuMsP50: stats ? stats.gpuMsP50 : null,
      statsNote: stats ? null : 'stats() was null -- no 5s meter window had closed yet.',
      unnamedTopLevelChildren: unnamed,
      baselineCallsAllHidden: baseline,
      callsAfterRestore: restored,
      drawables: drawables.sort((a, b) => b.drawables - a.drawables),
      isolated: isolated.sort((a, b) => b.calls - a.calls)
    };
  } catch (e) {
    // Never leave the world half-hidden because the run threw.
    layers.forEach((g, i) => { g.visible = saved[i]; });
    return { error: 'census threw: ' + String(e && e.message ? e.message : e) };
  }
})()
'@

# -- CDP over a WebSocket. --
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).Wait(10000) | Out-Null
if ($ws.State -ne 'Open') { throw "could not open a CDP websocket (state $($ws.State))." }

function Send-Cdp {
  param($Socket, [int]$Id, [string]$Method, $Params)
  $payload = @{ id = $Id; method = $Method }
  if ($null -ne $Params) { $payload.params = $Params }
  $json = $payload | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object 'System.ArraySegment[byte]' (,$bytes)
  $Socket.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait(10000) | Out-Null
}

function Receive-Cdp {
  param($Socket, [int]$WantId, [int]$TimeoutSec = 120)
  $buffer = New-Object byte[] 65536
  $seg = New-Object 'System.ArraySegment[byte]' (,$buffer)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $sb = New-Object Text.StringBuilder
    do {
      $task = $Socket.ReceiveAsync($seg, [System.Threading.CancellationToken]::None)
      if (-not $task.Wait([int]([Math]::Max(1000, ($deadline - (Get-Date)).TotalMilliseconds)))) {
        throw 'timed out waiting for a CDP frame. Is the page in the FOREGROUND? Chrome suspends rAF in a hidden tab.'
      }
      $res = $task.Result
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
    } while (-not $res.EndOfMessage)
    $msg = $sb.ToString() | ConvertFrom-Json
    # Events (no id) stream past; only the reply to our own id is the answer.
    if ($null -ne $msg.id -and [int]$msg.id -eq $WantId) { return $msg }
  }
  throw 'timed out waiting for the census reply.'
}

# rAF does not run in a tab Chrome thinks is hidden, so raise it first.
Send-Cdp -Socket $ws -Id 1 -Method 'Page.bringToFront' -Params $null
try { Receive-Cdp -Socket $ws -WantId 1 -TimeoutSec 10 | Out-Null } catch { Write-Host 'Page.bringToFront did not reply; continuing.' -ForegroundColor DarkYellow }

Write-Host 'running the census (the world will flicker for a second or two)...'
Send-Cdp -Socket $ws -Id 2 -Method 'Runtime.evaluate' -Params @{
  expression    = $js
  awaitPromise  = $true
  returnByValue = $true
}
$reply = Receive-Cdp -Socket $ws -WantId 2 -TimeoutSec 180

if ($null -ne $reply.error) { throw "CDP error: $($reply.error | ConvertTo-Json -Compress)" }
if ($null -ne $reply.result.exceptionDetails) {
  throw "page threw: $($reply.result.exceptionDetails.text) $($reply.result.exceptionDetails.exception.description)"
}
$value = $reply.result.result.value
if ($null -eq $value) { throw 'the census returned nothing.' }
if ($null -ne $value.error) { throw "census refused: $($value.error)" }

$value | ConvertTo-Json -Depth 8 | Set-Content -Path $Out -Encoding UTF8

# -- Say it on screen too, so the run is readable without opening the file. --
Write-Host ''
Write-Host "pose: $($value.counters.pixelWidth)x$($value.counters.pixelHeight)  cameraDistance $([math]::Round($value.counters.cameraDistance,1))  drawCalls $($value.counters.drawCalls)  triangles $($value.counters.triangles)  programs $($value.counters.programs)" -ForegroundColor Cyan
Write-Host "frame p50 $([math]::Round($value.frameMsP50,2))ms  render p50 $([math]::Round($value.renderMsP50,2))ms  interval p50 $([math]::Round($value.intervalMsP50,2))ms  gpu p50 $($value.gpuMsP50)" -ForegroundColor Cyan
if ($value.statsNote) { Write-Host $value.statsNote -ForegroundColor DarkYellow }
Write-Host ''
Write-Host 'DRAW CALLS, each layer alone (baseline with everything hidden:' $value.baselineCallsAllHidden ')' -ForegroundColor Green
$value.isolated | Select-Object -First 20 | Format-Table -AutoSize
Write-Host 'DRAWABLE OBJECTS per layer (composition, not draws)' -ForegroundColor Green
$value.drawables | Select-Object -First 20 | Format-Table -AutoSize
Write-Host "calls after restore: $($value.callsAfterRestore) (should look like a normal frame; if it is near the hidden baseline, a layer did not come back -- reload the page)" -ForegroundColor DarkYellow
Write-Host ''
Write-Host "written: $Out" -ForegroundColor Green

$ws.Dispose()
if ($null -ne $launched) {
  Write-Host "the browser this script launched is still open (pid $($launched.Id)); close it when you are done." -ForegroundColor DarkYellow
}
