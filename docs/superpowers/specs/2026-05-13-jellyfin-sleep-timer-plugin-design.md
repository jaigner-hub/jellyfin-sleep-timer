# Jellyfin Sleep Timer Plugin — Design

**Date:** 2026-05-13
**Target Jellyfin version:** 10.11.8 (ABI 10.11.0.0) on `rasp` (Raspberry Pi 5, apt install)
**Status:** Approved, ready for implementation plan

## Motivation

We need a sleep-timer feature for Jellyfin: pause active playback after a chosen duration. The existing community plugin (Jellysleep + JavaScript Injector + File Transformation) breaks playback on our environment — confirmed reproducible: plugins on → playback stalls (HLS bufferStalledError), plugins off → playback works, plugins on again → broken. Three install variants tested. We're building our own to avoid client-side JS injection entirely.

## Goals

- Pause the calling user's active Jellyfin playback sessions after N minutes
- N ∈ {1, 15, 30, 60, 120}
- Set / Cancel / Status via REST
- Trigger UX: a single bookmarklet the user saves in their browser
- Zero modification of the Jellyfin web client (no JS injection, no HTML rewriting)

## Non-goals (deferred)

- "End of episode" timer mode
- Fade-out or volume-ramp at expiry
- Persistence across Jellyfin restarts
- Per-session granularity (we pause *all* of the user's active sessions, by design — covers the multi-device case)
- Admin dashboard UI
- Publishing to a plugin repository

## Architecture

Pure server-side Jellyfin plugin, written in C# targeting .NET 8 and the `Jellyfin.Controller` / `Jellyfin.Model` 10.11.* NuGet packages. No client-side code other than a bookmarklet that the user pastes into a browser bookmark.

### File layout

```
jellyfin-sleep-timer/
├── src/
│   ├── Jellyfin.Plugin.SleepTimer.csproj
│   ├── Plugin.cs
│   ├── PluginConfiguration.cs
│   ├── PluginServiceRegistrator.cs
│   ├── SleepTimerService.cs
│   └── Controller/SleepTimerController.cs
├── tests/                       # empty for MVP
├── scripts/deploy.sh
├── docs/superpowers/specs/      # this design
├── bookmarklet.js
├── README.md
└── .gitignore
```

### Classes

- **`Plugin`** — `BasePlugin<PluginConfiguration>`. Boilerplate: a stable GUID generated once, `Name = "Sleep Timer"`, `Description`. Jellyfin discovers it at load time via assembly attributes.
- **`PluginConfiguration`** — empty class extending `BasePluginConfiguration`. Required by the base plugin contract; we have nothing to configure.
- **`PluginServiceRegistrator`** — implements `IPluginServiceRegistrator`. Registers `SleepTimerService` as a singleton in the DI container.
- **`SleepTimerService`** — singleton. Owns `ConcurrentDictionary<Guid userId, TimerEntry>` where `TimerEntry = (CancellationTokenSource cts, DateTime endsAtUtc)`. Methods: `SetTimer(userId, minutes)`, `CancelTimer(userId)`, `GetStatus(userId)`. Uses `Task.Delay(ms, ct)` + `await` (no `System.Threading.Timer` — simpler cancellation).
- **`SleepTimerController`** — `ControllerBase`, routed at `/SleepTimer/*`, `[Authorize]`-decorated. Three actions: `Set`, `Cancel`, `Status`. Resolves the calling user GUID from `HttpContext.User` claims (Jellyfin's auth handler populates this).

### Injected dependencies

- `ISessionManager` — to enumerate the user's active sessions and send Pause commands at expiry
- `ILogger<SleepTimerService>` — standard logging into Jellyfin's log stream

### State

In-memory only. If Jellyfin restarts, all active timers are forgotten. Acceptable tradeoff because (a) the user is presumably going to sleep, and (b) Jellyfin restarts are rare. Persistence can be added later by writing/reading the timer map to the plugin's config file.

### Concurrency

`ConcurrentDictionary` for the timer map. Per-user re-Set replaces atomically: cancel old CTS → remove from map → create new entry → start delay. No global locks; per-user contention is essentially zero.

## API

All endpoints are under `/SleepTimer/`, require Jellyfin auth (standard `MediaBrowser Token` header), and operate on the calling user.

| Method | Path | Query / Body | Response |
|---|---|---|---|
| POST | `/SleepTimer/Set` | `?minutes=N` (∈ {1,15,30,60,120}) | `200 {minutes, endsAt}` or `400` if invalid |
| POST | `/SleepTimer/Cancel` | — | `200` (idempotent) |
| GET  | `/SleepTimer/Status` | — | `200 {active:bool, endsAt?:iso8601, remainingMs?:int}` |

`endsAt` is UTC ISO-8601. `remainingMs` is computed at request time.

### Set flow

1. Bookmarklet runs in the user's Jellyfin tab → reads `ApiClient.serverAddress()` and `ApiClient.accessToken()`.
2. `POST {server}/SleepTimer/Set?minutes=60` with header `Authorization: MediaBrowser Token="<token>"`.
3. Controller's `[Authorize]` resolves the token; controller pulls user GUID from claims.
4. Controller calls `service.SetTimer(userId, minutes)`.
5. Service: if existing timer for user → cancel its CTS, remove from map. Create new CTS, compute `endsAtUtc = DateTime.UtcNow.AddMinutes(minutes)`, store entry. Fire-and-forget `_ = RunTimerAsync(userId, minutes, cts.Token)`.
6. `RunTimerAsync`: awaits `Task.Delay(TimeSpan.FromMinutes(minutes), ct)`. On normal completion → `await OnExpired(userId)`. On `OperationCanceledException` → exit silently.
7. `OnExpired`: queries `sessionManager.Sessions.Where(s => s.UserId == userId && s.NowPlayingItem != null)`. For each: `await sessionManager.SendPlaystateCommandAsync(controllingSession: null, sessionId: s.Id, command: new PlaystateRequest { Command = PlaystateCommand.Pause }, cancellationToken: default)`. Removes the entry. Logs the outcome (sessions paused count).
8. Controller returns `200 { minutes, endsAt }`.

### Cancel flow

1. `POST /SleepTimer/Cancel`.
2. Controller calls `service.CancelTimer(userId)`.
3. Service: if entry exists, cancel CTS, remove from map. If no entry, no-op.
4. The fire-and-forget `RunTimerAsync` catches the cancellation and exits without firing.
5. `200`.

### Status flow

1. `GET /SleepTimer/Status`.
2. Service looks up entry by userId.
3. If absent: `{ active: false }`.
4. If present: `{ active: true, endsAt, remainingMs: (endsAt - UtcNow).TotalMilliseconds clamped to ≥ 0 }`.

### Bookmarklet (single, prompts for duration)

```js
javascript:(()=>{
  const m = prompt('Sleep timer minutes (1/15/30/60/120):', '60');
  if (!m) return;
  fetch(ApiClient.serverAddress()+'/SleepTimer/Set?minutes='+m, {
    method:'POST',
    headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}
  }).then(r=>r.ok?r.json():Promise.reject(r.status))
    .then(j=>alert('Will pause at '+new Date(j.endsAt).toLocaleTimeString()))
    .catch(e=>alert('Failed: '+e));
})();
```

Saved as a browser bookmark on any page; clicking it on a Jellyfin page reuses the page's `ApiClient`. A second cancel bookmarklet is trivial — same shape, `/Cancel`, no prompt.

JMP doesn't expose a bookmark UI, so in JMP the user opens DevTools (`Ctrl+Shift+I`) and pastes the snippet into the console. Acceptable since the primary use is from a normal browser.

## Edge cases

- **User has no active session when timer fires** → log info, no-op, no error to the (likely-asleep) caller.
- **User started a new playback on a different device after setting the timer** → still paused; we enumerate all of that user's sessions at expiry time.
- **User Sets while a timer already exists** → replace (cancel + new). No "you already have a timer" error.
- **User Cancels with no active timer** → 200, idempotent.
- **Invalid or missing `minutes` query** (not present, or not in {1,15,30,60,120}) → `400 { error: "minutes must be one of: 1, 15, 30, 60, 120" }`.
- **Jellyfin restart with active timers** → timers lost. Documented; not fixed in MVP.

## Build & deploy

### Toolchain

.NET 8 SDK in WSL: `apt install dotnet-sdk-8.0`. Build artifacts produced in WSL, deployed to rasp via scp.

### csproj essentials

- `<TargetFramework>net8.0</TargetFramework>`
- `PackageReference Include="Jellyfin.Controller" Version="10.11.*"`
- `PackageReference Include="Jellyfin.Model" Version="10.11.*"`
- `<AssemblyVersion>1.0.0.0</AssemblyVersion>` — Jellyfin uses this as the plugin version
- No embedded `meta.json` — Jellyfin reads version/GUID from assembly attributes

### deploy.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
dotnet publish src -c Release -o out
ssh rasp 'sudo mkdir -p /var/lib/jellyfin/plugins/SleepTimer_1.0.0.0'
scp out/Jellyfin.Plugin.SleepTimer.dll rasp:/tmp/
ssh rasp 'sudo mv /tmp/Jellyfin.Plugin.SleepTimer.dll /var/lib/jellyfin/plugins/SleepTimer_1.0.0.0/ \
  && sudo chown -R jellyfin:jellyfin /var/lib/jellyfin/plugins/SleepTimer_1.0.0.0 \
  && sudo systemctl restart jellyfin \
  && sleep 5 \
  && journalctl -u jellyfin -n 30 --no-pager | grep -iE "sleeptimer|error|warn" || true'
```

One command per iteration: `./scripts/deploy.sh` — builds, deploys, restarts, prints any plugin-related log lines.

## Testing

### MVP = manual integration test

1. Save the bookmarklet as a browser bookmark.
2. Open Jellyfin in Chrome (or JMP — paste into DevTools console), start playing anything.
3. Click the bookmarklet → enter `1` → confirm the alert says "Will pause at ~now+1min".
4. Wait ~60 seconds. Playback should pause.
5. Cancel test: set a 60-min timer, immediately call the cancel bookmarklet, verify Status returns `{active:false}`.

The 1-minute preset is the integration test for nightly use; it's a real production value, not debug-only.

### Logs

`SleepTimerService` logs at Info on every `SetTimer`, `CancelTimer`, and `OnExpired` (including count of sessions paused). Watch live with:
```
ssh rasp 'sudo journalctl -u jellyfin -f' | grep -i sleeptimer
```

### Unit tests (deferred)

`tests/` directory exists in the layout but is empty for MVP. When added, the test plan is to mock `ISessionManager` and verify:
- `SetTimer` schedules a delay and calls `SendPlaystateCommandAsync(Pause)` for each of the user's active sessions after the elapsed time
- `CancelTimer` causes the pending delay to throw `OperationCanceledException` and *not* call Pause
- Re-Set replaces the existing timer (only one Pause fires, at the new time)

We'll inject a clock abstraction at that point so tests don't have to wait real wall-clock time.

## Risks

- **Jellyfin NuGet package versions**: `Jellyfin.Controller` / `Jellyfin.Model` at the exact 10.11.* range need to exist on NuGet. They should — Jellyfin publishes these — but if missing, the fallback is `<Reference Include="...">` pointing at the DLLs from the rasp install (`/usr/lib/jellyfin/bin/`).
- **First-time Jellyfin plugin API**: method signatures like `SendPlaystateCommandAsync`, claim names for userId, and the exact DI registration pattern are best-guess from training data; I expect 1-2 minor compile/runtime fixes during implementation, not architectural changes.
- **Bookmarklet auth on token expiry**: `ApiClient.accessToken()` returns the page's current session token. If the user's Jellyfin session has expired in that tab, the bookmarklet gets a 401. Recovery: refresh the page. Not common in practice.
- **CSRF**: standard Jellyfin endpoints rely on the bearer-style Authorization header, not cookies, so CSRF isn't applicable. The bookmarklet runs in the user's own browser as the user; no privilege escalation.
