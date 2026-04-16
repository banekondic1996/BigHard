const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const LabwcClient = require('./labwc-client');
const WaylandWindowManager = require('./wayland-window-manager');

const LABWC_SOCKET = '/tmp/labwc-nwjs.sock';
const POLL_INTERVAL_MS = 1400;
const CURRENT_DESKTOP = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function safeInvoke(fn, fallback = false) {
    try {
        return fn();
    } catch (error) {
        console.warn('[CompositorBackend] Invocation failed:', error.message);
        return fallback;
    }
}

function normalizeWindow(raw) {
    if (!raw || raw.id === undefined || raw.id === null) {
        return null;
    }

    const appId = raw.app_id
        || raw.appId
        || raw.gtkAppId
        || raw.wmClass
        || raw.class
        || raw.resourceClass
        || '';

    return {
        id: String(raw.id),
        title: raw.title || raw.caption || '',
        app_id: appId,
        appId: appId,
        class: raw.class || raw.wmClass || raw.resourceClass || '',
        pid: raw.pid !== undefined && raw.pid !== null ? Number(raw.pid) : null,
        focused: Boolean(raw.focused || raw.state === 'active' || raw.state === 'focused'),
        minimized: Boolean(raw.minimized || raw.state === 'minimized' || raw.hidden),
        maximized: Boolean(raw.maximized || raw.state === 'maximized'),
        fullscreen: Boolean(raw.fullscreen || raw.state === 'fullscreen'),
        x: Number.isFinite(raw.x) ? raw.x : 0,
        y: Number.isFinite(raw.y) ? raw.y : 0,
        width: Number.isFinite(raw.width) ? raw.width : 0,
        height: Number.isFinite(raw.height) ? raw.height : 0
    };
}

class PollingCompositorBackend extends EventEmitter {
    constructor(options) {
        super();
        this.name = options.name;
        this.fetchWindows = options.fetchWindows;
        this.beforeConnect = options.beforeConnect || null;
        this.afterDisconnect = options.afterDisconnect || null;
        this.focusWindow = options.focusWindow || (() => false);
        this.minimizeWindow = options.minimizeWindow || (() => false);
        this.closeWindow = options.closeWindow || (() => false);
        this.requestThumbnail = options.requestThumbnail || (() => Promise.resolve(null));
        this.getCursorPosition = options.getCursorPosition || (() => ({ x: 0, y: 0 }));
        this.setAlwaysOnTop = options.setAlwaysOnTop || (() => false);
        this.windows = new Map();
        this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
        this.hasSnapshot = false;
        this.pollTimer = null;
        this.isRefreshing = false;
        this.connected = false;
    }

    async connect() {
        if (this.connected) {
            return;
        }

        if (typeof this.beforeConnect === 'function') {
            await this.beforeConnect();
        }

        this.connected = true;
        this.emit('connected');
        await this.refreshWindows();
        this.pollTimer = setInterval(() => {
            this.refreshWindows().catch((error) => {
                this.emit('error', error);
            });
        }, this.pollIntervalMs);
    }

    disconnect() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.connected = false;
        if (typeof this.afterDisconnect === 'function') {
            this.afterDisconnect();
        }
        this.emit('disconnected');
    }

    async refreshWindows() {
        if (this.isRefreshing) {
            return;
        }

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
            this.refreshWindows().catch((error) => {
                this.emit('error', error);
            });
        }, delayMs);
    }

    applySnapshot(rawWindows) {
        const nextWindows = new Map();

        rawWindows
            .map(normalizeWindow)
            .filter(Boolean)
            .forEach((windowInfo) => {
                nextWindows.set(windowInfo.id, windowInfo);
            });

        if (!this.hasSnapshot) {
            this.windows = nextWindows;
            this.hasSnapshot = true;
            this.emit('window_list', Array.from(this.windows.values()));
            return;
        }

        let focusedWindow = null;

        for (const [windowId, previousWindow] of this.windows.entries()) {
            if (!nextWindows.has(windowId)) {
                this.emit('window_closed', previousWindow);
            }
        }

        for (const [windowId, nextWindow] of nextWindows.entries()) {
            const previousWindow = this.windows.get(windowId);

            if (!previousWindow) {
                this.emit('window_created', nextWindow);
            } else {
                if (previousWindow.title !== nextWindow.title) {
                    this.emit('window_title_changed', nextWindow);
                    this.emit('title_changed', nextWindow);
                }

                if (
                    previousWindow.minimized !== nextWindow.minimized
                    || previousWindow.maximized !== nextWindow.maximized
                    || previousWindow.fullscreen !== nextWindow.fullscreen
                ) {
                    this.emit('window_state_changed', nextWindow);
                }

                if (previousWindow.focused !== nextWindow.focused && nextWindow.focused) {
                    focusedWindow = nextWindow;
                }
            }

            if (nextWindow.focused) {
                focusedWindow = nextWindow;
            }
        }

        this.windows = nextWindows;

        if (focusedWindow) {
            this.emit('window_focused', focusedWindow);
            this.emit('focused', focusedWindow);
        }

        this.emit('window_list', Array.from(this.windows.values()));
    }
}

function createLabwcBackend() {
    const client = new LabwcClient(LABWC_SOCKET);
    client.name = 'labwc';
    return client;
}

function createWaylandBackend() {
    const manager = new WaylandWindowManager();
    const backend = new PollingCompositorBackend({
        name: manager.compositor || 'wayland',
        fetchWindows: async () => manager.getWindows(),
        focusWindow: (windowId) => manager.activateWindow(windowId),
        minimizeWindow: (windowId) => manager.minimizeWindow(windowId),
        closeWindow: (windowId) => manager.closeWindow(windowId),
        afterDisconnect: () => manager.destroy()
    });

    ['window-added', 'window-updated', 'window-removed'].forEach((eventName) => {
        manager.on(eventName, () => backend.scheduleRefresh(20));
    });

    return backend;
}

function parsePsLookup(stdout) {
    const lookup = new Map();

    stdout.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }

        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!match) {
            return;
        }

        lookup.set(Number(match[1]), match[2].trim());
    });

    return lookup;
}

async function fetchX11Windows() {
    const [wmctrlResult, psResult, activeResult] = await Promise.allSettled([
        execPromise('wmctrl -lp'),
        execPromise('ps -eo pid=,comm='),
        execPromise('xprop -root _NET_ACTIVE_WINDOW')
    ]);

    if (wmctrlResult.status !== 'fulfilled') {
        throw wmctrlResult.reason;
    }

    const processLookup = psResult.status === 'fulfilled'
        ? parsePsLookup(psResult.value.stdout)
        : new Map();

    const activeWindowId = activeResult.status === 'fulfilled'
        ? ((activeResult.value.stdout.match(/0x[0-9a-f]+/i) || [])[0] || '').toLowerCase()
        : '';

    return wmctrlResult.value.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/);
            if (!match) {
                return null;
            }

            const windowId = match[1].toLowerCase();
            const pid = Number(match[2]);
            const processName = processLookup.get(pid) || '';

            return normalizeWindow({
                id: windowId,
                pid,
                title: match[3] || processName,
                app_id: processName,
                focused: windowId === activeWindowId
            });
        })
        .filter(Boolean);
}

async function fetchXdotoolWindows() {
    const [searchResult, processLookupResult, activeWindowResult] = await Promise.allSettled([
        execPromise("xdotool search --onlyvisible --name '.*'"),
        execPromise('ps -eo pid=,comm='),
        execPromise('xdotool getactivewindow')
    ]);

    if (searchResult.status !== 'fulfilled') {
        throw searchResult.reason;
    }

    const processLookup = processLookupResult.status === 'fulfilled'
        ? parsePsLookup(processLookupResult.value.stdout)
        : new Map();
    const activeWindowId = activeWindowResult.status === 'fulfilled'
        ? activeWindowResult.value.stdout.trim()
        : '';

    const ids = searchResult.value.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const windows = await Promise.all(ids.map(async (windowId) => {
        const [nameResult, pidResult] = await Promise.allSettled([
            execPromise(`xdotool getwindowname ${windowId}`),
            execPromise(`xdotool getwindowpid ${windowId}`)
        ]);

        const pid = pidResult.status === 'fulfilled'
            ? Number(pidResult.value.stdout.trim() || 0)
            : null;
        const processName = pid ? (processLookup.get(pid) || '') : '';
        const title = nameResult.status === 'fulfilled'
            ? nameResult.value.stdout.trim()
            : processName;

        return normalizeWindow({
            id: windowId,
            pid,
            title,
            app_id: processName,
            focused: String(windowId) === activeWindowId
        });
    }));

    return windows.filter(Boolean);
}

async function fetchX11WindowsWithFallback() {
    try {
        const windows = await fetchX11Windows();
        if (windows.length) {
            return windows;
        }
    } catch (error) {
        // Fall through to xdotool.
    }

    return fetchXdotoolWindows();
}

function execQuiet(command) {
    exec(command, () => {});
}

function stopPlasmaShell() {
    execQuiet('kquitapp6 plasmashell || kquitapp5 plasmashell || qdbus6 org.kde.plasmashell /PlasmaShell org.qtproject.Qt.QCoreApplication.quit || qdbus org.kde.plasmashell /PlasmaShell org.qtproject.Qt.QCoreApplication.quit || true');
}

function startPlasmaShell() {
    execQuiet('plasmashell >/dev/null 2>&1 &');
}

function createX11Backend(name = 'x11', options = {}) {
    return new PollingCompositorBackend({
        name,
        fetchWindows: fetchX11WindowsWithFallback,
        beforeConnect: options.beforeConnect,
        afterDisconnect: options.afterDisconnect,
        focusWindow: (windowId) => {
            exec(`wmctrl -ia ${windowId} 2>/dev/null || xdotool windowactivate ${windowId} 2>/dev/null`, () => {});
            return true;
        },
        minimizeWindow: (windowId) => {
            exec(`xdotool windowminimize ${windowId}`, () => {});
            return true;
        },
        closeWindow: (windowId) => {
            exec(`wmctrl -ic ${windowId} 2>/dev/null || xdotool windowclose ${windowId} 2>/dev/null`, () => {});
            return true;
        }
    });
}

function createKdeBackend() {
    return createX11Backend('kde', {
        beforeConnect: () => {
            stopPlasmaShell();
        },
        afterDisconnect: () => {
            startPlasmaShell();
        }
    });
}

function loadMutterBridge() {
    const modulePath = path.resolve(__dirname, '..', '..', 'custom_node_modules', 'mutter-node');
    return require(modulePath);
}

function createMutterBackend() {
    const mutter = loadMutterBridge();

    return new PollingCompositorBackend({
        name: 'mutter',
        beforeConnect: async () => {
            if (typeof mutter.initMutter !== 'function') {
                throw new Error('Mutter bridge is missing initMutter()');
            }

            try {
                mutter.initMutter();
            } catch (error) {
                if (!/already initialized/i.test(error.message)) {
                    throw error;
                }
            }
        },
        fetchWindows: async () => {
            if (typeof mutter.getWindows !== 'function') {
                return [];
            }
            return mutter.getWindows();
        },
        focusWindow: (windowId) => safeInvoke(() => mutter.focusWindow(Number(windowId))),
        minimizeWindow: (windowId) => safeInvoke(() => mutter.minimizeWindow(Number(windowId))),
        closeWindow: (windowId) => safeInvoke(() => mutter.closeWindow(Number(windowId))),
        getCursorPosition: () => safeInvoke(() => mutter.getCursorPosition(), { x: 0, y: 0 }),
        setAlwaysOnTop: (windowId) => safeInvoke(() => mutter.makeAbove(Number(windowId)))
    });
}

function detectBackendKind() {
    const sessionType = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
    const hasWayland = Boolean(process.env.WAYLAND_DISPLAY);

    if (fs.existsSync(LABWC_SOCKET)) {
        return 'labwc';
    }

    if (CURRENT_DESKTOP.includes('kde') || CURRENT_DESKTOP.includes('plasma')) {
        return 'kde';
    }

    if (sessionType === 'x11') {
        return 'x11';
    }

    if (CURRENT_DESKTOP.includes('gnome') || CURRENT_DESKTOP.includes('ubuntu') || CURRENT_DESKTOP.includes('mutter')) {
        return 'mutter';
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
        if (backendKind === 'labwc') {
            return createLabwcBackend();
        }

        if (backendKind === 'mutter') {
            return createMutterBackend();
        }

        if (backendKind === 'kde') {
            return createKdeBackend();
        }

        if (backendKind === 'wayland') {
            return createWaylandBackend();
        }

        return createX11Backend(backendKind);
    } catch (error) {
        console.warn('[CompositorBackend] Falling back to X11 backend:', error.message);
        return createX11Backend(`${backendKind}-fallback`);
    }
}

module.exports = createCompositorBackend;
