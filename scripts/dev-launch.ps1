# Runs an Electron repo's dev command with no console window; target of scripts/dev-shortcut.ps1.
# Hands off to an interactive Scheduled Task when invoked from a non-Default desktop (e.g. agent sandboxes).
param(
    [string]$Project = (Split-Path -Parent $PSScriptRoot),
    [string]$Name = (Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)),
    [string[]]$RunArgs = @('dev'),
    [string]$TaskName,
    [string]$MutexName,
    [string]$LogName,
    [string[]]$DefaultEnv = @(),
    [switch]$SingleInstance,
    [switch]$AfterExit,
    [switch]$HideElectronShortcut
)
$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path -LiteralPath $Project).Path.TrimEnd('\')
# powershell.exe -File passes comma-joined tokens as one string; normalize so both -File and -Command work.
$RunArgs = @($RunArgs | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' })
$DefaultEnv = @($DefaultEnv | ForEach-Object { $_ -split ',' } | Where-Object { $_ -ne '' })
if (-not $TaskName) { $TaskName = "DevApp-$Name" }
if (-not $MutexName) { $MutexName = "Local\DevApp-$Name" }
if (-not $LogName) { $LogName = "$Name-dev.log" }
# Covers an exiting app draining state and releasing locked binaries before relaunch.
$restartWaitSeconds = 60
$restartPollMs = 200
$interactiveDesktop = 'Default'
$log = Join-Path $env:TEMP $LogName
# Running a manager other than the lockfile's reinstalls node_modules in its own layout.
$managerByLockfile = @{ 'pnpm-lock.yaml' = 'pnpm'; 'package-lock.json' = 'npm' }

function Get-CurrentDesktopName {
    if (-not ('DevLauncherDesktop.Native' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DevLauncherDesktop {
    public static class Native {
        const int UOI_NAME = 2;
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, uint length, out uint needed);

        public static string CurrentDesktopName() {
            IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
            if (desktop == IntPtr.Zero) return string.Empty;
            var buffer = new StringBuilder(256);
            uint needed;
            return GetUserObjectInformationW(desktop, UOI_NAME, buffer, (uint)(buffer.Capacity * 2), out needed)
                ? buffer.ToString()
                : string.Empty;
        }
    }
}
'@
    }
    [DevLauncherDesktop.Native]::CurrentDesktopName()
}

# Electron recreates its notification shortcut visible if deleted; hidden, Start lists the dev shortcut instead.
function Hide-ElectronShortcut {
    $exe = Join-Path $Project 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $exe)) { return }
    $productName = (Get-Item -LiteralPath $exe).VersionInfo.ProductName
    $file = Join-Path ([Environment]::GetFolderPath('Programs')) "$productName.lnk"
    $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if (-not $item -or ($item.Attributes -band [IO.FileAttributes]::Hidden)) { return }
    if ((New-Object -ComObject WScript.Shell).CreateShortcut($file).TargetPath -like "$Project\node_modules\*") {
        $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden
    }
}

function Get-AppWindow {
    # Only windowed Electron processes count for multi-process repos whose server workers reuse electron.exe.
    Get-Process electron -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$Project\node_modules\*" -and $_.MainWindowHandle -ne 0 }
}

function Get-AppProcess {
    if ($SingleInstance) {
        return Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Project\node_modules\*" }
    }
    Get-AppWindow
}

function Show-RunningApp {
    $window = Get-AppWindow | Select-Object -First 1
    if ($window) { [void](New-Object -ComObject WScript.Shell).AppActivate($window.Id); return }
    if (-not $SingleInstance) { return }
    # Hidden in the tray: trigger Electron's second-instance handler so the running app shows its window.
    $main = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
        Where-Object { $_.ExecutablePath -like "$Project\node_modules\*" -and $_.CommandLine -notmatch '--type=' } |
        Select-Object -First 1
    if ($main) {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Start-Process -FilePath $main.ExecutablePath -ArgumentList "`"$Project`"" -WorkingDirectory $Project
    }
}

function Format-CmdArg([string]$Value) {
    if ($Value -match '[\s&|<>^"]') { '"' + ($Value -replace '"', '\"') + '"' } else { $Value }
}

# Non-Default desktops (e.g. agent sandboxes like WinSta0\exebox-*) have no user shell or tray;
# hand off to the registered interactive Scheduled Task so the app starts on WinSta0\Default.
$desktop = Get-CurrentDesktopName
if ($desktop -ne $interactiveDesktop) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        [Console]::Error.WriteLine("Cannot launch $Name from non-interactive desktop '$desktop': Scheduled Task '$TaskName' is not registered. Run the repo's dev:shortcut script once to register it.")
        exit 1
    }
    if ($AfterExit) {
        $waitLock = [Threading.Mutex]::new($false, $MutexName)
        $deadline = (Get-Date).AddSeconds($restartWaitSeconds)
        $acquired = $false
        try {
            try { $acquired = $waitLock.WaitOne([TimeSpan]::FromSeconds($restartWaitSeconds)) } catch [Threading.AbandonedMutexException] { $acquired = $true }
            while ((Get-AppProcess) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $restartPollMs }
        } finally {
            if ($acquired) { $waitLock.ReleaseMutex() }
            $waitLock.Dispose()
        }
    }
    Start-ScheduledTask -TaskName $TaskName
    exit 0
}

# Held while the dev command runs; with it or a running app, a click focuses the app instead of starting another build.
$lock = [Threading.Mutex]::new($false, $MutexName)
$wait = if ($AfterExit) { [TimeSpan]::FromSeconds($restartWaitSeconds) } else { [TimeSpan]::Zero }
$deadline = (Get-Date) + $wait
try { $owned = $lock.WaitOne($wait) } catch [Threading.AbandonedMutexException] { $owned = $true }
# An app started from a terminal holds no lock, so also wait for its process.
while ($AfterExit -and $owned -and (Get-AppProcess) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $restartPollMs }
if (-not $owned -or (Get-AppProcess)) {
    Show-RunningApp
    if ($owned) { $lock.ReleaseMutex() }
    exit 0
}

try {
    $managers = @($managerByLockfile.Keys | Where-Object { Test-Path -LiteralPath (Join-Path $Project $_) } |
        ForEach-Object { $managerByLockfile[$_] })
    if ($managers.Count -ne 1) {
        "Expected exactly one of $($managerByLockfile.Keys -join ', ') in $Project." | Set-Content -LiteralPath $log
        exit 1
    }
    # Inherited from an Electron-hosted parent, it makes electron.exe run as plain Node.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    foreach ($entry in $DefaultEnv) {
        $eq = $entry.IndexOf('=')
        if ($eq -le 0) { continue }
        $key = $entry.Substring(0, $eq)
        $val = $entry.Substring($eq + 1)
        if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key))) {
            [Environment]::SetEnvironmentVariable($key, $val, 'Process')
        }
    }
    Set-Location -LiteralPath $Project
    if ($HideElectronShortcut) { Hide-ElectronShortcut }
    $quotedArgs = ($RunArgs | ForEach-Object { Format-CmdArg $_ }) -join ' '
    # The headless console has no window; the log is the only place errors show.
    # Through cmd: Windows PowerShell treats package-manager stderr lines as errors and stops the script.
    cmd.exe /d /c "$($managers[0]) $quotedArgs > `"$log`" 2>&1"
} finally {
    $lock.ReleaseMutex()
}
