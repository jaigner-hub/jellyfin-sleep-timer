# Jellyfin Sleep Timer

A tiny Jellyfin 10.11+ plugin that pauses your active playback after a chosen duration. Two triggers: an in-player OSD button (recommended; browser tabs only — JMP support not currently working) and a browser bookmarklet (alternative; works everywhere including JMP via DevTools).

## Why

The existing community plugin (Jellysleep) requires the JavaScript Injector + File Transformation plugins, which break HLS playback on our Jellyfin 10.11.8 + Raspberry Pi 5 setup. This plugin avoids them entirely: the timer logic is server-side, and the optional in-player button is a static JS file dropped into the web client's directory — no response middleware on the request path, so HLS streams are never touched.

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

Run `./scripts/install-web.sh` (or `./scripts/deploy.sh`, which calls it after deploying the plugin) to add a sleep timer button (bedtime icon) directly in the Jellyfin video player OSD. The button opens a small menu (Off / 1 / 15 / 30 / 60 / 120 min) and shows a `MM:SS` countdown badge while a timer is active.

**Status:** works in browser tabs. JMP currently does **not** show the button despite loading the web client from the server (cause not yet diagnosed). Use the bookmarklet for JMP in the meantime.

The installer:
- Copies `web/sleep-timer.js` to `/usr/share/jellyfin/web/`.
- Patches `/usr/share/jellyfin/web/index.html` to load the script (idempotent; backs up the original on first run as `index.html.sleep-timer-orig`).

**After `apt upgrade jellyfin-web` on rasp the patch is overwritten** — re-run `./scripts/install-web.sh` to re-apply it. The plugin itself in `/var/lib/jellyfin/plugins/` is unaffected by web client upgrades.

## Bookmarklet (alternative)

If you'd rather not patch the server's web directory, see `INSTRUCTIONS.md` for browser bookmarklets ("Sleep Timer" and "Cancel Sleep Timer") that call the same endpoints from a Jellyfin tab. Useful as a fallback if the in-player button stops working after a future jellyfin-web update.

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
