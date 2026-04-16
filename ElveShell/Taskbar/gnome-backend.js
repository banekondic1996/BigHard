// gnome-backend.js
// Compositor backend for GNOME Shell (Wayland or X11).
//
// Requires the "window-calls" GNOME extension to be installed and enabled:
//   https://github.com/ickyicky/window-calls
//   UUID: window-calls@domandoman.xyz
//
// Or alternatively "window-calls-extended":
//   UUID: window-calls-extended@hseliger.eu
//
// We try both extension D-Bus paths and fall back to wmctrl/xdotool on X11.
//
// Emits the same events as LabwcClient / KWinBackend.

const EventEmitter = require('events');
const { exec }     = require('child_process');

const POLL_MS = 1500;

// Two possible extension D-Bus endpoints — try in order.
const GNOME_ENDPOINTS = [
    {
        dest  : 'org.gnome.Shell',
        path  : '/org/gnome/Shell/Extensions/Windows',
        iface : 'org.gnome.Shell.Extensions.Windows',
    },
    {
        dest  : 'org.gnome.Shell',
        path  : '/org/gnome/Shell/Extensions/WindowsExt',
        iface : 'org.gnome.Shell.Extensions.WindowsExt',
    },
];

// ─── Utility ──────────────────────────────────────────────────────────────────

function execP(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 4 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
            if (err) { err.stdout = stdout; reject(err); }
            else resolve(stdout);
        });
    });
}

function execQuiet(cmd) { exec(cmd, () => {}); }

// gdbus call output looks like:  ({'key': <value>, ...},)
// --print-reply=literal skips the GVariant wrapper and returns raw JSON-ish text.
// We ask the extension to return actual JSON via the Details method.
function parseGdbusArray(raw) {
    // The List method returns a GVariant array of dicts.
    // With --print-reply=literal it becomes a Python-ish repr; easier to
    // parse via a small wrapper that echoes JSON.
    // We strip the outer (  ,) wrapper, then let JSON.parse handle it.
    const trimmed = raw.trim();
    // Output format: (value,) where value is the array or string
    const inner = trimmed.replace(/^\(/, '').replace(/,\s*\)$/, '').trim();
    return JSON.parse(inner);
}

function normalizeGnomeWindow(raw, activeId) {
    if (!raw) return null;
    const id = String(raw.id !== undefined ? raw.id : raw.window_id || '');
    if (!id) return null;

    const appId = raw.wm_class || raw.app_id || raw.pid?.toString() || '';
    return {
        id        : id,
        title     : raw.title || raw.caption || '',
        app_id    : appId,
        appId     : appId,
        class     : raw.wm_class || '',
        pid       : raw.pid ? Number(raw.pid) : null,
        focused   : String(activeId) === id || Boolean(raw.focus || raw.focused),
        minimized : Boolean(raw.minimized),
        maximized : Boolean(raw.maximized),
        fullscreen: Boolean(raw.fullscreen),
        x         : Number(raw.x || 0),
        y         : Number(raw.y || 0),
        width     : Number(raw.width || 0),
        height    : Number(raw.height || 0),
    };
}

// ─── GnomeBackend ─────────────────────────────────────────────────────────────

class GnomeBackend extends EventEmitter {
    constructor() {
        super();
        this.name          = 'gnome';
        this.windows       = new Map();
        this.connected     = false;
        this._endpoint     = null;   // which GNOME_ENDPOINTS entry works
        this._pollTimer    = null;
        this._hasSnapshot  = false;
        this._isPolling    = false;
    }

    async connect() {
        if (this.connected) return;
        console.log('[GnomeBackend] Connecting...');

        this._endpoint = await this._detectEndpoint();

        if (this._endpoint) {
            console.log('[GnomeBackend] Using GNOME extension endpoint:', this._endpoint.iface);
        } else {
            console.warn('[GnomeBackend] No GNOME window-calls extension found — falling back to wmctrl');
        }

        this.connected = true;
        this.emit('connected');

        await this._poll();
        this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    }

    disconnect() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        this.connected = false;
        this.emit('disconnected');
    }

    // ── Window control ────────────────────────────────────────────────────────

    focusWindow(windowId) {
        if (this._endpoint) {
            execQuiet(
                `gdbus call --session --dest ${this._endpoint.dest} ` +
                `--object-path ${this._endpoint.path} ` +
                `--method ${this._endpoint.iface}.Activate ${windowId} 2>/dev/null || true`
            );
        } else {
            execQuiet(`wmctrl -ia ${windowId} 2>/dev/null || xdotool windowactivate ${windowId} 2>/dev/null`);
        }
        return true;
    }

    minimizeWindow(windowId) {
        if (this._endpoint) {
            execQuiet(
                `gdbus call --session --dest ${this._endpoint.dest} ` +
                `--object-path ${this._endpoint.path} ` +
                `--method ${this._endpoint.iface}.Minimize ${windowId} 2>/dev/null || true`
            );
        } else {
            execQuiet(`xdotool windowminimize ${windowId} 2>/dev/null`);
        }
        return true;
    }

    closeWindow(windowId) {
        if (this._endpoint) {
            execQuiet(
                `gdbus call --session --dest ${this._endpoint.dest} ` +
                `--object-path ${this._endpoint.path} ` +
                `--method ${this._endpoint.iface}.Close ${windowId} 2>/dev/null || true`
            );
        } else {
            execQuiet(`wmctrl -ic ${windowId} 2>/dev/null || xdotool windowclose ${windowId} 2>/dev/null`);
        }
        return true;
    }

    maximizeWindow(windowId) {
        if (this._endpoint) {
            execQuiet(
                `gdbus call --session --dest ${this._endpoint.dest} ` +
                `--object-path ${this._endpoint.path} ` +
                `--method ${this._endpoint.iface}.Maximize ${windowId} 2>/dev/null || true`
            );
        } else {
            execQuiet(`wmctrl -ir ${windowId} -b toggle,maximized_vert,maximized_horz 2>/dev/null`);
        }
        return true;
    }

    setAlwaysOnTop(windowId) {
        execQuiet(`wmctrl -ir ${windowId} -b add,above 2>/dev/null`);
        return true;
    }

    requestThumbnail() { return Promise.resolve(null); }
    getCursorPosition() { return { x: 0, y: 0 }; }
    getWindows() { return Array.from(this.windows.values()); }

    // ── Endpoint detection ────────────────────────────────────────────────────

    async _detectEndpoint() {
        for (const ep of GNOME_ENDPOINTS) {
            try {
                await execP(
                    `gdbus call --session --dest ${ep.dest} --object-path ${ep.path} ` +
                    `--method ${ep.iface}.List 2>/dev/null`
                );
                return ep;
            } catch (_) {}
        }
        return null;
    }

    // ── Polling ───────────────────────────────────────────────────────────────

    async _poll() {
        if (this._isPolling) return;
        this._isPolling = true;
        try {
            const windows = this._endpoint
                ? await this._fetchViaExtension()
                : await this._fetchViaWmctrl();
            this._applySnapshot(windows);
        } catch (err) {
            console.warn('[GnomeBackend] Poll error:', err.message);
        } finally {
            this._isPolling = false;
        }
    }

    async _fetchViaExtension() {
        const ep = this._endpoint;

        // Fetch the raw list (basic info)
        const raw = await execP(
            `gdbus call --session --dest ${ep.dest} --object-path ${ep.path} ` +
            `--method ${ep.iface}.List --print-reply=literal 2>/dev/null`
        );

        let list;
        try {
            list = parseGdbusArray(raw);
        } catch (_) {
            // Some versions return a JSON string directly
            try { list = JSON.parse(raw.trim()); } catch (__) { return []; }
        }

        if (!Array.isArray(list)) return [];

        // Find which window is focused
        let activeId = null;
        try {
            const focusRaw = await execP(
                `gdbus call --session --dest ${ep.dest} --object-path ${ep.path} ` +
                `--method ${ep.iface}.FocusTitle --print-reply=literal 2>/dev/null`
            );
            // FocusTitle returns (id, title) or just the id depending on extension version
            const m = focusRaw.match(/\b(\d{6,})\b/);
            if (m) activeId = m[1];
        } catch (_) {}

        return list
            .filter(w => w && (w.window_type === undefined || w.window_type === 0))
            .map(w => normalizeGnomeWindow(w, activeId))
            .filter(Boolean);
    }

    async _fetchViaWmctrl() {
        const [wmOut, psOut, activeOut] = await Promise.allSettled([
            execP('wmctrl -lp'),
            execP('ps -eo pid=,comm='),
            execP('xprop -root _NET_ACTIVE_WINDOW'),
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
            return normalizeGnomeWindow({
                id    : winId,
                title : m[3] || psMap.get(pid) || '',
                wm_class: psMap.get(pid) || '',
                pid,
                focused: winId === activeId,
            }, activeId);
        }).filter(Boolean);
    }

    // ── Snapshot diff (same pattern as KWinBackend) ───────────────────────────

    _applySnapshot(rawList) {
        const next = new Map();
        rawList.forEach(win => { if (win) next.set(win.id, win); });

        if (!this._hasSnapshot) {
            this.windows      = next;
            this._hasSnapshot = true;
            this.emit('window_list', Array.from(this.windows.values()));
            return;
        }

        for (const [id, prev] of this.windows) {
            if (!next.has(id)) this.emit('window_closed', prev);
        }

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
                    if (prev.minimized !== win.minimized) this.emit('minimized', win);
                    if (prev.maximized !== win.maximized) this.emit('maximized', win);
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
}

module.exports = GnomeBackend;