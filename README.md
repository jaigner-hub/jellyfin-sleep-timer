# Jellyfin Sleep Timer

A tiny Jellyfin 10.11+ plugin that pauses your active playback after a chosen duration. Trigger it from an in-player OSD button (recommended in browsers, installed as a userscript or as a server-side static-file patch) or from a browser bookmarklet (works everywhere including JMP via DevTools).

## Why

The existing community plugin (Jellysleep) requires the JavaScript Injector + File Transformation plugins, which break HLS playback on our Jellyfin 10.11.8 + Raspberry Pi 5 setup. This plugin avoids them entirely: the timer logic is a regular Jellyfin plugin controller, and the optional in-player button ships as either a Tampermonkey/Violentmonkey userscript (no server-side changes) or a static JS file dropped into the web client's directory — no response middleware on the request path, so HLS streams are never touched.

## Build

Requires .NET 9 SDK (Jellyfin 10.11.x ships on net9.0).

```bash
dotnet publish src -c Release -o out
```

Output: `out/Jellyfin.Plugin.SleepTimer.dll`.

## Deploy

`scripts/deploy.sh` builds, scp's to the configured Jellyfin host (`rasp`), and restarts the service. Edit the host name if yours differs.

```bash
./scripts/deploy.sh
```

It expects:
- An `ssh rasp` config that connects to the Jellyfin host as a user with passwordless sudo.
- The Jellyfin server data dir at `/var/lib/jellyfin/plugins/`.

## In-player button (recommended)

Adds a sleep timer button (bedtime icon) directly in the Jellyfin video player OSD. The button opens a small menu (Off / 1 / 15 / 30 / 60 / 120 min) and shows a `MM:SS` countdown badge while a timer is active.

**Status:** works in browser tabs. JMP currently does **not** show the button despite loading the web client from the server (cause not yet diagnosed). Use the bookmarklet for JMP in the meantime.

Two install options:

### Option A: Userscript (no server changes)

Recommended if you mainly use Jellyfin in a browser and would rather not touch the server's web directory.

**👉 [Install sleep-timer.user.js](https://raw.githubusercontent.com/jaigner-hub/jellyfin-sleep-timer/main/sleep-timer.user.js)**

With a userscript manager installed, clicking that link opens the install prompt directly.

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) or [Violentmonkey](https://violentmonkey.github.io/) first.
2. Click the install link above.
3. Your userscript manager prompts to install — accept.
4. Reload your Jellyfin tab; the bedtime icon appears in the video OSD.

The script's `@match *://*/web/*` makes it run on any Jellyfin web client URL. Updates are pulled from the same raw URL automatically by Tampermonkey/Violentmonkey.

### Option B: Server-side static-file patch (alternative)

Patches the server's `/usr/share/jellyfin/web/index.html` to load the script for every client (including headless/non-browser clients that load the server's web bundle). Requires SSH access to the Jellyfin host.

```bash
./scripts/install-web.sh
```

(`./scripts/deploy.sh` also calls this after deploying the plugin.)

The installer:
- Copies `web/sleep-timer.js` to `/usr/share/jellyfin/web/`.
- Patches `/usr/share/jellyfin/web/index.html` to load the script (idempotent; backs up the original on first run as `index.html.sleep-timer-orig`).

**After `apt upgrade jellyfin-web` on rasp the patch is overwritten** — re-run `./scripts/install-web.sh` to re-apply it. The plugin itself in `/var/lib/jellyfin/plugins/` is unaffected by web client upgrades.

## Bookmarklet (fallback)

`INSTRUCTIONS.md` documents two browser bookmarklets ("Sleep Timer" and "Cancel Sleep Timer") that call the same endpoints from a Jellyfin tab. Useful for:

- JMP (no userscript engine, OSD button doesn't render — paste the bookmarklet into DevTools to trigger a timer).
- Any browser where you can't or don't want to install Tampermonkey.
- Fallback if a future `jellyfin-web` update breaks the in-player button.

## API

All require `Authorization: MediaBrowser Token="<token>"`.

| Method | Path | Query | Returns |
|---|---|---|---|
| POST | `/SleepTimer/Set` | `minutes=N` (∈ {1,15,30,60,120}) | `{minutes, endsAt}` |
| POST | `/SleepTimer/Cancel` | — | `200` (idempotent) |
| GET  | `/SleepTimer/Status` | — | `{active, endsAt?, remainingMs?}` |

## Behavior

- Pauses **all** of your active playing sessions on expiry (multi-device safe).
- Setting a new timer while one is active **replaces** it; no "already running" error.
- Timers are **in-memory only**. Jellyfin restart wipes them. (You're presumably about to sleep — acceptable.)
- 1-min preset is real, not debug-only — handy for testing and short naps.

## Design

- Plugin: `docs/superpowers/specs/2026-05-13-jellyfin-sleep-timer-plugin-design.md`
- In-player button: `docs/superpowers/specs/2026-05-14-jellyfin-sleep-timer-osd-button-design.md`
