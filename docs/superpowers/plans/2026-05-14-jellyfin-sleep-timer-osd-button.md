# Sleep Timer OSD Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real sleep timer button to the Jellyfin video player OSD by dropping a static JS file into the server's web directory and patching `index.html`. Avoids the response-middleware approach (JS Injector + File Transformation) that broke HLS on rasp.

**Architecture:** Two new files (`web/sleep-timer.js`, `scripts/install-web.sh`), one edit to `scripts/deploy.sh`, one edit to `README.md`. The plugin C# code does not change. The JS uses Jellyfin's in-page `ApiClient` for auth and hits the existing `/SleepTimer/{Set,Cancel,Status}` endpoints. JMP ≥ 1.11.0 loads the server's web client, so the button reaches JMP automatically.

**Tech Stack:** Vanilla JS (no framework), bash, Material Icons (already loaded by jellyfin-web), Jellyfin 10.11.x web client conventions (`paper-icon-button-light`, `videoOsdBottom`).

**Spec:** `docs/superpowers/specs/2026-05-14-jellyfin-sleep-timer-osd-button-design.md`

---

## File Structure

```
web/
└── sleep-timer.js          ← new (Task 1)

scripts/
├── deploy.sh               ← modified (Task 3)
└── install-web.sh          ← new (Task 2)

README.md                   ← modified (Task 4)

docs/superpowers/plans/
└── 2026-05-14-jellyfin-sleep-timer-osd-button.md  ← this plan
```

Existing files left untouched: everything under `src/`, the bookmarklets, `INSTRUCTIONS.md`.

---

### Task 1: Write `web/sleep-timer.js`

**Files:**
- Create: `web/sleep-timer.js`

The script is fully self-contained. It uses a `MutationObserver` to detect the video OSD, injects a `paper-icon-button-light` with a `bedtime` Material Icon, opens a popover on click, and hits `/SleepTimer/{Set,Cancel,Status}`. The button shows a `MM:SS` countdown badge while a timer is active.

OSD structure (verified against jellyfin-web v10.11.8 `src/controllers/playback/video/index.html`):
- Main OSD container: `.videoOsdBottom`
- Button row: `.videoOsdBottom .buttons` (a `<div>` with `focuscontainer-x` class)
- Direct parent of buttons: a nested `<div dir="ltr">`
- Existing settings button (insert anchor): `.btnVideoOsdSettings`
- Existing button pattern: `<button is="paper-icon-button-light" class="btnX autoSize" title="..."><span class="material-icons X" aria-hidden="true">icon-name</span></button>`

We append the new button to the end of the inner `<div dir="ltr">` (after fullscreen) — most-recently-touched control position.

- [ ] **Step 1: Create the file with the full implementation**

```javascript
// Jellyfin Sleep Timer — in-player OSD button.
// Loaded by /usr/share/jellyfin/web/index.html via <script src="sleep-timer.js">.
// Calls the Jellyfin.Plugin.SleepTimer endpoints (/SleepTimer/Set, /Cancel, /Status)
// using the page's existing ApiClient session.

(function () {
    'use strict';

    var ALLOWED = [1, 15, 30, 60, 120];
    var POLL_MS = 30000;
    var TICK_MS = 1000;
    var BUTTON_CLASS = 'btnSleepTimer';

    var pollTimer = null;
    var tickTimer = null;
    var endsAtMs = 0;
    var popover = null;

    function authHeader() {
        return { Authorization: 'MediaBrowser Token="' + ApiClient.accessToken() + '"' };
    }

    function api(path, opts) {
        var init = { headers: authHeader() };
        if (opts && opts.method) init.method = opts.method;
        return fetch(ApiClient.serverAddress() + path, init);
    }

    function setTimer(minutes) {
        return api('/SleepTimer/Set?minutes=' + minutes, { method: 'POST' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
    }

    function cancelTimer() {
        return api('/SleepTimer/Cancel', { method: 'POST' })
            .then(function (r) { return r.ok ? null : Promise.reject(r.status); });
    }

    function fetchStatus() {
        return api('/SleepTimer/Status')
            .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
    }

    function formatRemaining(ms) {
        if (ms <= 0) return '';
        var total = Math.floor(ms / 1000);
        var m = Math.floor(total / 60);
        var s = total % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updateBadge() {
        var btn = document.querySelector('.' + BUTTON_CLASS);
        if (!btn) return;
        var badge = btn.querySelector('.sleepBadge');
        if (endsAtMs > Date.now()) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'sleepBadge';
                badge.style.cssText = 'position:absolute;bottom:-2px;right:-2px;background:#00a4dc;color:#fff;font-size:0.6em;padding:1px 4px;border-radius:8px;line-height:1;pointer-events:none;';
                btn.style.position = 'relative';
                btn.appendChild(badge);
            }
            badge.textContent = formatRemaining(endsAtMs - Date.now());
        } else if (badge) {
            badge.remove();
            endsAtMs = 0;
        }
    }

    function startTicking() {
        if (tickTimer) return;
        tickTimer = setInterval(updateBadge, TICK_MS);
    }

    function stopTicking() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    function refreshStatus() {
        fetchStatus().then(function (s) {
            if (s.active && s.endsAt) {
                endsAtMs = new Date(s.endsAt).getTime();
                updateBadge();
                startTicking();
            } else {
                endsAtMs = 0;
                updateBadge();
                stopTicking();
            }
        }).catch(function () { /* swallow — endpoint missing or 401 */ });
    }

    function startPolling() {
        refreshStatus();
        if (pollTimer) return;
        pollTimer = setInterval(refreshStatus, POLL_MS);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        stopTicking();
    }

    function closePopover() {
        if (popover) { popover.remove(); popover = null; }
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onDocKey, true);
    }

    function onDocClick(e) {
        if (popover && !popover.contains(e.target) && !e.target.closest('.' + BUTTON_CLASS)) {
            closePopover();
        }
    }

    function onDocKey(e) {
        if (e.key === 'Escape') closePopover();
    }

    function openPopover(anchorBtn) {
        closePopover();
        popover = document.createElement('div');
        popover.style.cssText = 'position:absolute;background:#202020;border:1px solid #444;border-radius:4px;padding:4px 0;z-index:9999;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
        var rect = anchorBtn.getBoundingClientRect();
        popover.style.left = Math.max(8, rect.left) + 'px';
        popover.style.top = (rect.top - 8) + 'px';
        popover.style.transform = 'translateY(-100%)';

        function row(label, action) {
            var item = document.createElement('div');
            item.textContent = label;
            item.style.cssText = 'padding:8px 16px;color:#fff;cursor:pointer;font-size:14px;';
            item.addEventListener('mouseenter', function () { item.style.background = '#00a4dc'; });
            item.addEventListener('mouseleave', function () { item.style.background = ''; });
            item.addEventListener('click', function () { action(); closePopover(); });
            return item;
        }

        popover.appendChild(row('Off', function () {
            cancelTimer().then(function () { endsAtMs = 0; updateBadge(); stopTicking(); })
                         .catch(function (e) { console.error('SleepTimer cancel failed:', e); });
        }));
        ALLOWED.forEach(function (n) {
            popover.appendChild(row(n + ' min', function () {
                setTimer(n).then(function (j) {
                    endsAtMs = new Date(j.endsAt).getTime();
                    updateBadge();
                    startTicking();
                }).catch(function (e) { console.error('SleepTimer set failed:', e); });
            }));
        });

        document.body.appendChild(popover);
        setTimeout(function () {
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('keydown', onDocKey, true);
        }, 0);
    }

    function injectButton(osd) {
        if (osd.querySelector('.' + BUTTON_CLASS)) return;
        var buttonRow = osd.querySelector('.buttons div[dir="ltr"]');
        if (!buttonRow) return;

        var btn = document.createElement('button');
        btn.setAttribute('is', 'paper-icon-button-light');
        btn.className = BUTTON_CLASS + ' autoSize';
        btn.title = 'Sleep timer';
        btn.innerHTML = '<span class="material-icons" aria-hidden="true">bedtime</span>';
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            openPopover(btn);
        });

        buttonRow.appendChild(btn);
        startPolling();
    }

    function watchOsd() {
        var existing = document.querySelector('.videoOsdBottom');
        if (existing) injectButton(existing);

        var mo = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    if (n.nodeType !== 1) continue;
                    if (n.classList && n.classList.contains('videoOsdBottom')) {
                        injectButton(n);
                    } else if (n.querySelector) {
                        var osd = n.querySelector('.videoOsdBottom');
                        if (osd) injectButton(osd);
                    }
                }
                var removed = mutations[i].removedNodes;
                for (var k = 0; k < removed.length; k++) {
                    var rn = removed[k];
                    if (rn.nodeType !== 1) continue;
                    if (rn.classList && rn.classList.contains('videoOsdBottom')) {
                        closePopover();
                        stopPolling();
                    }
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    function waitForApiClient(cb) {
        if (window.ApiClient && window.ApiClient.accessToken) return cb();
        var tries = 0;
        var iv = setInterval(function () {
            if (window.ApiClient && window.ApiClient.accessToken) { clearInterval(iv); cb(); }
            else if (++tries > 100) clearInterval(iv); // 10s max
        }, 100);
    }

    waitForApiClient(watchOsd);
})();
```

- [ ] **Step 2: Syntax check**

Run: `node --check web/sleep-timer.js`
Expected: no output (exit 0). Any syntax error fails the task.

- [ ] **Step 3: Commit**

```bash
git add web/sleep-timer.js
git commit -m "feat: in-player sleep timer button (vanilla JS, OSD injection)"
```

---

### Task 2: Write `scripts/install-web.sh`

**Files:**
- Create: `scripts/install-web.sh`

Idempotent installer that copies `sleep-timer.js` to rasp's `/usr/share/jellyfin/web/` and adds one `<script>` tag to `index.html`. Backs up `index.html` on first run. Safe to run repeatedly.

- [ ] **Step 1: Create the script**

```bash
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
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/install-web.sh
```

- [ ] **Step 3: Syntax check**

Run: `bash -n scripts/install-web.sh`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add scripts/install-web.sh
git commit -m "build: idempotent installer for in-player button (web static patch)"
```

---

### Task 3: Update `scripts/deploy.sh` to call install-web.sh

**Files:**
- Modify: `scripts/deploy.sh`

Append a single call at the end so `./scripts/deploy.sh` becomes a one-command "deploy plugin + button" workflow.

- [ ] **Step 1: Read current deploy.sh to find the end of the file**

Run: `tail -20 scripts/deploy.sh`
Expected: see the journalctl tail at the end of the script.

- [ ] **Step 2: Append the install-web.sh call**

Use the Edit tool to add this section at the very end of the file (after the last existing line):

```bash

echo "==> Installing in-player button..."
"$(dirname "$(readlink -f "$0")")/install-web.sh"
```

- [ ] **Step 3: Syntax check**

Run: `bash -n scripts/deploy.sh`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "build: deploy.sh also runs install-web.sh"
```

---

### Task 4: Update README.md

**Files:**
- Modify: `README.md`

Add a section about the optional in-player button after the existing "Install the bookmarklet" section.

- [ ] **Step 1: Add the new section**

Use the Edit tool. Find:

```markdown
## Install the bookmarklet

See `INSTRUCTIONS.md` for step-by-step instructions on creating the two browser bookmarklets ("Sleep Timer" and "Cancel Sleep Timer").
```

Replace with:

```markdown
## Install the bookmarklet

See `INSTRUCTIONS.md` for step-by-step instructions on creating the two browser bookmarklets ("Sleep Timer" and "Cancel Sleep Timer").

## Optional: in-player button

Run `./scripts/install-web.sh` (or `./scripts/deploy.sh`, which calls it after deploying the plugin) to add a sleep timer button (bedtime icon) directly in the Jellyfin video player OSD. The button opens a small menu (Off / 1 / 15 / 30 / 60 / 120 min) and shows a `MM:SS` countdown badge while a timer is active. Works in browser tabs and in JMP (≥ 1.11.0, which loads the web client from the server).

The installer:
- Copies `web/sleep-timer.js` to `/usr/share/jellyfin/web/`.
- Patches `/usr/share/jellyfin/web/index.html` to load the script (idempotent; backs up the original on first run as `index.html.sleep-timer-orig`).

**After `apt upgrade jellyfin-web` on rasp the patch is overwritten** — re-run `./scripts/install-web.sh` to re-apply it. The plugin itself in `/var/lib/jellyfin/plugins/` is unaffected by web client upgrades.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README section for in-player button"
```

---

### Task 5: Deploy to rasp and smoke test

**Files:**
- None modified — verification only.

- [ ] **Step 1: Run the combined deploy**

Run: `./scripts/deploy.sh`
Expected: builds plugin (already up to date), copies DLL, restarts jellyfin, then copies sleep-timer.js, patches index.html, prints "Done."

- [ ] **Step 2: Verify the file landed**

Run: `ssh rasp 'ls -la /usr/share/jellyfin/web/sleep-timer.js /usr/share/jellyfin/web/index.html.sleep-timer-orig'`
Expected: both files exist; sleep-timer.js is owned by root:root, mode 644.

- [ ] **Step 3: Verify the index.html patch is present**

Run: `ssh rasp 'grep -c "sleep-timer.js" /usr/share/jellyfin/web/index.html'`
Expected: `1` (exactly one occurrence of the script tag).

- [ ] **Step 4: Verify idempotency**

Run: `./scripts/install-web.sh`
Expected: prints "    already patched — no change" and exits 0. Then re-run `ssh rasp 'grep -c "sleep-timer.js" /usr/share/jellyfin/web/index.html'` and confirm count is still 1.

- [ ] **Step 5: Verify script loads in browser**

Manual: open a Jellyfin tab on the server (e.g. `http://rasp:8096/`), open DevTools → Network, reload, confirm `sleep-timer.js` returns 200. Open DevTools → Console, run `document.querySelector('.btnSleepTimer')` after starting playback — expect a non-null result.

- [ ] **Step 6: Verify endpoint flow**

Manual: start playback of any media. Click the bedtime icon in the player controls. Pick "1 min". A badge appears showing countdown. Wait one minute; verify playback pauses. Open DevTools console first and run `fetch(ApiClient.serverAddress()+'/SleepTimer/Status',{headers:{Authorization:\`MediaBrowser Token="${ApiClient.accessToken()}"\`}}).then(r=>r.json()).then(console.log)` before the pause to confirm `active: true` and a near-zero `remainingMs`.

- [ ] **Step 7: Verify cancel works**

Manual: start playback, click bedtime → 15 min, then click bedtime → Off. Badge should disappear. Verify `/SleepTimer/Status` returns `active: false`.

- [ ] **Step 8 (optional, user-driven): Verify in JMP**

User-facing: Jeff opens JMP on Windows, starts playback, looks for the bedtime icon in the OSD button row. Same flow as browser. If JMP < 1.11, the bundled web client is in use and the button won't appear — upgrade JMP.

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| Component 1 (sleep-timer.js) | Task 1 |
| Component 2 (patched index.html) | Task 2 (install-web.sh inserts the tag) |
| Component 3 (install-web.sh) | Task 2 |
| Component 4 (deploy.sh update) | Task 3 |
| Component 5 (README update) | Task 4 |
| Testing section | Task 5 (all manual smoke steps map) |
| Risks: OSD selector | Resolved during plan-writing — Task 1 uses the verified selector `.videoOsdBottom .buttons div[dir="ltr"]` |
| Risks: JMP version | Surfaced in Task 5 step 8 |
| Risks: CSP | Not relevant for current Jellyfin 10.11.x (no strict CSP) — not in plan, accept the risk |
| Non-goals (audio player, extend-by, themes, etc.) | Confirmed not added — YAGNI |

**Placeholder scan:** Selectors are concrete (`.videoOsdBottom`, `.buttons div[dir="ltr"]`, `.btnVideoOsdSettings`). Code blocks are full implementations, no TODOs. The only manual step is in Task 5 (browser/JMP smoke) — unavoidable for UI verification.

**Type consistency:** `BUTTON_CLASS = 'btnSleepTimer'` used consistently in `injectButton`, `updateBadge`, `onDocClick`. `endsAtMs` shared between status, set-success, and tick. `formatRemaining`/`updateBadge` operate on the same `endsAtMs - Date.now()` math. Endpoint paths match the controller (`/SleepTimer/Set?minutes=N`, `/SleepTimer/Cancel`, `/SleepTimer/Status`).
