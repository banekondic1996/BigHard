// compositor-backend.js
// Selects and creates the right compositor backend for the current session.
//
// Backend priority:
//   1. labwc     — custom labwc IPC socket present
//   2. kwin      — KDE/KWin session (Wayland or X11)
//   3. mutter    — GNOME Mutter (native Node addon)
//   4. gnome     — GNOME Shell via window-calls extension + gdbus
//   5. x11       — generic X11 (wmctrl / xdotool polling)
//   6. wayland   — generic wlroots Wayland (wlr-foreign-toplevel)

const EventEmitter = require('events');
const fs    = require('fs');
const path  = require('path');
const { exec } = require('child_process');

const LabwcClient          = require('./labwc-client');
const WaylandWindowManager = require('./wayland-window-manager');
const KWinBackend          = require('./kwin-backend');
const GnomeBackend         = require('./gnome-backend');

const LABWC_SOCKET   = '/tmp/labwc-nwjs.sock';
const POLL_INTERVAL_MS = 1400;
const CURRENT_DESKTOP  = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
            resolve({ stdout, stderr });
        });
    });
}

function safeInvoke(fn, fallback = false) {
    try { return fn(); }
    catch (error) { console.warn('[CompositorBackend] Invocation failed:', error.message); return fallback; }
}

function normalizeWindow(raw) {
    if (!raw || raw.id === undefined || raw.id === null) return null;

    const appId = raw.app_id || raw.appId || raw.gtkAppId
        || raw.wmClass || raw.class || raw.resourceClass || '';

    return {
        id       : String(raw.id),
        title    : raw.title    || raw.caption || '',
        app_id   : appId,
        appId    : appId,
        class    : raw.class    || raw.wmClass || raw.resourceClass || '',
        pid      : raw.pid !== undefined && raw.pid !== null ? Number(raw.pid) : null,
        focused  : Boolean(raw.focused  || raw.state === 'active'    || raw.state === 'focused'),
        minimized: Boolean(raw.minimized || raw.state === 'minimized' || raw.hidden),
        maximized: Boolean(raw.maximized || raw.state === 'maximized'),
        fullscreen: Boolean(raw.fullscreen || raw.state === 'fullscreen'),
        x      : Number.isFinite(raw.x)      ? raw.x      : 0,
        y      : Number.isFinite(raw.y)      ? raw.y      : 0,
        width  : Number.isFinite(raw.width)  ? raw.width  : 0,
        height : Number.isFinite(raw.height) ? raw.height : 0,
    };
}

// ─── Generic polling backend (used for X11 / wlroots fallbacks) ───────────────

class PollingCompositorBackend extends EventEmitter {
    constructor(options) {
        super();
        this.name            = options.name;
        this.fetchWindows    = options.fetchWindows;
        this.beforeConnect   = options.beforeConnect   || null;
        this.afterDisconnect = options.afterDisconnect || null;
        this.focusWindow     = options.focusWindow     || (() => false);
        this.minimizeWindow  = options.minimizeWindow  || (() => false);
        this.maximizeWindow  = options.maximizeWindow  || (() => false);
        this.closeWindow     = options.closeWindow     || (() => false);
        this.requestThumbnail  = options.requestThumbnail  || (() => Promise.resolve(null));
        this.getCursorPosition = options.getCursorPosition || (() => ({ x: 0, y: 0 }));
        this.setAlwaysOnTop    = options.setAlwaysOnTop    || (() => false);
        this.windows         = new Map();
        this.pollIntervalMs  = options.pollIntervalMs  || POLL_INTERVAL_MS;
        this.hasSnapshot     = false;
        this.pollTimer       = null;
        this.isRefreshing    = false;
        this.connected       = false;
    }

    async connect() {
        if (this.connected) return;
        if (typeof this.beforeConnect === 'function') await this.beforeConnect();
        this.connected = true;
        this.emit('connected');
        await this.refreshWindows();
        this.pollTimer = setInterval(() => {
            this.refreshWindows().catch(err => this.emit('error', err));
        }, this.pollIntervalMs);
    }

    disconnect() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        this.connected = false;
        if (typeof this.afterDisconnect === 'function') this.afterDisconnect();
        this.emit('disconnected');
    }

    async refreshWindows() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;
        try {
            const nextList = await this.fetchWindows();
            this.applySnapshot(nextList || []);
        } finally {
            this.isRefreshing = false;
        }
    }

    scheduleRefresh(delayMs = 80) {
        setTimeout(() => {
            this.refreshWindows().catch(err => this.emit('error', err));
        }, delayMs);
    }

    applySnapshot(rawWindows) {
        const nextWindows = new Map();
        rawWindows.map(normalizeWindow).filter(Boolean)
            .forEach(win => nextWindows.set(win.id, win));

        if (!this.hasSnapshot) {
            this.windows     = nextWindows;
            this.hasSnapshot = true;
            this.emit('window_list', Array.from(this.windows.values()));
            return;
        }

        let focusedWindow = null;

        for (const [id, prev] of this.windows) {
            if (!nextWindows.has(id)) this.emit('window_closed', prev);
        }

        for (const [id, next] of nextWindows) {
            const prev = this.windows.get(id);
            if (!prev) {
                this.emit('window_created', next);
            } else {
                if (prev.title !== next.title) {
                    this.emit('window_title_changed', next);
                    this.emit('title_changed', next);
                }
                if (prev.minimized !== next.minimized || prev.maximized !== next.maximized || prev.fullscreen !== next.fullscreen) {
                    this.emit('window_state_changed', next);
                }
                if (!prev.focused && next.focused) focusedWindow = next;
            }
            if (next.focused) focusedWindow = next;
        }

        this.windows = nextWindows;
        if (focusedWindow) {
            this.emit('window_focused', focusedWindow);
            this.emit('focused', focusedWindow);
        }
        this.emit('window_list', Array.from(this.windows.values()));
    }

    getWindows() { return Array.from(this.windows.values()); }
}

// ─── Backend factories ────────────────────────────────────────────────────────

function createLabwcBackend() {
    const client = new LabwcClient(LABWC_SOCKET);
    client.name = 'labwc';
    return client;
}

function createKWinBackend() {
    return new KWinBackend();
}

function createGnomeBackend() {
    return new GnomeBackend();
}

function createWaylandBackend() {
    const manager = new WaylandWindowManager();
    const backend = new PollingCompositorBackend({
        name        : manager.compositor || 'wayland',
        fetchWindows: async () => manager.getWindows(),
        focusWindow : (id) => manager.activateWindow(id),
        minimizeWindow: (id) => manager.minimizeWindow(id),
        closeWindow : (id) => manager.closeWindow(id),
        afterDisconnect: () => manager.destroy(),
    });
    ['window-added', 'window-updated', 'window-removed']
        .forEach(ev => manager.on(ev, () => backend.scheduleRefresh(20)));
    return backend;
}

// ── X11 window fetchers ───────────────────────────────────────────────────────

function parsePsLookup(stdout) {
    const lookup = new Map();
    stdout.split('\n').forEach(line => {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (m) lookup.set(Number(m[1]), m[2].trim());
    });
    return lookup;
}

async function fetchX11Windows() {
    const [wmctrlResult, psResult, activeResult] = await Promise.allSettled([
        execPromise('wmctrl -lp'),
        execPromise('ps -eo pid=,comm='),
        execPromise('xprop -root _NET_ACTIVE_WINDOW'),
    ]);

    if (wmctrlResult.status !== 'fulfilled') throw wmctrlResult.reason;

    const processLookup = psResult.status === 'fulfilled'
        ? parsePsLookup(psResult.value.stdout) : new Map();

    const activeWindowId = activeResult.status === 'fulfilled'
        ? ((activeResult.value.stdout.match(/0x[0-9a-f]+/i) || [])[0] || '').toLowerCase()
        : '';

    return wmctrlResult.value.stdout.split('\n')
        .map(line => line.trim()).filter(Boolean)
        .map(line => {
            const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/);
            if (!m) return null;
            const windowId    = m[1].toLowerCase();
            const pid         = Number(m[2]);
            const processName = processLookup.get(pid) || '';
            return normalizeWindow({
                id     : windowId,
                pid,
                title  : m[3] || processName,
                app_id : processName,
                focused: windowId === activeWindowId,
            });
        }).filter(Boolean);
}

async function fetchXdotoolWindows() {
    const [searchResult, processLookupResult, activeWindowResult] = await Promise.allSettled([
        execPromise("xdotool search --onlyvisible --name '.*'"),
        execPromise('ps -eo pid=,comm='),
        execPromise('xdotool getactivewindow'),
    ]);

    if (searchResult.status !== 'fulfilled') throw searchResult.reason;

    const processLookup = processLookupResult.status === 'fulfilled'
        ? parsePsLookup(processLookupResult.value.stdout) : new Map();
    const activeWindowId = activeWindowResult.status === 'fulfilled'
        ? activeWindowResult.value.stdout.trim() : '';

    const ids = searchResult.value.stdout.split('\n').map(l => l.trim()).filter(Boolean);

    const windows = await Promise.all(ids.map(async (windowId) => {
        const [nameResult, pidResult] = await Promise.allSettled([
            execPromise(`xdotool getwindowname ${windowId}`),
            execPromise(`xdotool getwindowpid ${windowId}`),
        ]);
        const pid  = pidResult.status === 'fulfilled' ? Number(pidResult.value.stdout.trim() || 0) : null;
        const processName = pid ? (processLookup.get(pid) || '') : '';
        const title = nameResult.status === 'fulfilled' ? nameResult.value.stdout.trim() : processName;
        return normalizeWindow({ id: windowId, pid, title, app_id: processName, focused: String(windowId) === activeWindowId });
    }));

    return windows.filter(Boolean);
}

async function fetchX11WindowsWithFallback() {
    try {
        const windows = await fetchX11Windows();
        if (windows.length) return windows;
    } catch (_) {}
    return fetchXdotoolWindows();
}

function execQuiet(cmd) { exec(cmd, () => {}); }

function createX11Backend(name = 'x11', options = {}) {
    return new PollingCompositorBackend({
        name,
        fetchWindows    : fetchX11WindowsWithFallback,
        beforeConnect   : options.beforeConnect,
        afterDisconnect : options.afterDisconnect,
        focusWindow     : (id) => { execQuiet(`wmctrl -ia ${id} 2>/dev/null || xdotool windowactivate ${id} 2>/dev/null`); return true; },
        minimizeWindow  : (id) => { execQuiet(`xdotool windowminimize ${id}`); return true; },
        maximizeWindow  : (id) => { execQuiet(`wmctrl -ir ${id} -b toggle,maximized_vert,maximized_horz 2>/dev/null`); return true; },
        closeWindow     : (id) => { execQuiet(`wmctrl -ic ${id} 2>/dev/null || xdotool windowclose ${id} 2>/dev/null`); return true; },
    });
}

// ── Mutter (GNOME native addon) ───────────────────────────────────────────────

function loadMutterBridge() {
    const modulePath = path.resolve(__dirname, '..', '..', 'custom_node_modules', 'mutter-node');
    return require(modulePath);
}

function createMutterBackend() {
    const mutter = loadMutterBridge();
    return new PollingCompositorBackend({
        name: 'mutter',
        beforeConnect: async () => {
            if (typeof mutter.initMutter !== 'function') throw new Error('Mutter bridge missing initMutter()');
            try { mutter.initMutter(); }
            catch (err) { if (!/already initialized/i.test(err.message)) throw err; }
        },
        fetchWindows  : async () => typeof mutter.getWindows === 'function' ? mutter.getWindows() : [],
        focusWindow   : (id) => safeInvoke(() => mutter.focusWindow(Number(id))),
        minimizeWindow: (id) => safeInvoke(() => mutter.minimizeWindow(Number(id))),
        closeWindow   : (id) => safeInvoke(() => mutter.closeWindow(Number(id))),
        getCursorPosition: () => safeInvoke(() => mutter.getCursorPosition(), { x: 0, y: 0 }),
        setAlwaysOnTop: (id) => safeInvoke(() => mutter.makeAbove(Number(id))),
    });
}

// ─── Backend selection ────────────────────────────────────────────────────────

function detectBackendKind() {
    const sessionType = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
    const hasWayland  = Boolean(process.env.WAYLAND_DISPLAY);

    if (fs.existsSync(LABWC_SOCKET)) {
        return 'labwc';
    }

    if (CURRENT_DESKTOP.includes('kde') || CURRENT_DESKTOP.includes('plasma')) {
        return 'kwin';
    }

    if (sessionType === 'x11' && !CURRENT_DESKTOP.includes('gnome') && !CURRENT_DESKTOP.includes('ubuntu')) {
        return 'x11';
    }

    // Try mutter native addon first for GNOME (best real-time events)
    if (CURRENT_DESKTOP.includes('gnome') || CURRENT_DESKTOP.includes('ubuntu') || CURRENT_DESKTOP.includes('mutter')) {
        try {
            loadMutterBridge();
            return 'mutter';
        } catch (_) {
            return 'gnome';
        }
    }

    if (hasWayland) {
        return 'wayland';
    }

    return 'x11';
}

function createCompositorBackend() {
    const backendKind = detectBackendKind();
    console.log('[CompositorBackend] Selected backend:', backendKind);

    try {
        switch (backendKind) {
            case 'labwc':   return createLabwcBackend();
            case 'kwin':    return createKWinBackend();
            case 'mutter':  return createMutterBackend();
            case 'gnome':   return createGnomeBackend();
            case 'wayland': return createWaylandBackend();
            default:        return createX11Backend(backendKind);
        }
    } catch (error) {
        console.warn('[CompositorBackend] Backend creation failed, falling back to X11:', error.message);
        return createX11Backend(`${backendKind}-fallback`);
    }
}

module.exports = createCompositorBackend;