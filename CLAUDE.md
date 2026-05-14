# Jellyfin Sleep Timer

Server-side Jellyfin 10.11+ plugin that pauses your active playback sessions after N ∈ {1, 15, 30, 60, 120} minutes. Built specifically to avoid the JavaScript Injector + File Transformation plugin chain — those break HLS on the target deployment by mangling response bodies (including HLS playlists).

## Deployment target

- Host: `rasp` (SSH alias, sudo NOPASSWD; resolves to 10.0.0.154 on LAN). Pi 5 + Jellyfin 10.11.8 via apt.
- Plugin dir: `/var/lib/jellyfin/plugins/SleepTimer_1.0.0.0/`
- Web dir: `/usr/share/jellyfin/web/`
- Backup of original index.html: `/usr/share/jellyfin/web/index.html.sleep-timer-orig`
- Client: JMP on Windows. JMP ≥ 1.11.0 loads jellyfin-web from the server.

## Build & deploy

`.NET 9 SDK` is at `~/.dotnet/dotnet` (not on default PATH). `deploy.sh` prepends `~/.dotnet` to PATH so it works in non-interactive shells.

```bash
./scripts/deploy.sh          # plugin DLL + button (full deploy)
./scripts/install-web.sh     # button only (re-run after apt upgrade jellyfin-web)
```

`deploy.sh` builds with `dotnet publish src -c Release -o out`, scp's the DLL to `rasp:/var/lib/jellyfin/plugins/SleepTimer_1.0.0.0/`, restarts the jellyfin service, then calls `install-web.sh`.

`install-web.sh` is idempotent — running it twice is a no-op for `index.html`; the JS file is overwritten on each run (which is the update path).

## Layout

- `src/` — C# plugin (.NET 9, `Jellyfin.Controller 10.11.*` PackageReference)
  - `Plugin.cs` — `BasePlugin<PluginConfiguration>` entry; stable GUID `25eb5d6f-c155-4c2c-8f71-5baeb18f7bde`
  - `Configuration/PluginConfiguration.cs` — empty marker class
  - `Controllers/SleepTimerController.cs` — `/SleepTimer/{Set,Cancel,Status}` endpoints
  - `Services/SleepTimerService.cs` — `ConcurrentDictionary<Guid, TimerEntry>` + cancellable `Task.Delay`
  - `PluginServiceRegistrator.cs` — DI registration
- `web/sleep-timer.js` — vanilla JS, dropped into `/usr/share/jellyfin/web/`. MutationObserver watches for `.videoOsdBottom`; injects a `bedtime`-icon button into `.buttons div[dir="ltr"]`.
- `scripts/{deploy.sh,install-web.sh}` — deployment automation.
- `bookmarklet*.js` + `INSTRUCTIONS.md` — fallback browser-bookmark UX.
- `docs/superpowers/specs/` — design specs (plugin + OSD button).
- `docs/superpowers/plans/` — implementation plans.

## Hard constraints

- **No JS Injector / File Transformation plugin dependency.** Those break HLS. This is the existence reason for this project.
- The in-player button is a **static file edit** of `/usr/share/jellyfin/web/index.html` (adds `<script src="sleep-timer.js"></script>` before `</body>`) plus a JS file dropped into the same directory. **Not** a response-middleware injection.
- Authentication everywhere uses `Authorization: MediaBrowser Token="${ApiClient.accessToken()}"`. The JS reuses the page's `ApiClient` — no separate login.
- User identification: in the controller, `User.FindFirst("Jellyfin-UserId")?.Value` falls back to `ClaimTypes.NameIdentifier`. `Jellyfin.Extensions.GetUserId()` does **not** exist in 10.11.8.
- Timers are in-memory only — Jellyfin restart wipes them by design.

## Endpoints

All require `Authorization: MediaBrowser Token="..."`.

| Method | Path | Query | Returns |
|---|---|---|---|
| POST | `/SleepTimer/Set` | `minutes=N` ∈ {1,15,30,60,120} | `{minutes, endsAt}` |
| POST | `/SleepTimer/Cancel` | — | `200` (idempotent) |
| GET  | `/SleepTimer/Status` | — | `{active, endsAt?, remainingMs?}` (null fields omitted by default JSON serializer) |

## Smoke test (no playback needed)

In a Jellyfin DevTools console:

```js
fetch(ApiClient.serverAddress()+'/SleepTimer/Status', {
    headers: { Authorization: `MediaBrowser Token="${ApiClient.accessToken()}"` }
}).then(r => r.json()).then(console.log)
```

Expected: `{active: false}` or `{active: true, endsAt: "...", remainingMs: ...}`. A 404 means the plugin isn't loaded — check `sudo journalctl -u jellyfin -f | grep -i sleeptimer` on rasp.

## Known issues

- **JMP does not currently render the in-player button.** Browsers work. JMP ≥ 1.11.0 should load jellyfin-web from the server, so the file IS reachable, but the button doesn't appear in the OSD. Cause not yet diagnosed. The bookmarklet (or DevTools console paste) is the JMP workaround.

## Conventions

- Conventional Commits prefixes: `feat:`, `build:`, `docs:`, `fix:`.
- No automated tests. Verification is manual smoke testing on rasp; build-level checks are `node --check` for JS and `bash -n` for shell.
- For non-trivial changes, use the brainstorming → writing-plans → execution flow. Specs in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, plans in `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`.
- Git remote `origin` is `https://github.com/jaigner-hub/jellyfin-sleep-timer.git` (default branch `main`).
