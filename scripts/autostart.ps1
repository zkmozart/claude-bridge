# Claude Bridge WSL Auto-Start
# This script boots WSL2 (which triggers systemd -> claude-bridge.service)
# Registered as a Windows Task Scheduler entry that runs at user login.
#
# Prerequisites:
#   - WSL2 with systemd enabled
#   - claude-bridge.service installed (see docs/SETUP.md)
#
# To register:
#   schtasks /create /tn "Claude Bridge WSL Boot" /tr "powershell -WindowStyle Hidden -File \"<PATH_TO_THIS_SCRIPT>\"" /sc onlogon /rl highest
#
# To remove:
#   schtasks /delete /tn "Claude Bridge WSL Boot" /f

# Set your WSL distribution name (run `wsl --list` to see available distros)
$distro = if ($env:BRIDGE_WSL_DISTRO) { $env:BRIDGE_WSL_DISTRO } else { "Ubuntu" }

# Boot WSL in background (systemd starts claude-bridge.service automatically)
wsl.exe -d $distro -- bash -c "echo '[Bridge] WSL booted, systemd running claude-bridge.service'"
