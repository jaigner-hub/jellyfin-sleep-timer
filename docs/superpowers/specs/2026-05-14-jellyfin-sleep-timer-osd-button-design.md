# Jellyfin Sleep Timer — In-Player OSD Button

## Context

The `Jellyfin.Plugin.SleepTimer` plugin (shipped 2026-05-13) exposes `POST /SleepTimer/Set`, `POST /SleepTimer/Cancel`, and `GET /SleepTimer/Status`. Today the only trigger is a browser bookmarklet (or DevTools paste in JMP). This spec adds a real in-player button so the user can arm or cancel the timer without leaving the player.

The original reason this plugin exists is that the community Jellysleep plugin requires the JavaScript Injector + File Transformation plugins, and those broke HLS playback on rasp (Jellyfin 10.11.8, Raspberry Pi 5). Any UI added here must avoid that failure mode: **no server-side response middleware**.

## Goals

- Add a "💤" button to the video player OSD that arms or cancels the sleep timer.
- Work in **both** browser tabs and Jellyfin Media Player (JMP) — JMP ≥ 1.11.0 loads `jellyfin-web` from the server, so server-side static-file changes propagate to JMP automatically.
- Reuse the existing plugin endpoints unchanged.
- Degrade gracefully: if jellyfin-web's OSD markup changes in a future release, the bookmarklet and direct API access still work.

## Non-Goals

- Audio-player OSD button (video only for v1).
- "Extend by N minutes" or per-device targeting beyond what `/SleepTimer/Set` already supports.
- Custom styling, themes, or animations — inherit existing OSD button class names.
- Automatic re-application after `apt upgrade jellyfin-web` (manual re-run of install script is acceptable; documented in README).

## Architecture

Two server-side static files dropped into `/usr/share/jellyfin/web/`, plus one line added to `index.html`. No plugin code changes; no response middleware; no JS Injector / File Transformation involvement.

```
/usr/share/jellyfin/web/
├── index.html              ← patched: one <script> tag added before </body>
├── sleep-timer.js          ← new: button injection + endpoint calls
└── (everything else untouched)
```

### Component 1: `web/sleep-timer.js`

Vanilla JS, no framework. Runs on every page load in the Jellyfin web client. Approximate flow:

1. **Wait for `ApiClient`** — poll for `window.ApiClient` to exist, then proceed.
2. **Watch for video OSD** — `MutationObserver` on `document.body` watching for nodes matching the video OSD container selector (likely `.videoOsdBottom` based on jellyfin-web 10.11 conventions; verified at implementation time).
3. **Inject button** — when OSD appears, locate the bottom button row and insert a `<button class="paper-icon-button-light">` with a 💤 icon. Use existing OSD button classes so styling inherits.
4. **Popover menu on click** — on button click, render a small absolutely-positioned `<div>` listing: Off, 1 min, 15, 30, 60, 120. Click-outside or Escape dismisses.
5. **Endpoint calls** — selecting a number fires `POST /SleepTimer/Set?minutes=N` with `Authorization: MediaBrowser Token="${ApiClient.accessToken()}"`. Selecting Off fires `POST /SleepTimer/Cancel`.
6. **Active state badge** — poll `GET /SleepTimer/Status` every 30 seconds while the OSD is visible. If `active: true`, render a `MM:SS` countdown badge over the button. Badge updates locally between poll cycles using `endsAt`.
7. **Cleanup** — when the OSD is removed from the DOM, the MutationObserver records the disconnect and the script reverts to waiting state. No timers leak across navigation.

Failure modes the script must handle:
- OSD selector doesn't match (markup changed) → no button injected; log to console; bookmarklet still works.
- `ApiClient` never appears (non-Jellyfin page somehow loading this file) → script exits silently.
- Endpoint returns 401 → show inline toast "Session expired"; refresh-of-Jellyfin-tab needed.
- Endpoint returns 400 → unreachable (UI only offers valid values).

### Component 2: Patched `index.html`

One additional line before `</body>`:

```html
<script src="sleep-timer.js"></script>
```

That's it. No CSP changes (sleep-timer.js is same-origin), no `defer` or `async` (the script is self-gated on `ApiClient` existence anyway).

### Component 3: `scripts/install-web.sh`

Idempotent installer/patcher. Run from the dev machine; SSHes to rasp. Behavior:

1. Verify `sleep-timer.js` exists in the repo's `web/` directory.
2. Copy `sleep-timer.js` to `/usr/share/jellyfin/web/sleep-timer.js` on rasp (overwrites if present — that's the update path).
3. Patch `/usr/share/jellyfin/web/index.html`:
   - If a `.sleep-timer-orig` backup doesn't exist, create it (one-time, for revert).
   - If `<script src="sleep-timer.js">` is already present in index.html, skip the patch step (idempotent).
   - Otherwise, insert the script tag immediately before `</body>` using `sed`.
4. Set ownership: `chown root:root` on both files (matches package defaults).
5. No service restart needed — static files served fresh on next page load.

Failure modes:
- index.html missing → bail with a clear error.
- index.html doesn't contain `</body>` → bail; manual investigation.
- SSH/sudo failure → propagate exit code.

### Component 4: `scripts/deploy.sh` update

Existing `deploy.sh` builds the plugin DLL and copies it to `/var/lib/jellyfin/plugins/SleepTimer_1.0.0.0/`. Add a single call at the end:

```bash
"$(dirname "$0")/install-web.sh"
```

So `./scripts/deploy.sh` is now a one-command "deploy plugin + web button" workflow.

### Component 5: README update

Add a short section:

> ## Optional: In-Player Button
>
> Run `./scripts/install-web.sh` (or `./scripts/deploy.sh` which calls it) to install a sleep timer button directly in the Jellyfin video player. The button appears in the OSD next to the standard playback controls. Works in browser tabs and JMP (≥ 1.11.0).
>
> **After `apt upgrade jellyfin-web` on rasp, re-run `./scripts/install-web.sh`** to re-apply the index.html patch.

## Data Flow

```
[Click 💤 → pick 60] 
  ↓
sleep-timer.js: fetch(serverAddress + '/SleepTimer/Set?minutes=60', {Authorization: ...})
  ↓
SleepTimerController.Set(60) [existing — no change]
  ↓
SleepTimerService.SetTimer(userId, 60) [existing — no change]
  ↓ 
returns {minutes: 60, endsAt: "..."}
  ↓
sleep-timer.js: show toast "Will pause at HH:MM:SS", start badge countdown

[After 60 minutes elapse]
  ↓
SleepTimerService.OnExpiredAsync(userId) [existing — no change]
  ↓
ISessionManager.SendPlaystateCommand(..., Pause, ...) [existing — no change]
  ↓
Server pauses all active sessions for that user; JMP receives WebSocket pause command and the player pauses naturally.
```

## Testing

- **Manual smoke**: deploy via `./scripts/deploy.sh`, open Jellyfin in browser, start playback, click 💤, pick 1 min, watch for pause at endsAt. Verify same flow in JMP.
- **Idempotency**: run `./scripts/install-web.sh` twice in a row — second run should be a no-op (no duplicate `<script>` tags in index.html).
- **Graceful degradation**: temporarily rename `.videoOsdBottom` selector in the script to something invalid, redeploy, verify no errors thrown and bookmarklet still works.
- **Status polling**: arm a 5-min timer via bookmarklet, then click 💤 button — verify badge shows correct remaining time even though it wasn't this script that set it.

No automated tests for this surface — the testable units (auth, timer math, pause) live in the plugin and were verified in the prior session. The JS is thin glue.

## Risks & Open Questions

- **OSD selector**: The exact selector for the video OSD button row in jellyfin-web 10.11.x is not confirmed by reading source in this spec. Implementation will inspect the running web client (via DevTools) before finalizing the selector, and the spec's `.videoOsdBottom` is a placeholder.
- **JMP version assumption**: The user is on JMP, version unknown but presumed ≥ 1.11.0 (released June 2024; current date is May 2026). If they're on an older bundled-web version, this approach won't reach JMP without a JMP upgrade. Verify version before declaring JMP support tested.
- **CSP**: jellyfin-web does not currently ship a strict CSP. If a future Jellyfin release adds one that blocks inline same-origin scripts, the patch would need a `nonce` or different injection path.

## Out of Scope (for this spec)

- Server-side persistence of "last used duration" preference.
- Multi-user isolation in the UI (the API already isolates per user; UI doesn't expose other users' timers).
- Mobile clients (iOS/Android use different web clients entirely; this script only loads on jellyfin-web).
