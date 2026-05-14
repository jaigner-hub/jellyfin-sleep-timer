#!/usr/bin/env bash
# install-web.sh — install sleep-timer.js and patch index.html on rasp.
# Idempotent: safe to run repeatedly. Re-run after `apt upgrade jellyfin-web`.
set -euo pipefail

HOST="${SLEEP_TIMER_HOST:-rasp}"
WEB_DIR="/usr/share/jellyfin/web"
SCRIPT_NAME="sleep-timer.js"
SCRIPT_SRC="$(dirname "$(readlink -f "$0")")/../web/$SCRIPT_NAME"
TAG='<script src="sleep-timer.js"></script>'

if [[ ! -f "$SCRIPT_SRC" ]]; then
    echo "ERROR: $SCRIPT_SRC not found" >&2
    exit 1
fi

echo "==> Copying $SCRIPT_NAME to $HOST:$WEB_DIR/"
scp -q "$SCRIPT_SRC" "$HOST:/tmp/$SCRIPT_NAME"
ssh "$HOST" "sudo mv /tmp/$SCRIPT_NAME $WEB_DIR/$SCRIPT_NAME && sudo chown root:root $WEB_DIR/$SCRIPT_NAME && sudo chmod 644 $WEB_DIR/$SCRIPT_NAME"

echo "==> Patching index.html on $HOST"
ssh "$HOST" bash -s <<EOF
set -euo pipefail
INDEX="$WEB_DIR/index.html"
BACKUP="\$INDEX.sleep-timer-orig"

if [[ ! -f "\$INDEX" ]]; then
    echo "ERROR: \$INDEX not found" >&2
    exit 1
fi

if [[ ! -f "\$BACKUP" ]]; then
    echo "    creating backup at \$BACKUP"
    sudo cp -a "\$INDEX" "\$BACKUP"
fi

if grep -qF '$TAG' "\$INDEX"; then
    echo "    already patched — no change"
    exit 0
fi

if ! grep -qF '</body>' "\$INDEX"; then
    echo "ERROR: no </body> tag found in \$INDEX" >&2
    exit 1
fi

sudo sed -i 's|</body>|$TAG</body>|' "\$INDEX"
echo "    patched."
EOF

echo "==> Done. Reload any open Jellyfin tabs / restart JMP."
