param(
  [Parameter(Mandatory = $true)][string]$ProfileMatch,
  [int]$HoldSeconds = 90,
  # Raise the window ONCE and exit, instead of holding it raised. See
  # scripts/gpu-bench.md's launch-mode table for when either is needed.
  [switch]$Once
)
# Raise the BENCHMARK'S Chrome window. A FALLBACK, NOT THE DEFAULT — measured
# 2026-09-03, see the launch-mode table in scripts/gpu-bench.md: with
# --disable-features=CalculateNativeWinOcclusion and the backgrounding switches,
# a window left wherever it lands samples at full rate and nothing here is
# needed. gpu-bench.sh calls this only when asked to.
#
# WHAT IT IS FOR: Chrome stops running requestAnimationFrame AND
# setTimeout/setInterval in a page it considers hidden. The measurement loop is
# rAF, so a page Chrome thinks is hidden reports nothing at all — which reads
# exactly like a crash. If a future Windows or Chrome build stops honouring the
# occlusion switches, -Once (raise once, then let focus go) and the continuous
# hold are the two escalations.
#
# WHY -ProfileMatch IS MANDATORY: this raises a window by force, and the operator
# may well have their OWN Chrome open. Only processes whose command line carries
# the benchmark's throwaway --user-data-dir are touched; nothing else on the
# desktop is disturbed.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
$SW_RESTORE = 9
$deadline = (Get-Date).AddSeconds($HoldSeconds)
$found = $false
while ((Get-Date) -lt $deadline) {
  # The benchmark's Chrome, and only it: the pids whose command line names the
  # throwaway profile directory this run was launched with.
  $pids = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
          Where-Object { $_.CommandLine -like "*$ProfileMatch*" } |
          ForEach-Object { $_.ProcessId }
  $p = Get-Process -Id $pids -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } |
       Select-Object -First 1
  if ($p) {
    if (-not $found) { "raised: $($p.MainWindowTitle)"; $found = $true }
    [Win]::ShowWindow($p.MainWindowHandle, $SW_RESTORE) | Out-Null
    [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    # -Once: the window existed and was raised, which is the whole job. Focus
    # then goes wherever the desktop takes it.
    if ($Once) { exit 0 }
  }
  Start-Sleep -Milliseconds 1000
}
if (-not $found) { "no benchmark chrome window found"; exit 1 }
exit 0
