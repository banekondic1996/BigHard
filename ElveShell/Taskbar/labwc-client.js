// labwc-client.js - IMPROVED VERSION
// Node.js module for NW.js to communicate with labwc
const net = require('net');
const EventEmitter = require('events');

class LabwcClient extends EventEmitter {
    constructor(socketPath = '/tmp/labwc-nwjs.sock') {
        super();
        this.socketPath = socketPath;
        this.socket = null;
        this.reconnectTimer = null;
        this.windows = new Map();
        this.cursorX = 0;
        this.cursorY = 0;
        this.buffer = '';
        this.thumbnailRequests = new Map();
    }

    connect() {
        if (this.socket) {
            return;
        }

        this.socket = net.createConnection(this.socketPath, () => {
            console.log('[LabwcClient] Connected to labwc compositor');
            this.emit('connected');
            
            // Request initial window list
            this.send({ cmd: 'list' });
        });

        this.socket.on('data', (data) => {
            this.handleData(data.toString());
        });

        this.socket.on('error', (err) => {
            console.error('[LabwcClient] Socket error:', err.message);
            this.emit('error', err);
        });

        this.socket.on('close', () => {
            console.log('[LabwcClient] Disconnected from labwc compositor');
            this.socket = null;
            this.emit('disconnected');
            
            // Auto-reconnect after 1 second
            if (!this.reconnectTimer) {
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    this.connect();
                }, 1000);
            }
        });
    }

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    handleData(data) {
        this.buffer += data;
        
        // Process complete lines (newline-delimited JSON)
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // Keep incomplete line in buffer
        
        for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
                const msg = JSON.parse(line);
                this.handleMessage(msg);
            } catch (err) {
                console.error('[LabwcClient] Failed to parse message:', line, err);
            }
        }
    }

    handleMessage(msg) {
        console.log('[LabwcClient] Message:', msg.event, msg.id);
        
        switch (msg.event) {
            case 'cursor':
                this.cursorX = msg.x;
                this.cursorY = msg.y;
                this.emit('cursor', { x: msg.x, y: msg.y });
                break;
                
            case 'window_list':
                console.log('[LabwcClient] Received window_list with', msg.windows.length, 'windows');
                this.windows.clear();
                for (const win of msg.windows) {
                    this.windows.set(win.id, win);
                }
                this.emit('window_list', Array.from(this.windows.values()));
                break;
                
            case 'mapped':
                console.log('[LabwcClient] Window mapped:', msg.id, msg.title);
                this.windows.set(msg.id, msg);
                this.emit('window_created', msg);
                this.emit('mapped', msg);
                break;
                
            case 'unmapped':
                console.log('[LabwcClient] Window unmapped:', msg.id);
                if (this.windows.has(msg.id)) {
                    Object.assign(this.windows.get(msg.id), msg);
                }
                this.emit('unmapped', this.windows.get(msg.id) || msg);
                break;
                
            case 'closed':
                console.log('[LabwcClient] Window closed:', msg.id);
                const closedWin = this.windows.get(msg.id);
                this.windows.delete(msg.id);
                this.emit('window_closed', closedWin || msg);
                break;
                
            case 'moved':
                console.log('[LabwcClient] Window moved:', msg.id);
                if (this.windows.has(msg.id)) {
                    Object.assign(this.windows.get(msg.id), msg);
                    this.emit('window_moved', msg);
                    this.emit('moved', msg);
                }
                break;
                
            case 'focused':
                console.log('[LabwcClient] Window focused:', msg.id);
                // Update focused state in ALL windows
                this.windows.forEach((win, id) => {
                    win.focused = (id === msg.id);
                });
                if (this.windows.has(msg.id)) {
                    this.emit('window_focused', this.windows.get(msg.id));
                    this.emit('focused', msg);
                }
                break;
                
            case 'title_changed':
                console.log('[LabwcClient] Title changed:', msg.id, msg.title);
                if (this.windows.has(msg.id)) {
                    this.windows.get(msg.id).title = msg.title;
                    this.emit('window_title_changed', this.windows.get(msg.id));
                    this.emit('title_changed', msg);
                }
                break;
                
            case 'minimized':
                console.log('[LabwcClient] Window minimized:', msg.id, 'minimized value:', msg.minimized);
                if (this.windows.has(msg.id)) {
                    this.windows.get(msg.id).minimized = msg.minimized;
                    this.windows.get(msg.id).focused = false; // Clear focused when minimized
                    this.emit('window_state_changed', this.windows.get(msg.id));
                    this.emit('minimized', this.windows.get(msg.id));
                } else {
                    console.warn('[LabwcClient] ⚠️ Minimized event for unknown window:', msg.id);
                }
                break;
                
            case 'maximized':
                console.log('[LabwcClient] Window maximized:', msg.id);
                if (this.windows.has(msg.id)) {
                    Object.assign(this.windows.get(msg.id), msg);
                    this.emit('window_state_changed', this.windows.get(msg.id));
                    this.emit('maximized', msg);
                }
                break;
                
            case 'fullscreen':
                console.log('[LabwcClient] Window fullscreen:', msg.id);
                if (this.windows.has(msg.id)) {
                    Object.assign(this.windows.get(msg.id), msg);
                    this.emit('window_state_changed', this.windows.get(msg.id));
                    this.emit('fullscreen', msg);
                }
                break;

            case 'thumbnail':
                this.emit('thumbnail', msg);
                this.resolveThumbnailRequest(msg.id, msg.path || null);
                break;

            case 'thumbnail_error':
                this.emit('thumbnail_error', msg);
                this.resolveThumbnailRequest(msg.id, null);
                break;
                
            case 'decorations_disabled':
                this.emit('decorations_disabled');
                break;
                
            default:
                console.warn('[LabwcClient] Unknown event:', msg.event);
        }
    }

    send(command) {
        if (!this.socket) {
            console.warn('[LabwcClient] Not connected to compositor');
            return false;
        }
        
        const msg = JSON.stringify(command) + '\n';
        this.socket.write(msg);
        return true;
    }

    resolveThumbnailRequest(windowId, path) {
        const pending = this.thumbnailRequests.get(windowId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.thumbnailRequests.delete(windowId);
        pending.resolve(path);
    }

    // Window control methods
    closeWindow(windowId) {
        console.log('[LabwcClient] Sending close command for:', windowId);
        return this.send({ cmd: 'close', id: windowId });
    }

    minimizeWindow(windowId) {
        console.log('[LabwcClient] Sending minimize command for:', windowId);
        
        // Check current state
        const win = this.windows.get(windowId);
        if (win) {
            console.log('[LabwcClient] Current window state - minimized:', win.minimized);
        }
        
        return this.send({ cmd: 'minimize', id: windowId });
    }

    maximizeWindow(windowId) {
        console.log('[LabwcClient] Sending maximize command for:', windowId);
        return this.send({ cmd: 'maximize', id: windowId });
    }

    moveWindow(windowId, x, y, width, height) {
        console.log('[LabwcClient] Sending move command for:', windowId);
        return this.send({
            cmd: 'move',
            id: windowId,
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height)
        });
    }

    focusWindow(windowId) {
        console.log('[LabwcClient] Sending focus command for:', windowId);
        return this.send({ cmd: 'focus', id: windowId });
    }

    setAlwaysOnTop(windowId) {
        console.log('[LabwcClient] Sending always_on_top command for:', windowId);
        return this.send({ cmd: 'always_on_top', id: windowId });
    }

    setAlwaysOnBottom(windowId) {
        console.log('[LabwcClient] Sending always_on_bottom command for:', windowId);
        return this.send({ cmd: 'always_on_bottom', id: windowId });
    }

    getWindows() {
        return Array.from(this.windows.values());
    }

    requestThumbnail(windowId, options = {}) {
        const thumbWidth = Math.max(32, Number(options.width) || 320);
        const thumbHeight = Math.max(18, Number(options.height) || 180);

        if (this.thumbnailRequests.has(windowId)) {
            const old = this.thumbnailRequests.get(windowId);
            clearTimeout(old.timer);
            this.thumbnailRequests.delete(windowId);
            old.resolve(null);
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.thumbnailRequests.delete(windowId);
                resolve(null);
            }, 2000);

            this.thumbnailRequests.set(windowId, { resolve, timer });
            const sent = this.send({
                cmd: 'thumbnail',
                id: windowId,
                thumb_width: thumbWidth,
                thumb_height: thumbHeight
            });

            if (!sent) {
                clearTimeout(timer);
                this.thumbnailRequests.delete(windowId);
                resolve(null);
            }
        });
    }

    getCursorPosition() {
        return { x: this.cursorX, y: this.cursorY };
    }
}

module.exports = LabwcClient;
