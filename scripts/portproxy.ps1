# Claude Bridge — Windows Port Proxy for Tailscale/VPN -> WSL2
# Run as Administrator after each reboot (WSL2 IP changes on restart)
#
# This forwards traffic from your network IP on the bridge port
# to the WSL2 instance where Claude Bridge runs.
#
# Usage:
#   # Edit these variables for your setup:
#   $listenIp = "YOUR_TAILSCALE_OR_VPN_IP"
#   $listenPort = 3100
#
#   # Then run as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\portproxy.ps1

$listenIp = $env:BRIDGE_LISTEN_IP
$listenPort = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { 3100 }

if (-not $listenIp) {
    Write-Host "Set BRIDGE_LISTEN_IP environment variable to your Tailscale/VPN IP."
    Write-Host "Example: `$env:BRIDGE_LISTEN_IP = '100.x.y.z'"
    Write-Host ""
    Write-Host "Or edit this script and hardcode your IP."
    exit 1
}

$wslIp = (wsl hostname -I).Trim().Split(' ')[0]
if (-not $wslIp) {
    Write-Error "Could not detect WSL2 IP. Is WSL running?"
    exit 1
}

# Remove stale rule (ignore errors if none exists)
netsh interface portproxy delete v4tov4 listenport=$listenPort listenaddress=$listenIp 2>$null

# Add fresh rule pointing to current WSL2 IP
netsh interface portproxy add v4tov4 listenport=$listenPort listenaddress=$listenIp connectport=$listenPort connectaddress=$wslIp

# Verify
$rules = netsh interface portproxy show v4tov4
Write-Host ""
Write-Host "Bridge portproxy updated: ${listenIp}:${listenPort} -> ${wslIp}:${listenPort}"
Write-Host ""
Write-Host $rules
