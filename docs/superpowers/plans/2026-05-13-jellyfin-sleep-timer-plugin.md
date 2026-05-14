# Jellyfin Sleep Timer Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Jellyfin 10.11.x server-only plugin that pauses the calling user's active sessions after N ∈ {1,15,30,60,120} minutes, triggered by a browser bookmarklet calling three REST endpoints. No client-side JS injection.

**Architecture:** Single C# .NET 8 plugin DLL. One controller (`SleepTimerController`) exposes Set/Cancel/Status under `/SleepTimer/`. One singleton service (`SleepTimerService`) keeps an in-memory `ConcurrentDictionary<userId, TimerEntry>`, manages `Task.Delay` cancellation tokens, and calls `ISessionManager.SendPlaystateCommand(Pause)` on expiry. Bookmarklet snippet reuses the page's `ApiClient` for auth. Deploy via `scp` + `systemctl restart jellyfin`.

**Tech Stack:** .NET 8 SDK · `Jellyfin.Controller` NuGet 10.11.* · ASP.NET Core controllers · `ConcurrentDictionary` · `CancellationTokenSource` · plain JS bookmarklet · bash deploy script · SSH/SCP to `rasp` (Pi 5 running Jellyfin via apt at `/var/lib/jellyfin/plugins/`).

**Project root:** `/home/enum/projects/jellyfin-sleep-timer/` (git-initialized, spec already committed).

**Source of design:** `docs/superpowers/specs/2026-05-13-jellyfin-sleep-timer-plugin-design.md`

---

## Task 1: Install .NET 8 SDK in WSL

**Files:**
- None (system install)

- [ ] **Step 1: Check if dotnet 8 SDK is already installed**

Run: `dotnet --list-sdks`
Expected: Either lists a `8.0.x` SDK (skip to Task 2), or "command not found" / no 8.0 entry.

- [ ] **Step 2: Install via Microsoft's install script (no sudo needed)**

Run:
```bash
curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 8.0 --install-dir "$HOME/.dotnet"
rm /tmp/dotnet-install.sh
```
Expected: ends with `Note that the script does not modify your environment variables. Installation finished successfully.`

- [ ] **Step 3: Add to PATH for this session and persistently**

Run:
```bash
export PATH="$HOME/.dotnet:$PATH"
grep -q '\.dotnet' ~/.bashrc || echo 'export PATH="$HOME/.dotnet:$PATH"' >> ~/.bashrc
dotnet --list-sdks
```
Expected: `8.0.x [...]` printed.

- [ ] **Step 4: Verify the SDK builds a hello-world**

Run:
```bash
cd /tmp && rm -rf hellotest && dotnet new console -n hellotest && cd hellotest && dotnet run && cd / && rm -rf /tmp/hellotest
```
Expected: prints `Hello, World!` then cleans up.

No commit (system install, no repo changes).

---

## Task 2: Scaffold the .csproj

**Files:**
- Create: `/home/enum/projects/jellyfin-sleep-timer/src/Jellyfin.Plugin.SleepTimer.csproj`

- [ ] **Step 1: Write the csproj**

Create `/home/enum/projects/jellyfin-sleep-timer/src/Jellyfin.Plugin.SleepTimer.csproj`:
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <RootNamespace>Jellyfin.Plugin.SleepTimer</RootNamespace>
    <AssemblyName>Jellyfin.Plugin.SleepTimer</AssemblyName>
    <AssemblyVersion>1.0.0.0</AssemblyVersion>
    <FileVersion>1.0.0.0</FileVersion>
    <Version>1.0.0</Version>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <ImplicitUsings>enable</ImplicitUsings>
    <GenerateDocumentationFile>false</GenerateDocumentationFile>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Jellyfin.Controller" Version="10.11.*" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Verify the package restores**

Run: `cd /home/enum/projects/jellyfin-sleep-timer && dotnet restore src`
Expected: ends with `Restored .../Jellyfin.Plugin.SleepTimer.csproj (in ...)`. **No** errors.

**If 10.11.* is not found on NuGet**: re-run `dotnet package search Jellyfin.Controller --prerelease` to see actual published versions. If only 10.11.0-rc1 etc. exist, change Version to `10.11.0-*`. Worst case: download `Jellyfin.Controller.dll` from the running server at rasp:/usr/lib/jellyfin/bin/Jellyfin.Controller.dll, scp it locally, and replace the PackageReference with `<Reference Include="Jellyfin.Controller"><HintPath>refs/Jellyfin.Controller.dll</HintPath></Reference>`. Note this in `docs/build-notes.md` if you have to do it.

- [ ] **Step 3: Verify empty build succeeds**

Run: `cd /home/enum/projects/jellyfin-sleep-timer && dotnet build src -c Release`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`. (May warn that no source files exist; that's fine — just no errors.)

- [ ] **Step 4: Commit**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git add src/Jellyfin.Plugin.SleepTimer.csproj
git commit -m "build: scaffold csproj targeting Jellyfin.Controller 10.11.*"
```

---

## Task 3: Plugin entry + configuration classes

**Files:**
- Create: `/home/enum/projects/jellyfin-sleep-timer/src/Configuration/PluginConfiguration.cs`
- Create: `/home/enum/projects/jellyfin-sleep-timer/src/Plugin.cs`

- [ ] **Step 1: Generate a stable plugin GUID**

Run: `uuidgen`
Expected: a UUID like `e8c8a7b2-3f4d-4c9e-b1a5-7d2c9e1f8a3b`. **Save this value** — you'll paste it into `Plugin.cs` in Step 3 and use the same value forever (it's the plugin's permanent identity).

- [ ] **Step 2: Create the configuration class**

Create `/home/enum/projects/jellyfin-sleep-timer/src/Configuration/PluginConfiguration.cs`:
```csharp
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SleepTimer.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
}
```

- [ ] **Step 3: Create the Plugin entry class**

Create `/home/enum/projects/jellyfin-sleep-timer/src/Plugin.cs`. Replace `PASTE_GUID_HERE` with the UUID from Step 1:
```csharp
using System;
using Jellyfin.Plugin.SleepTimer.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SleepTimer;

public class Plugin : BasePlugin<PluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Sleep Timer";

    public override Guid Id => Guid.Parse("PASTE_GUID_HERE");

    public override string Description =>
        "Pauses your active playback sessions after a chosen duration. Triggered by a browser bookmarklet.";
}
```

- [ ] **Step 4: Verify the build succeeds**

Run: `cd /home/enum/projects/jellyfin-sleep-timer && dotnet build src -c Release`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`.

- [ ] **Step 5: Commit**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git add src/Plugin.cs src/Configuration/PluginConfiguration.cs
git commit -m "feat: add Plugin entry class with stable GUID"
```

---

## Task 4: SleepTimerService + DI registrator

**Files:**
- Create: `/home/enum/projects/jellyfin-sleep-timer/src/Services/SleepTimerService.cs`
- Create: `/home/enum/projects/jellyfin-sleep-timer/src/PluginServiceRegistrator.cs`

- [ ] **Step 1: Create the service**

Create `/home/enum/projects/jellyfin-sleep-timer/src/Services/SleepTimerService.cs`:
```csharp
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SleepTimer.Services;

public record TimerStatus(bool Active, DateTime? EndsAt, long? RemainingMs);

public class SleepTimerService
{
    private readonly ISessionManager _sessionManager;
    private readonly ILogger<SleepTimerService> _logger;
    private readonly ConcurrentDictionary<Guid, TimerEntry> _timers = new();

    public SleepTimerService(ISessionManager sessionManager, ILogger<SleepTimerService> logger)
    {
        _sessionManager = sessionManager;
        _logger = logger;
    }

    public TimerStatus SetTimer(Guid userId, int minutes)
    {
        if (_timers.TryRemove(userId, out var existing))
        {
            existing.Cts.Cancel();
            existing.Cts.Dispose();
        }

        var cts = new CancellationTokenSource();
        var endsAt = DateTime.UtcNow.AddMinutes(minutes);
        _timers[userId] = new TimerEntry(cts, endsAt);

        _logger.LogInformation(
            "SleepTimer: SetTimer userId={UserId} minutes={Minutes} endsAt={EndsAt:o}",
            userId, minutes, endsAt);

        _ = RunTimerAsync(userId, minutes, cts.Token);

        return new TimerStatus(true, endsAt, (long)Math.Max(0, (endsAt - DateTime.UtcNow).TotalMilliseconds));
    }

    public void CancelTimer(Guid userId)
    {
        if (_timers.TryRemove(userId, out var entry))
        {
            entry.Cts.Cancel();
            entry.Cts.Dispose();
            _logger.LogInformation("SleepTimer: CancelTimer userId={UserId}", userId);
        }
    }

    public TimerStatus GetStatus(Guid userId)
    {
        if (!_timers.TryGetValue(userId, out var entry))
        {
            return new TimerStatus(false, null, null);
        }
        var remainingMs = (long)Math.Max(0, (entry.EndsAt - DateTime.UtcNow).TotalMilliseconds);
        return new TimerStatus(true, entry.EndsAt, remainingMs);
    }

    private async Task RunTimerAsync(Guid userId, int minutes, CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(minutes), ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await OnExpiredAsync(userId).ConfigureAwait(false);
    }

    private async Task OnExpiredAsync(Guid userId)
    {
        _timers.TryRemove(userId, out _);

        var playingSessions = _sessionManager.Sessions
            .Where(s => s.UserId.Equals(userId) && s.NowPlayingItem != null)
            .ToList();

        _logger.LogInformation(
            "SleepTimer: OnExpired userId={UserId} sessionsToPause={Count}",
            userId, playingSessions.Count);

        foreach (var session in playingSessions)
        {
            try
            {
                await _sessionManager.SendPlaystateCommand(
                    controllingSessionId: null,
                    sessionId: session.Id,
                    command: new PlaystateRequest { Command = PlaystateCommand.Pause },
                    cancellationToken: CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "SleepTimer: failed to pause session {SessionId}", session.Id);
            }
        }
    }

    private sealed record TimerEntry(CancellationTokenSource Cts, DateTime EndsAt);
}
```

**Build-time risk:** the `SendPlaystateCommand` method name and parameter order are best-guess for Jellyfin 10.11. If the compiler complains, run `grep -r "SendPlaystateCommand" ~/.nuget/packages/jellyfin.controller/` to find the exact signature, or look at `~/.nuget/packages/jellyfin.controller/10.11.*/lib/net8.0/Jellyfin.Controller.dll` references via `dotnet --list-sdks` workflow. Adjust call sites only; the rest of the class is independent.

- [ ] **Step 2: Create the DI registrator**

Create `/home/enum/projects/jellyfin-sleep-timer/src/PluginServiceRegistrator.cs`:
```csharp
using Jellyfin.Plugin.SleepTimer.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.SleepTimer;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<SleepTimerService>();
    }
}
```

- [ ] **Step 3: Verify the build succeeds**

Run: `cd /home/enum/projects/jellyfin-sleep-timer && dotnet build src -c Release`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`.

If `SendPlaystateCommand` doesn't compile, fix the call signature per the build-time risk note above. Re-run until clean.

- [ ] **Step 4: Commit**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git add src/Services/SleepTimerService.cs src/PluginServiceRegistrator.cs
git commit -m "feat: SleepTimerService with cancellation-aware delay and Pause-on-expiry"
```

---

## Task 5: SleepTimerController

**Files:**
- Create: `/home/enum/projects/jellyfin-sleep-timer/src/Controllers/SleepTimerController.cs`

- [ ] **Step 1: Create the controller**

Create `/home/enum/projects/jellyfin-sleep-timer/src/Controllers/SleepTimerController.cs`:
```csharp
using System;
using Jellyfin.Extensions;
using Jellyfin.Plugin.SleepTimer.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.SleepTimer.Controllers;

[ApiController]
[Authorize]
[Route("SleepTimer")]
[Produces("application/json")]
public class SleepTimerController : ControllerBase
{
    private static readonly int[] AllowedMinutes = { 1, 15, 30, 60, 120 };
    private readonly SleepTimerService _service;

    public SleepTimerController(SleepTimerService service)
    {
        _service = service;
    }

    [HttpPost("Set")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult Set([FromQuery] int? minutes)
    {
        if (minutes is null || Array.IndexOf(AllowedMinutes, minutes.Value) < 0)
        {
            return BadRequest(new { error = "minutes must be one of: 1, 15, 30, 60, 120" });
        }
        var userId = User.GetUserId();
        var status = _service.SetTimer(userId, minutes.Value);
        return Ok(new { minutes = minutes.Value, endsAt = status.EndsAt });
    }

    [HttpPost("Cancel")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult Cancel()
    {
        var userId = User.GetUserId();
        _service.CancelTimer(userId);
        return Ok();
    }

    [HttpGet("Status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult Status()
    {
        var userId = User.GetUserId();
        var status = _service.GetStatus(userId);
        return Ok(new
        {
            active = status.Active,
            endsAt = status.EndsAt,
            remainingMs = status.RemainingMs
        });
    }
}
```

**Build-time risk:** `Jellyfin.Extensions.ClaimsPrincipalExtensions.GetUserId()` should be a real extension in 10.11. If `User.GetUserId()` fails to resolve, replace the calls with this fallback that reads the standard claim directly:
```csharp
private Guid GetUserId()
{
    var raw = User.FindFirst("Jellyfin-UserId")?.Value
            ?? User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
    return Guid.TryParse(raw, out var g) ? g : Guid.Empty;
}
```
and remove `using Jellyfin.Extensions;`.

- [ ] **Step 2: Verify the build succeeds**

Run: `cd /home/enum/projects/jellyfin-sleep-timer && dotnet build src -c Release`
Expected: `Build succeeded. 0 Warning(s) 0 Error(s)`.

- [ ] **Step 3: Commit**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git add src/Controllers/SleepTimerController.cs
git commit -m "feat: REST controller for Set/Cancel/Status"
```

---

## Task 6: Deploy script + first deploy

**Files:**
- Create: `/home/enum/projects/jellyfin-sleep-timer/scripts/deploy.sh`

- [ ] **Step 1: Create the deploy script**

Create `/home/enum/projects/jellyfin-sleep-timer/scripts/deploy.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

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
```

- [ ] **Step 2: Mark it executable**

Run: `chmod +x /home/enum/projects/jellyfin-sleep-timer/scripts/deploy.sh`

- [ ] **Step 3: Run first deploy**

Run: `/home/enum/projects/jellyfin-sleep-timer/scripts/deploy.sh`
Expected: ends with log lines that include `Loaded plugin: Sleep Timer 1.0.0.0`. No `[ERR]` or stack traces tied to SleepTimer.

If the deploy script prints a stack trace from the plugin (e.g., DI registration error), inspect the full log: `ssh rasp 'sudo journalctl -u jellyfin -n 200 --no-pager | grep -iE "sleeptimer|error" -A 10'`. Most likely cause is a method signature mismatch from Task 4/5 risk notes; fix and re-deploy.

- [ ] **Step 4: Commit the script**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git add scripts/deploy.sh
git commit -m "build: deploy script (publish + scp + restart + log tail)"
```

---

## Task 7: Smoke-test endpoints with curl

**Files:**
- None (verification only)

- [ ] **Step 1: Get an API token**

On rasp, you can either:

(a) Reuse the token from your logged-in browser. In Chrome on the user's machine, open Jellyfin → DevTools console → run `JSON.parse(localStorage.getItem('jellyfin_credentials')).Servers[0].AccessToken`. Copy the value.

(b) Or create a dedicated API key in the dashboard: Jellyfin Web → Dashboard → API Keys → `+` → name it `sleep-timer-test` → save → copy.

Set it as a shell variable for this session:
```bash
export JF_TOKEN='<paste-token-here>'
export JF_URL='http://100.120.183.92:8096'   # or whatever the user uses
```

- [ ] **Step 2: Call Status with no active timer**

Run:
```bash
curl -s -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" "$JF_URL/SleepTimer/Status"
```
Expected: `{"active":false,"endsAt":null,"remainingMs":null}`

- [ ] **Step 3: Call Set with invalid minutes**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" \
  "$JF_URL/SleepTimer/Set?minutes=7"
```
Expected: `400`

- [ ] **Step 4: Call Set with minutes=1**

Run:
```bash
curl -s -X POST -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" \
  "$JF_URL/SleepTimer/Set?minutes=1"
```
Expected: `{"minutes":1,"endsAt":"2026-05-13T..."}` (timestamp roughly 1 min from now, in UTC).

- [ ] **Step 5: Call Status — should be active**

Run:
```bash
curl -s -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" "$JF_URL/SleepTimer/Status"
```
Expected: `{"active":true,"endsAt":"2026-05-13T...","remainingMs":<around 50000-60000>}`

- [ ] **Step 6: Call Cancel**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" \
  "$JF_URL/SleepTimer/Cancel"
```
Expected: `200`

- [ ] **Step 7: Confirm Status is back to inactive**

Run:
```bash
curl -s -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" "$JF_URL/SleepTimer/Status"
```
Expected: `{"active":false,"endsAt":null,"remainingMs":null}`

- [ ] **Step 8: Confirm Cancel is idempotent**

Run the Cancel curl from Step 6 again.
Expected: `200` (no error, no change in state).

If any step doesn't match expected: stop, read the server log (`ssh rasp 'sudo journalctl -u jellyfin -n 100 --no-pager | grep -i sleeptimer'`), fix, re-deploy, re-test.

No commit (verification only).

---

## Task 8: Bookmarklet + README

**Files:**
- Create: `/home/enum/projects/jellyfin-sleep-timer/bookmarklet.js`
- Create: `/home/enum/projects/jellyfin-sleep-timer/README.md`

- [ ] **Step 1: Create bookmarklet.js**

Create `/home/enum/projects/jellyfin-sleep-timer/bookmarklet.js`:
```javascript
javascript:(()=>{const m=prompt('Sleep timer minutes (1/15/30/60/120):','60');if(!m)return;fetch(ApiClient.serverAddress()+'/SleepTimer/Set?minutes='+m,{method:'POST',headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(j=>alert('Will pause at '+new Date(j.endsAt).toLocaleTimeString())).catch(e=>alert('Failed: '+e));})();
```

(All one line — that's how bookmarklets must be saved into a browser bookmark URL.)

- [ ] **Step 2: Create README.md**

Create `/home/enum/projects/jellyfin-sleep-timer/README.md`:
````markdown
# Jellyfin Sleep Timer

A tiny Jellyfin 10.11+ plugin that pauses your active playback after a chosen duration. Trigger via a browser bookmarklet — no in-player UI, no JS injection.

## Why

The existing community plugin (Jellysleep) requires the JavaScript Injector + File Transformation plugins, which break HLS playback on our Jellyfin 10.11.8 + Raspberry Pi 5 setup. This plugin is purely server-side; the only client-side bit is a bookmarklet you paste into a browser bookmark.

## Build

Requires .NET 8 SDK.

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

1. In your browser, create a new bookmark (any folder).
2. Set the bookmark's **URL** to the entire contents of `bookmarklet.js` (one line starting with `javascript:`).
3. Name it whatever — "Sleep Timer" works.

To use: click the bookmark on any Jellyfin web page. It prompts for minutes (1/15/30/60/120), then sets the timer. When the timer fires, the plugin sends a Pause command to every active session you own.

For JMP (the desktop app): bookmarks aren't exposed in the UI, so open DevTools (`Ctrl+Shift+I`) → Console → paste the bookmarklet contents (without the leading `javascript:` prefix) and hit Enter.

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
````

- [ ] **Step 3: Commit**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git add bookmarklet.js README.md
git commit -m "docs: bookmarklet + README with install/build/use instructions"
```

---

## Task 9: End-to-end manual integration test

**Files:**
- None (acceptance test)

This is the test that proves the plugin actually works. Coordinate with the user — they have to play media and observe the pause.

- [ ] **Step 1: User installs the bookmarklet**

Ask the user to follow the README install steps in their Chrome browser. They should end up with a bookmark named "Sleep Timer".

- [ ] **Step 2: User starts playback in Chrome**

Have them open Jellyfin in Chrome (not incognito — we want real session conditions), pick any item, and start playing.

- [ ] **Step 3: User clicks the bookmarklet and enters `1`**

Expected: alert pops up with "Will pause at HH:MM:SS" — a time roughly 60 seconds from now in their local timezone.

- [ ] **Step 4: Observe in server log**

In parallel, run on the dev machine:
```bash
ssh rasp 'sudo journalctl -u jellyfin -f' | grep -i sleeptimer
```
Expected lines (within seconds):
- `SleepTimer: SetTimer userId=<guid> minutes=1 endsAt=<iso>`
- ~60 seconds later: `SleepTimer: OnExpired userId=<guid> sessionsToPause=1` (or more if they have multiple devices playing)

- [ ] **Step 5: User confirms playback paused**

The browser video should freeze on a frame; the playback controls should show the play icon (not pause). User reports back: "yes, paused" or "no, kept playing".

- [ ] **Step 6: Cancel test**

User starts playback again, clicks the bookmarklet, enters `60`, then immediately runs:
```bash
curl -s -X POST -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" "$JF_URL/SleepTimer/Cancel"
curl -s -H "Authorization: MediaBrowser Token=\"$JF_TOKEN\"" "$JF_URL/SleepTimer/Status"
```
Expected: Status returns `{"active":false,...}`. Playback continues. Log shows `SleepTimer: CancelTimer`.

- [ ] **Step 7: Tag the working version**

Run:
```bash
cd /home/enum/projects/jellyfin-sleep-timer
git tag -a v1.0.0 -m "First working release: 1/15/30/60/120-min pause via bookmarklet"
```

- [ ] **Step 8: Clean up the disabled-plugins folder on rasp**

Since this plugin replaces Jellysleep + JS Injector + File Transformation, remove the parked folders:
```bash
ssh rasp 'sudo rm -rf /var/lib/jellyfin/plugins.disabled-2026-05-13'
```
Verify the active plugins list is clean:
```bash
ssh rasp 'ls /var/lib/jellyfin/plugins/'
```
Expected: `SleepTimer_1.0.0.0  configurations`.

No commit (no repo changes after the tag).

---

## Done

After Task 9, the user has a working Jellyfin sleep timer:
- Server plugin installed and auto-loaded
- Bookmarklet in their browser
- Three REST endpoints verified by curl
- Live integration test passed
- v1.0.0 tag in the repo
- Old broken plugins cleaned up

Future improvements (not in this plan, deferred per spec non-goals):
- "End of episode" mode (needs playback-progress listener)
- Persistence across Jellyfin restarts (serialize map to config file on change)
- Status page served by the plugin (`/Plugin/SleepTimer/UI`) showing remaining time
- Unit tests with a mockable `IClock` so timing isn't real-wall-clock
