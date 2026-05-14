#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Ensure ~/.dotnet (where the .NET 9 SDK lives) is on PATH for non-interactive runs.
export PATH="$HOME/.dotnet:$PATH"

echo "==> dotnet publish"
dotnet publish src -c Release -o out

echo "==> deploy to rasp"
ssh rasp 'sudo mkdir -p /var/lib/jellyfin/plugins/SleepTimer_1.0.0.0'
scp out/Jellyfin.Plugin.SleepTimer.dll rasp:/tmp/SleepTimer.dll
ssh rasp 'sudo mv /tmp/SleepTimer.dll /var/lib/jellyfin/plugins/SleepTimer_1.0.0.0/Jellyfin.Plugin.SleepTimer.dll \
  && sudo chown -R jellyfin:jellyfin /var/lib/jellyfin/plugins/SleepTimer_1.0.0.0 \
  && sudo systemctl restart jellyfin'

echo "==> waiting for jellyfin to come back"
ssh rasp 'sleep 6; systemctl is-active jellyfin'

echo "==> recent plugin-related log lines"
ssh rasp 'sudo journalctl -u jellyfin -n 60 --no-pager | grep -iE "sleeptimer|loaded plugin|error|warn" | tail -25 || true'

echo "==> Installing in-player button..."
"$(dirname "$(readlink -f "$0")")/install-web.sh"
