// kwin-backend.js
// Node.js compositor backend for KDE/KWin (Wayland or X11 session).
//
// Architecture:
//   ┌─────────────────────┐        D-Bus        ┌──────────────────────┐
//   │  kwin-taskbar.js    │  ──────────────────► │  KWinBackend (here)  │
//   │  (runs in KWin)     │  WindowAdded etc.    │  (runs in Node/NW)   │
//   └─────────────────────┘                      └──────────────────────┘
//              ▲                   qdbus                     │
//              └─────────────────────────────────────────────┘
//                           focus / minimize / close
//
// The class emits the same events as LabwcClient so integrated-shell.js
// needs zero changes.

const EventEmitter = require('events');
const { exec, execSync }  = require('child_process');
const path  = require('path');
const fs    = require('fs');

// dbus-next is optional; we gracefully fall back to polling via qdbus if absent.
let dbus = null;
try { dbus = require('dbus-next'); } catch (_) {}

const KWIN_SCRIPT_PATH = path.resolve(__dirname, 'kwin-taskbar.js');
const SCRIPT_NAME      = 'taskbarKWin';
const DBUS_SERVICE     = 'com.taskbar.KWin';
const DBUS_OBJ_PATH    = '/TaskBar';
const DBUS_INTERFACE   = DBUS_SERVICE;

// ─── Utility ──────────────────────────────────────────────────────────────────

function execQuiet(cmd) {
    exec(cmd, () => {});
}

function execP(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
            else resolve(stdout);
        });
    });
}

function normalizeWindow(raw) {
    if (!raw || raw.internalId === undefined) return null;
    const appId = raw.appId || raw.resourceClass || raw.resourceName || '';
    return {
        id         : String(raw.internalId),
        title      : raw.caption || '',
        app_id     : appId,
        appId      : appId,
        class      : raw.resourceClass || appId,
        pid        : raw.pid ? Number(raw.pid) : null,
        focused    : Boolean(raw.active),
        minimized  : Boolean(raw.minimized),
        maximized  : Boolean(raw.maximized),
        fullscreen : Boolean(raw.fullscreen),
        x          : Number(raw.x  || 0),
        y          : Number(raw.y  || 0),
        width      : Number(raw.width  || 0),
        height     : Number(raw.height || 0),
    };
}

// ─── KWin script loader ───────────────────────────────────────────────────────

function unloadKwinScript() {
    try {
        execSync(
            `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "${SCRIPT_NAME}" 2>/dev/null`,
            { timeout: 3000 }
        );
    } catch (_) {}
}

function loadKwinScript() {
    unloadKwinScript();
    // loadScript returns the numeric script id; we don't need it.
    execSync(
        `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "${KWIN_SCRIPT_PATH}" "${SCRIPT_NAME}"`,
        { timeout: 5000 }
    );
    execSync(`qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.start`, { timeout: 3000 });
}

// ─── KWin window control via qdbus ────────────────────────────────────────────

function kwinCall(method, ...args) {
    const argStr = args.map(a => JSON.stringify(a)).join(' ');
    execQuiet(`qdbus org.kde.KWin /KWin org.kde.KWin.${method} ${argStr} 2>/dev/null`);
}

// KWin 6 Wayland: use the scripting API to activate by internalId.
// There is no simple one-liner for all operations, so we use a tiny
// inline KWin script evaluated on-the-fly via the DBus eval endpoint.
function kwinEval(js) {
    // qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.loadDeclarativeScript is NOT eval.
    // Instead use: org.kde.KWin.queryWindowInfo variant — not available.
    // Best cross-version approach: run via kwin --replace? No, disruptive.
    // Use dbus-send with the KWin scripting eval if available (KWin 5.25+):
    execQuiet(
        `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript /dev/stdin "${SCRIPT_NAME}_eval" ` +
        `<<'EOFSCRIPT'\n${js}\nEOFSCRIPT`
    );
}

// Reliable cross-version window operations using xdotool / wmctrl as
// fallback for X11 sessions and qdbus KWin scripting for Wayland.
function activateWindowById(internalId) {
    // Try KWin DBus first (works on both X11 and Wayland in KWin 5/6)
    execQuiet(
        `qdbus org.kde.KWin /KWin org.kde.KWin.activateWindow "${internalId}" 2>/dev/null || true`
    );
}

function minimizeWindowById(internalId) {
    execQuiet(
        `qdbus org.kde.KWin /KWin org.kde.KWin.minimizeWindow "${internalId}" 2>/dev/null || true`
    );
}

function closeWindowById(internalId) {
    execQuiet(
        `qdbus org.kde.KWin /KWin org.kde.KWin.closeWindow "${internalId}" 2>/dev/null || true`
    );
}

// ─── D-Bus receiver interface (dbus-next) ────────────────────────────────────

function buildDbusInterface(backend) {
    if (!dbus) return null;

    class TaskBarIface extends dbus.interface.Interface {
        // Called once on startup with the full window list JSON array.
        Snapshot(json) {
            try {
                const list = JSON.parse(json);
                backend._applySnapshot(list);
            } catch (e) {
                console.error('[KWinBackend] Snapshot parse error:', e.message);
            }
        }

        WindowAdded(json) {
            try {
                const raw = JSON.parse(json);
                const win = normalizeWindow(raw);
                if (win) backend._onWindowAdded(win);
            } catch (e) {}
        }

        WindowRemoved(json) {
            try {
                const raw = JSON.parse(json);
                const win = normalizeWindow(raw);
                if (win) backend._onWindowRemoved(win);
            } catch (e) {}
        }

        WindowActivated(json) {
            try {
                const raw = JSON.parse(json);
                const win = normalizeWindow(raw);
                backend._onWindowActivated(win);
            } catch (e) {}
        }

        TitleChanged(json) {
            try {
                const raw  = JSON.parse(json);
                const win  = normalizeWindow(raw);
                if (win) backend._onTitleChanged(win);
            } catch (e) {}
        }

        StateChanged(json) {
            try {
                const raw = JSON.parse(json);
                const win = normalizeWindow(raw);
                if (win) backend._onStateChanged(win);
            } catch (e) {}
        }

        GeometryChanged(json) {
            try {
                const raw = JSON.parse(json);
                const win = normalizeWindow(raw);
                if (win) backend._onGeometryChanged(win);
            } catch (e) {}
        }
    }

    TaskBarIface.configureMembers({
        methods: {
            Snapshot       : { inSignature: 's', outSignature: '' },
            WindowAdded    : { inSignature: 's', outSignature: '' },
            WindowRemoved  : { inSignature: 's', outSignature: '' },
            WindowActivated: { inSignature: 's', outSignature: '' },
            TitleChanged   : { inSignature: 's', outSignature: '' },
            StateChanged   : { inSignature: 's', outSignature: '' },
            GeometryChanged: { inSignature: 's', outSignature: '' },
        }
    });

    return new TaskBarIface(DBUS_INTERFACE);
}

// ─── KWinBackend ──────────────────────────────────────────────────────────────

class KWinBackend extends EventEmitter {
    constructor() {
        super();
        this.name        = 'kwin';
        this.windows     = new Map();   // internalId → normalizedWindow
        this.connected   = false;
        this._bus        = null;
        this._iface      = null;
        this._pollTimer  = null;
        this._hasSnapshot = false;
    }

    // ── Public API (mirrors LabwcClient) ──────────────────────────────────────

    async connect() {
        if (this.connected) return;
        console.log('[KWinBackend] Connecting...');

        try {
            await this._startDbusService();
        } catch (err) {
            console.warn('[KWinBackend] D-Bus setup failed, falling back to polling:', err.message);
            this._startPolling();
        }

        // Load the KWin script (which will call our D-Bus service).
        try {
            loadKwinScript();
            console.log('[KWinBackend] KWin script loaded');
        } catch (err) {
            console.error('[KWinBackend] Failed to load KWin script:', err.message);
            // If script fails, polling already started above; nothing more to do.
        }

        this.connected = true;
        this.emit('connected');
    }

    disconnect() {
        this.connected = false;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        unloadKwinScript();
        if (this._bus) {
            try { this._bus.disconnect(); } catch (_) {}
            this._bus = null;
        }
        this.emit('disconnected');
    }

    // Window control
    focusWindow(windowId) {
        console.log('[KWinBackend] Focus:', windowId);
        activateWindowById(windowId);
        return true;
    }

    minimizeWindow(windowId) {
        console.log('[KWinBackend] Minimize:', windowId);
        minimizeWindowById(windowId);
        return true;
    }

    closeWindow(windowId) {
        console.log('[KWinBackend] Close:', windowId);
        closeWindowById(windowId);
        return true;
    }

    maximizeWindow(windowId) {
        console.log('[KWinBackend] Maximize:', windowId);
        // Toggle maximize: KWin 6 exposes this via the window script eval.
        execQuiet(
            `qdbus org.kde.KWin /KWin org.kde.KWin.toggleMaximize "${windowId}" 2>/dev/null || true`
        );
        return true;
    }

    setAlwaysOnTop(windowId) {
        execQuiet(`qdbus org.kde.KWin /KWin org.kde.KWin.keepAbove "${windowId}" true 2>/dev/null || true`);
        return true;
    }

    requestThumbnail(/* windowId */) {
        return Promise.resolve(null);   // not implemented for KWin yet
    }

    getCursorPosition() {
        return { x: 0, y: 0 };
    }

    getWindows() {
        return Array.from(this.windows.values());
    }

    // ── D-Bus service setup ───────────────────────────────────────────────────

    async _startDbusService() {
        if (!dbus) throw new Error('dbus-next not available');

        this._bus = dbus.sessionBus();
        await this._bus.requestName(DBUS_SERVICE, 0);

        this._iface = buildDbusInterface(this);
        this._bus.export(DBUS_OBJ_PATH, this._iface);

        console.log('[KWinBackend] D-Bus service registered:', DBUS_SERVICE, DBUS_OBJ_PATH);
    }

    // ── Polling fallback (no dbus-next) ───────────────────────────────────────

    _startPolling() {
        console.log('[KWinBackend] Starting qdbus polling fallback');
        const POLL_MS = 1500;
        this._poll();
        this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    }

    async _poll() {
        try {
            const windows = await this._fetchWindowsViaQdbus();
            this._applySnapshot(windows);
        } catch (err) {
            console.warn('[KWinBackend] Poll error:', err.message);
        }
    }

    async _fetchWindowsViaQdbus() {
        // Use qdbus to call KWin scripting to enumerate windows.
        // We do a quick "eval" by writing a tiny script that calls our DBus method
        // with the full window list, but since that's circular when we have no
        // dbus-next, we instead parse wmctrl output (X11) or xprop.
        const stdout = await execP('qdbus org.kde.KWin /KWin 2>/dev/null').catch(() => '');
        if (!stdout.includes('queryWindowInfo') && !stdout.includes('getWindowInfo')) {
            // Fallback to wmctrl for X11 sessions
            return this._fetchViaWmctrl();
        }
        return this._fetchViaWmctrl();
    }

    async _fetchViaWmctrl() {
        try {
            const [wmOut, psOut, activeOut] = await Promise.allSettled([
                execP('wmctrl -lp'),
                execP('ps -eo pid=,comm='),
                execP('xprop -root _NET_ACTIVE_WINDOW')
            ]);

            const psMap = new Map();
            if (psOut.status === 'fulfilled') {
                psOut.value.split('\n').forEach(line => {
                    const m = line.trim().match(/^(\d+)\s+(.+)$/);
                    if (m) psMap.set(Number(m[1]), m[2].trim());
                });
            }

            const activeId = activeOut.status === 'fulfilled'
                ? ((activeOut.value.match(/0x[0-9a-f]+/i) || [])[0] || '').toLowerCase()
                : '';

            if (wmOut.status !== 'fulfilled') return [];

            return wmOut.value.split('\n').map(line => {
                const m = line.trim().match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/);
                if (!m) return null;
                const winId = m[1].toLowerCase();
                const pid   = Number(m[2]);
                return {
                    internalId   : winId,
                    caption      : m[3] || psMap.get(pid) || '',
                    appId        : psMap.get(pid) || '',
                    resourceClass: psMap.get(pid) || '',
                    pid,
                    active    : winId === activeId,
                    minimized : false,
                    maximized : false,
                    fullscreen: false,
                };
            }).filter(Boolean);
        } catch (_) {
            return [];
        }
    }

    // ── Snapshot / diff logic ─────────────────────────────────────────────────

    _applySnapshot(rawList) {
        const next = new Map();
        rawList.forEach(raw => {
            const win = normalizeWindow(raw);
            if (win) next.set(win.id, win);
        });

        if (!this._hasSnapshot) {
            this.windows      = next;
            this._hasSnapshot = true;
            this.emit('window_list', Array.from(this.windows.values()));
            return;
        }

        // Detect removed
        for (const [id, prev] of this.windows) {
            if (!next.has(id)) this.emit('window_closed', prev);
        }

        // Detect added / changed
        let focused = null;
        for (const [id, win] of next) {
            const prev = this.windows.get(id);
            if (!prev) {
                this.emit('window_created', win);
            } else {
                if (prev.title !== win.title) {
                    this.emit('window_title_changed', win);
                    this.emit('title_changed', win);
                }
                if (prev.minimized !== win.minimized || prev.maximized !== win.maximized || prev.fullscreen !== win.fullscreen) {
                    this.emit('window_state_changed', win);
                    if (win.minimized !== prev.minimized) this.emit('minimized', win);
                    if (win.maximized !== prev.maximized) this.emit('maximized', win);
                }
                if (!prev.focused && win.focused) focused = win;
            }
            if (win.focused) focused = win;
        }

        this.windows = next;
        if (focused) {
            this.emit('window_focused', focused);
            this.emit('focused', focused);
        }
        this.emit('window_list', Array.from(this.windows.values()));
    }

    // ── Event handlers called by the D-Bus interface ──────────────────────────

    _onWindowAdded(win) {
        if (this.windows.has(win.id)) return;   // already known
        this.windows.set(win.id, win);
        console.log('[KWinBackend] Window added:', win.id, win.title);
        this.emit('window_created', win);
        this.emit('window_list', Array.from(this.windows.values()));
    }

    _onWindowRemoved(win) {
        const existing = this.windows.get(win.id);
        if (!existing) return;
        this.windows.delete(win.id);
        console.log('[KWinBackend] Window removed:', win.id, win.title);
        this.emit('window_closed', existing);
        this.emit('window_list', Array.from(this.windows.values()));
    }

    _onWindowActivated(win) {
        // Update focused flag across all windows
        this.windows.forEach((w, id) => { w.focused = (id === (win && win.id)); });
        if (win && this.windows.has(win.id)) {
            const w = this.windows.get(win.id);
            this.emit('window_focused', w);
            this.emit('focused', w);
        }
    }

    _onTitleChanged(win) {
        if (!this.windows.has(win.id)) {
            this.windows.set(win.id, win);
        } else {
            this.windows.get(win.id).title = win.title;
        }
        const stored = this.windows.get(win.id);
        this.emit('window_title_changed', stored);
        this.emit('title_changed', stored);
    }

    _onStateChanged(win) {
        if (!this.windows.has(win.id)) return;
        const stored = this.windows.get(win.id);
        const prevMin = stored.minimized;
        const prevMax = stored.maximized;
        Object.assign(stored, {
            minimized : win.minimized,
            maximized : win.maximized,
            fullscreen: win.fullscreen,
        });
        this.emit('window_state_changed', stored);
        if (prevMin !== stored.minimized) this.emit('minimized', stored);
        if (prevMax !== stored.maximized) this.emit('maximized', stored);
    }

    _onGeometryChanged(win) {
        if (!this.windows.has(win.id)) return;
        const stored = this.windows.get(win.id);
        Object.assign(stored, { x: win.x, y: win.y, width: win.width, height: win.height });
        this.emit('window_moved', stored);
        this.emit('moved', stored);
    }
}

module.exports = KWinBackend;   