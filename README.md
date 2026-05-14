# Jellyfin Sleep Timer

A tiny Jellyfin 10.11+ plugin that pauses your active playback after a chosen duration. Trigger via a browser bookmarklet — no in-player UI, no JS injection.

## Why

The existing community plugin (Jellysleep) requires the JavaScript Injector + File Transformation plugins, which break HLS playback on our Jellyfin 10.11.8 + Raspberry Pi 5 setup. This plugin is purely server-side; the only client-side bit is a bookmarklet you paste into a browser bookmark.

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

## Install the bookmarklet

See `INSTRUCTIONS.md` for step-by-step instructions on creating the two browser bookmarklets ("Sleep Timer" and "Cancel Sleep Timer").

## Optional: in-player button

Run `./scripts/install-web.sh` (or `./scripts/deploy.sh`, which calls it after deploying the plugin) to add a sleep timer button (bedtime icon) directly in the Jellyfin video player OSD. The button opens a small menu (Off / 1 / 15 / 30 / 60 / 120 min) and shows a `MM:SS` countdown badge while a timer is active. Works in browser tabs and in JMP (≥ 1.11.0, which loads the web client from the server).

The installer:
- Copies `web/sleep-timer.js` to `/usr/share/jellyfin/web/`.
- Patches `/usr/share/jellyfin/web/index.html` to load the script (idempotent; backs up the original on first run as `index.html.sleep-timer-orig`).

**After `apt upgrade jellyfin-web` on rasp the patch is overwritten** — re-run `./scripts/install-web.sh` to re-apply it. The plugin itself in `/var/lib/jellyfin/plugins/` is unaffected by web client upgrades.

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

See `docs/superpowers/specs/2026-05-13-jellyfin-sleep-timer-plugin-design.md`.
