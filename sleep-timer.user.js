// ==UserScript==
// @name         Jellyfin Sleep Timer
// @namespace    https://github.com/jaigner-hub/jellyfin-sleep-timer
// @version      1.0.0
// @description  Adds a sleep timer button to the Jellyfin video player OSD
// @author       jaigner-hub
// @match        *://*/web/*
// @grant        none
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/jaigner-hub/jellyfin-sleep-timer/main/sleep-timer.user.js
// @updateURL    https://raw.githubusercontent.com/jaigner-hub/jellyfin-sleep-timer/main/sleep-timer.user.js
// ==/UserScript==

// Calls the Jellyfin.Plugin.SleepTimer endpoints (/SleepTimer/Set, /Cancel, /Status)
// using the page's existing ApiClient session. Requires the server-side plugin
// to be installed — see https://github.com/jaigner-hub/jellyfin-sleep-timer

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
                badge.style.cssText = 'position:absolute;bottom:-6px;right:-6px;background:#00a4dc;color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:8px;line-height:1;pointer-events:none;z-index:10;white-space:nowrap;';
                btn.style.position = 'relative';
                btn.style.overflow = 'visible';
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
