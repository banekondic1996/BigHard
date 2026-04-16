// Install with: npm install @girs/node-gobject-2.0
const gi = require('@girs/node-gobject-2.0');

// Load Mutter introspection
const Meta = gi.require('Meta', '17'); // Your Mutter version
const Clutter = gi.require('Clutter', '17');
const GLib = gi.require('GLib', '2.0');

class CompositorBridge {
  constructor() {
    this.display = null;
    this.windows = new Map();
  }

  init() {
    // Get the global display from running Mutter
    this.display = Meta.Display.get_default();
    if (!this.display) throw new Error('Could not connect to Mutter display');

    // Connect to window-created signal
    this.display.connect('window-created', (_disp, window) => {
      this.onWindowCreated(window);
    });

    console.log('Connected to Mutter compositor!');
    alert('Connected to Mutter compositor!');
  }

  onWindowCreated(window) {
    const id = window.get_stable_sequence();
    this.windows.set(id, window);

    // Track unmanaged (closed) windows
    window.connect('unmanaged', () => this.windows.delete(id));

    // Track position/size changes
    window.connect('position-changed', () => { /* emit event if needed */ });
    window.connect('size-changed', () => { /* emit event if needed */ });
  }

  getWindows() {
    const windows = this.display.list_all_windows();
    return windows.map(win => {
      const rect = win.get_frame_rect();
      return {
        id: win.get_stable_sequence(),
        title: win.get_title(),
        wmClass: win.get_wm_class(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        isMaximized: win.is_maximized(),
        isMinimized: win.is_minimized(),
        isClientDecorated: win.is_client_decorated()
      };
    });
  }

  maximizeWindow(windowId) {
    const win = this.windows.get(windowId);
    if (win) win.maximize(Meta.MaximizeFlags.BOTH);
  }

  unmaximizeWindow(windowId) {
    const win = this.windows.get(windowId);
    if (win) win.unmaximize(Meta.MaximizeFlags.BOTH);
  }

  minimizeWindow(windowId) {
    const win = this.windows.get(windowId);
    if (win) win.minimize();
  }

  unminimizeWindow(windowId) {
    const win = this.windows.get(windowId);
    if (win) win.unminimize();
  }

  moveWindow(windowId, x, y) {
    const win = this.windows.get(windowId);
    if (win) win.move_frame(true, x, y);
  }

  resizeWindow(windowId, width, height) {
    const win = this.windows.get(windowId);
    if (win) {
      const rect = win.get_frame_rect();
      win.move_resize_frame(true, rect.x, rect.y, width, height);
    }
  }

  makeAbove(windowId) {
    const win = this.windows.get(windowId);
    if (win) win.make_above();
  }

  unmakeAbove(windowId) {
    const win = this.windows.get(windowId);
    if (win) win.unmake_above();
  }

  lowerWindow(windowId) {
    const win = this.windows.get(windowId);
    if (win) {
      win.lower();
      win.stick();
      win.set_skip_taskbar(true);
    }
  }

  getCursorPosition() {
    const backend = Clutter.get_default_backend();
    const seat = backend.get_default_seat();
    const [x, y] = seat.query_pointer();
    return { x, y };
  }

  hasCustomDecorations(windowId) {
    const win = this.windows.get(windowId);
    return win ? win.is_client_decorated() : false;
  }

  setStrut(top, bottom, left, right) {
    const shellWindow = this.findShellWindow();
    if (shellWindow) {
      shellWindow.set_skip_taskbar(true);
      shellWindow.stick();
      shellWindow.make_above();
    }
  }

  findShellWindow() {
    return Array.from(this.windows.values())
      .find(w => w.get_title()?.includes('Custom Desktop Shell'));
  }
}

module.exports = new CompositorBridge();
