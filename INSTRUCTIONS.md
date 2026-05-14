# Bookmarklet Setup — Jellyfin Sleep Timer

You'll install two bookmarklets in your browser:

- **Sleep Timer** — prompts you for minutes (1/15/30/60/120), then arms a pause-at-expiry timer.
- **Cancel Sleep Timer** — kills any active timer (no prompt).

A "bookmarklet" is just a browser bookmark whose URL is JavaScript instead of `http://...`. The bookmarklet runs in the context of whatever page is open, so when you click it on a Jellyfin tab it has access to the same `ApiClient` (and therefore your login token) the page uses.

---

## Chrome / Edge / Brave / Firefox (regular browsers)

### 1. Make the bookmarks bar visible

- Chrome / Edge / Brave: `Ctrl+Shift+B` (Win/Linux) or `Cmd+Shift+B` (macOS) to toggle it.
- Firefox: `Ctrl+Shift+B` likewise.

### 2. Add the "Sleep Timer" bookmark

1. Right-click the bookmarks bar → **Add page…** (Chrome family) or **New Bookmark…** (Firefox).
2. **Name:** `Sleep Timer`
3. **URL:** paste the *entire* one-line contents of `bookmarklet.js`:

   ```
   javascript:(()=>{const m=prompt('Sleep timer minutes (1/15/30/60/120):','60');if(!m)return;fetch(ApiClient.serverAddress()+'/SleepTimer/Set?minutes='+m,{method:'POST',headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(j=>alert('Will pause at '+new Date(j.endsAt).toLocaleTimeString())).catch(e=>alert('Failed: '+e));})();
   ```

   It must start with `javascript:` and be on a single line. Most browsers strip the `javascript:` prefix as a paste-time anti-XSS measure — if yours does, type the `javascript:` part by hand after pasting the rest.

4. Save.

### 3. Add the "Cancel Sleep Timer" bookmark

Same as above but:

- **Name:** `Cancel Sleep Timer`
- **URL:** paste the contents of `bookmarklet-cancel.js`:

   ```
   javascript:(()=>{fetch(ApiClient.serverAddress()+'/SleepTimer/Cancel',{method:'POST',headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}}).then(r=>r.ok?alert('Sleep timer canceled.'):alert('Cancel failed: '+r.status)).catch(e=>alert('Failed: '+e));})();
   ```

### 4. Use it

1. Open Jellyfin in a tab and log in.
2. Start playback of anything.
3. Click the **Sleep Timer** bookmark in the bookmarks bar.
4. Enter a number from the prompt (`1`, `15`, `30`, `60`, or `120`) and hit OK.
5. A confirmation alert tells you the wall-clock time the pause will fire ("Will pause at HH:MM:SS").
6. When the timer expires, the server pauses your playback — on *every* device where you're playing — without touching the page.

To kill the timer early: click the **Cancel Sleep Timer** bookmark. (Or click the Sleep Timer one again and set a new duration — that replaces the old timer.)

---

## Jellyfin Media Player (JMP) — the desktop app

JMP doesn't expose a bookmarks UI, but it does expose DevTools, which is enough.

1. In JMP, open the page where you'd normally start playback.
2. Press `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Opt+I` (macOS) to open DevTools.
3. Click the **Console** tab.
4. Paste the bookmarklet body — *without* the leading `javascript:` prefix:

   ```js
   (()=>{const m=prompt('Sleep timer minutes (1/15/30/60/120):','60');if(!m)return;fetch(ApiClient.serverAddress()+'/SleepTimer/Set?minutes='+m,{method:'POST',headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(j=>alert('Will pause at '+new Date(j.endsAt).toLocaleTimeString())).catch(e=>alert('Failed: '+e));})();
   ```

5. Press Enter. A prompt appears for the duration.
6. To cancel, paste this and hit Enter:

   ```js
   (()=>{fetch(ApiClient.serverAddress()+'/SleepTimer/Cancel',{method:'POST',headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}}).then(r=>r.ok?alert('Sleep timer canceled.'):alert('Cancel failed: '+r.status)).catch(e=>alert('Failed: '+e));})();
   ```

JMP keeps the console open across page navigations until you close DevTools, so you can re-arm/cancel with the up-arrow in the console without retyping.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Alert "Failed: 401" | Browser session token expired | Refresh the Jellyfin tab and click the bookmarklet again. |
| Alert "Failed: 400" | You entered a value other than 1/15/30/60/120 | Re-click the bookmarklet, enter a valid preset. |
| Nothing happens, no alert | You clicked the bookmarklet on a non-Jellyfin tab | Make sure the active tab is a Jellyfin page (URL contains your Jellyfin host). |
| `ApiClient is not defined` in JMP console | DevTools opened on the login splash before any page rendered | Wait until your Jellyfin home is fully loaded, then retry. |
| Pause doesn't happen when timer fires | You weren't actively playing media on any device | The plugin only pauses sessions with `NowPlayingItem != null`. Start playback before the timer fires. |

---

## Verifying it's installed

A quick way to confirm the plugin is alive without playing media:

1. Open DevTools console on a Jellyfin tab.
2. Run:

   ```js
   fetch(ApiClient.serverAddress()+'/SleepTimer/Status',{headers:{Authorization:`MediaBrowser Token="${ApiClient.accessToken()}"`}}).then(r=>r.json()).then(console.log)
   ```

3. Expect `{active: false}` (or `{active: true, endsAt: "...", remainingMs: ...}` if you already have a timer).

If you get a 404, the plugin isn't loaded — check the Jellyfin server log on `rasp` (`sudo journalctl -u jellyfin -f | grep -i sleeptimer`).
