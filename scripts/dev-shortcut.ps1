# Writes a Start Menu shortcut with an AppUserModelID, optional tile manifest, and optional interactive Scheduled Task.
# Electron's shell.writeShortcutLink can't set the manifest hint, which gives the Start tile its large logo.
# -ElectronExe: also writes Electron's notification shortcut, hidden (see Save-ElectronShortcut).
# -TaskName: registers an on-demand interactive Scheduled Task for launching onto WinSta0\Default.
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Target,
    [Parameter(Mandatory)][string]$Arguments,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$Icon,
    [Parameter(Mandatory)][string]$AppId,
    [string]$Description = 'Dev launcher',
    [string]$TileManifest,
    [string]$ElectronExe,
    [string]$TaskName
)
$ErrorActionPreference = 'Stop'

if (-not ('DevShortcut.Link' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace DevShortcut {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out ushort hotkey);
        void SetHotkey(ushort hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid FormatId; public uint PropertyId; }

    // PROPVARIANT holding VT_LPWSTR; 24 bytes on x64.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Value; }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLinkCoClass { }

    public static class Link {
        const ushort VT_LPWSTR = 31;
        static readonly Guid AppUserModelFormat = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        // propkey.h: PKEY_AppUserModel_ID and PKEY_AppUserModel_VisualElementsManifestHintPath.
        const uint AppUserModelIdProperty = 5;
        const uint TileManifestHintProperty = 31;
        const uint SHCNE_UPDATEITEM = 0x2000;
        // SHCNF_PATHW | SHCNF_FLUSH.
        const uint SHCNF_PATH_FLUSHED = 0x1005;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle file,
                                                     StringBuilder path, uint cch, uint flags);

        static void SetString(IPropertyStore store, uint propertyId, string text) {
            var key = new PropertyKey { FormatId = AppUserModelFormat, PropertyId = propertyId };
            var value = new PropVariant { Type = VT_LPWSTR, Value = Marshal.StringToCoTaskMemUni(text) };
            try { store.SetValue(ref key, ref value); } finally { Marshal.FreeCoTaskMem(value.Value); }
        }

        // Null or empty arguments, icon, description and tile manifest are left unset.
        public static void Save(string path, string target, string arguments, string workingDir,
                                string icon, string description, string appId, string tileManifest) {
            var link = (IShellLinkW)new ShellLinkCoClass();
            link.SetPath(target);
            if (!string.IsNullOrEmpty(arguments)) link.SetArguments(arguments);
            link.SetWorkingDirectory(workingDir);
            if (!string.IsNullOrEmpty(icon)) link.SetIconLocation(icon, 0);
            if (!string.IsNullOrEmpty(description)) link.SetDescription(description);
            var store = (IPropertyStore)link;
            SetString(store, AppUserModelIdProperty, appId);
            if (!string.IsNullOrEmpty(tileManifest)) SetString(store, TileManifestHintProperty, tileManifest);
            store.Commit();
            ((IPersistFile)link).Save(path, true);
            // Start caches a shortcut's tile; this makes it read the shortcut again.
            SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATH_FLUSHED, path, IntPtr.Zero);
        }

        public static string FinalPath(string path) {
            using (var fs = new System.IO.FileStream(path, System.IO.FileMode.Open, System.IO.FileAccess.Read,
                                                     System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
                var buffer = new StringBuilder(1024);
                uint length = GetFinalPathNameByHandleW(fs.SafeFileHandle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity) throw new System.ComponentModel.Win32Exception();
                return buffer.ToString();
            }
        }
    }
}
'@
}

$folder = Split-Path -Parent $Path
if ($folder) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
[DevShortcut.Link]::Save($Path, $Target, $Arguments, $WorkingDirectory, $Icon, $Description, $AppId, $TileManifest)

# Processes launched by an MSIX-packaged app redirect AppData writes into a private copy Start never sees.
$actual = [DevShortcut.Link]::FinalPath($Path) -replace '^\\\\\?\\', ''
if ($actual -ne $Path) {
    Remove-Item -LiteralPath $Path
    throw "Windows redirected the shortcut to $actual, where Start can't see it. Run this from a terminal opened from Start."
}

# Unpackaged Electron keeps "Programs\<exe product name>.lnk" -> its exe, with the app's ID, for notifications.
# Start lists one shortcut per app ID, so keeping it hidden prevents it from replacing the dev shortcut.
function Save-ElectronShortcut {
    $name = (Get-Item -LiteralPath $ElectronExe).VersionInfo.ProductName
    $file = Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk"
    if (-not (Test-Path -LiteralPath $file)) {
        $unset = [NullString]::Value
        [DevShortcut.Link]::Save($file, $ElectronExe, $unset, (Split-Path -Parent $ElectronExe), $unset, $unset, $AppId, $unset)
    }
    $item = Get-Item -LiteralPath $file -Force
    $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden
}
if ($ElectronExe) { Save-ElectronShortcut }

# On-demand interactive task: lets non-Default desktops (e.g. agent sandboxes) hand off cleanly to WinSta0\Default.
# Parallel allows repeat triggers while running to focus/reopen the window; PT0S prevents the 72h default kill.
function Save-InteractiveTask {
    $action = New-ScheduledTaskAction -Execute $Target -Argument $Arguments -WorkingDirectory $WorkingDirectory
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances Parallel
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Description $Description -Force | Out-Null
}
if ($TaskName) { Save-InteractiveTask }
