# Expose the Terrace dev stack to the LAN (phones, other PCs) from WSL2.
# Run in an ELEVATED PowerShell on Windows:  powershell -ExecutionPolicy Bypass -File scripts\expose-lan.ps1
#
# WSL2 is NAT'd: the Windows LAN IP does not reach WSL directly, so this
# creates netsh portproxy rules pointing at the CURRENT WSL IP (which drifts
# across reboots - re-run this script after a reboot if phones stop reaching
# the game) plus matching firewall rules.
#
# Ports:
#   5173 - Vite dev client (CLIENT_MODE = "dev")
#   2567 - game server: WebSocket protocol AND the built client (static mode)

$ErrorActionPreference = "Stop"

$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
if (-not $wslIp) { throw "Could not determine the WSL IP (is WSL running?)" }
Write-Host "WSL IP: $wslIp"

foreach ($port in 5173, 2567) {
    netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>$null | Out-Null
    netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp
    $ruleName = "Terrace LAN $port"
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
    Write-Host "Forwarded 0.0.0.0:$port -> ${wslIp}:$port (firewall open)"
}

# The LAN IP that actually routes: the interface carrying the default route,
# not merely the first IPv4 adapter (VirtualBox/WSL host adapters would win).
$defaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" |
    Sort-Object RouteMetric | Select-Object -First 1
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $defaultRoute.ifIndex |
    Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "On your phone (same Wi-Fi) - USE THIS IP, not a .local name:"
Write-Host "  dev client    : http://${lanIp}:5173"
Write-Host "  static client : http://${lanIp}:2567"
Write-Host ""
Write-Host "WHY NOT amd.local: it answers with several addresses (an IPv6 link-local"
Write-Host "plus every virtual adapter) and these forwards are IPv4-only, so any"
Write-Host "device that picks the wrong answer - iPhones prefer the IPv6 - fails to"
Write-Host "connect, apparently at random. The raw IP is deterministic."
Write-Host ""
Write-Host "NOTE (dev mode): the Vite client dials ws://<hostname>:2567 for the game"
Write-Host "socket, so the 2567 forward above is what makes the phone actually connect."
