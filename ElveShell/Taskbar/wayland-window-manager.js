// wayland-window-manager.js
// Native Wayland protocol listener for window management

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class WaylandWindowManager extends EventEmitter {
  constructor() {
    super();
    this.windows = new Map();
    this.compositor = null;
    this.protocol = null;
    this.listenerProcess = null;
    this.detectCompositor();
  }

  detectCompositor() {
    console.log('[WindowManager] Detecting compositor...');
    console.log('[WindowManager] XDG_SESSION_TYPE:', process.env.XDG_SESSION_TYPE);
    console.log('[WindowManager] XDG_CURRENT_DESKTOP:', process.env.XDG_CURRENT_DESKTOP);
    console.log('[WindowManager] WAYLAND_DISPLAY:', process.env.WAYLAND_DISPLAY);
    
    const currentDesktop = process.env.XDG_CURRENT_DESKTOP;
    
    if (currentDesktop && currentDesktop.includes('KDE')) {
      console.log('[WindowManager] Detected KDE compositor');
      this.compositor = 'kde';
      this.protocol = 'org_kde_kwin_window_management';
      this.initKDE();
    } else {
      console.log('[WindowManager] Using wlroots protocol');
      this.compositor = 'wlroots';
      this.protocol = 'wlr_foreign_toplevel_management';
      this.initWlroots();
    }

    console.log(`[WindowManager] Compositor: ${this.compositor}, Protocol: ${this.protocol}`);
  }

  initKDE() {
    console.log('[WindowManager] Initializing KDE window management...');
    
    // Check if our native listener exists
    const listenerPath = path.join(__dirname, 'wayland-listener');
    
    if (fs.existsSync(listenerPath)) {
      console.log('[WindowManager] Found native wayland-listener');
      this.startNativeListener(listenerPath, 'kde');
    } else {
      console.log('[WindowManager] Native listener not found, building...');
      this.buildNativeListener(() => {
        this.startNativeListener(listenerPath, 'kde');
      });
    }
  }

  initWlroots() {
    console.log('[WindowManager] Initializing wlroots window management...');
    
    const listenerPath = path.join(__dirname, 'wayland-listener');
    
    if (fs.existsSync(listenerPath)) {
      console.log('[WindowManager] Found native wayland-listener');
      this.startNativeListener(listenerPath, 'wlroots');
    } else {
      console.log('[WindowManager] Native listener not found, building...');
      this.buildNativeListener(() => {
        this.startNativeListener(listenerPath, 'wlroots');
      });
    }
  }

  buildNativeListener(callback) {
    console.log('[WindowManager] Building native Wayland listener...');
    
    // Create the build script
    const buildScript = path.join(__dirname, 'build-listener.sh');
    const buildContent = `#!/bin/bash
set -e

echo "Building Wayland listener..."

# Create source file
cat > wayland-listener.c << 'EOF'
${this.getNativeListenerCode()}
EOF

# Compile
gcc -o wayland-listener wayland-listener.c -lwayland-client -lwayland-cursor $(pkg-config --cflags --libs wayland-client)

echo "Build complete!"
`;

    fs.writeFileSync(buildScript, buildContent, { mode: 0o755 });
    
    const build = spawn('bash', [buildScript], {
      cwd: __dirname,
      stdio: 'inherit'
    });

    build.on('close', (code) => {
      if (code === 0) {
        console.log('[WindowManager] Build successful');
        callback();
      } else {
        console.error('[WindowManager] Build failed with code', code);
        console.log('[WindowManager] Falling back to DBus monitoring...');
        this.fallbackToDBus();
      }
    });
  }

  startNativeListener(listenerPath, mode) {
    console.log('[WindowManager] Starting native listener in', mode, 'mode');
    
    this.listenerProcess = spawn(listenerPath, [mode], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.listenerProcess.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        try {
          const event = JSON.parse(line);
          this.handleWaylandEvent(event);
        } catch (e) {
          console.log('[WindowManager] Listener output:', line);
        }
      });
    });

    this.listenerProcess.stderr.on('data', (data) => {
      console.error('[WindowManager] Listener error:', data.toString());
    });

    this.listenerProcess.on('close', (code) => {
      console.log('[WindowManager] Listener process exited with code', code);
      if (code !== 0) {
        console.log('[WindowManager] Falling back to DBus...');
        this.fallbackToDBus();
      }
    });

    this.listenerProcess.on('error', (err) => {
      console.error('[WindowManager] Failed to start listener:', err);
      console.log('[WindowManager] Falling back to DBus...');
      this.fallbackToDBus();
    });
  }

  handleWaylandEvent(event) {
    console.log('[WindowManager] Wayland event:', event);

    switch (event.type) {
      case 'window_added':
      case 'new_toplevel':
        const windowInfo = {
          id: event.handle || event.id,
          caption: event.title || '',
          appId: event.app_id || '',
          pid: event.pid || null,
          state: 'normal',
          icon: null,
          handle: event.handle
        };
        
        this.windows.set(windowInfo.id, windowInfo);
        console.log('[WindowManager] Window added:', windowInfo);
        this.emit('window-added', windowInfo);
        break;

      case 'title_changed':
        const titleWindow = this.windows.get(event.handle || event.id);
        if (titleWindow) {
          titleWindow.caption = event.title;
          this.emit('window-updated', titleWindow);
        }
        break;

      case 'app_id_changed':
        const appIdWindow = this.windows.get(event.handle || event.id);
        if (appIdWindow) {
          appIdWindow.appId = event.app_id;
          this.emit('window-updated', appIdWindow);
        }
        break;

      case 'window_closed':
      case 'closed':
        const closedWindow = this.windows.get(event.handle || event.id);
        if (closedWindow) {
          this.windows.delete(event.handle || event.id);
          console.log('[WindowManager] Window closed:', closedWindow);
          this.emit('window-removed', closedWindow);
        }
        break;

      case 'state_changed':
        const stateWindow = this.windows.get(event.handle || event.id);
        if (stateWindow) {
          stateWindow.state = event.state || 'normal';
          this.emit('window-updated', stateWindow);
        }
        break;
    }
  }

  fallbackToDBus() {
    console.log('[WindowManager] Using DBus fallback for KDE...');
    
    // Monitor DBus for KWin window events
    const monitor = spawn('dbus-monitor', [
      '--session',
      "type='signal',interface='org.kde.KWin',member='windowAdded'",
      "type='signal',interface='org.kde.KWin',member='windowRemoved'"
    ]);

    monitor.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[WindowManager] DBus output:', output);
      
      // Parse DBus messages
      if (output.includes('windowAdded')) {
        // Extract window info from DBus message
        // This is a simplified parser
        this.queryCurrentWindows();
      } else if (output.includes('windowRemoved')) {
        this.queryCurrentWindows();
      }
    });

    // Initial window query
    setTimeout(() => {
      this.queryCurrentWindows();
    }, 1000);

    // Poll for changes as backup
    setInterval(() => {
      this.queryCurrentWindows();
    }, 5000);
  }

  queryCurrentWindows() {
    console.log('[WindowManager] Querying current windows via DBus...');
    
    const query = spawn('qdbus', ['org.kde.KWin', '/KWin', 'org.kde.KWin.queryWindowInfo']);
    
    let output = '';
    query.stdout.on('data', (data) => {
      output += data.toString();
    });

    query.on('close', (code) => {
      if (code === 0 && output) {
        try {
          // Parse the window info
          console.log('[WindowManager] Window info:', output);
          
          // Try to extract window list from output
          const lines = output.split('\n');
          lines.forEach(line => {
            if (line.includes(':')) {
              const parts = line.split(':');
              const key = parts[0].trim();
              const value = parts[1] ? parts[1].trim() : '';
              
              if (key === 'caption' || key === 'resourceClass') {
                // Found a window property
              }
            }
          });
        } catch (e) {
          console.error('[WindowManager] Error parsing window info:', e);
        }
      }
    });
  }

  getNativeListenerCode() {
    return `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include <wayland-client-protocol.h>

// This will be replaced with actual protocol headers after building
// For now, this is a placeholder that shows the structure

static struct wl_display *display;
static struct wl_registry *registry;
static int running = 1;

// Output JSON events
void emit_event(const char *type, const char *handle, const char *title, const char *app_id) {
    printf("{\\"type\\":\\"%s\\"", type);
    if (handle) printf(",\\"handle\\":\\"%s\\"", handle);
    if (title) printf(",\\"title\\":\\"%s\\"", title);
    if (app_id) printf(",\\"app_id\\":\\"%s\\"", app_id);
    printf("}\\n");
    fflush(stdout);
}

// Placeholder for protocol bindings
// Real implementation needs proper protocol XMLs and code generation

static void registry_handler(void *data, struct wl_registry *registry,
                            uint32_t id, const char *iface, uint32_t version) {
    fprintf(stderr, "Found interface: %s\\n", iface);
}

static void registry_remover(void *data, struct wl_registry *registry, uint32_t id) {
    // Handle removed globals
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_handler,
    .global_remove = registry_remover
};

int main(int argc, char *argv[]) {
    const char *mode = argc > 1 ? argv[1] : "kde";
    fprintf(stderr, "Starting Wayland listener in %s mode\\n", mode);
    
    display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "Failed to connect to Wayland display\\n");
        return 1;
    }
    
    registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    
    wl_display_roundtrip(display);
    
    // Main event loop
    while (running && wl_display_dispatch(display) != -1) {
        // Process events
    }
    
    wl_display_disconnect(display);
    return 0;
}`;
  }

  // Window control methods
  activateWindow(windowId) {
    console.log('[WindowManager] Activating window:', windowId);
    
    if (this.listenerProcess) {
      // Send command to native listener
      this.listenerProcess.stdin.write(`activate ${windowId}\n`);
    }
  }

  minimizeWindow(windowId) {
    console.log('[WindowManager] Minimizing window:', windowId);
    
    if (this.listenerProcess) {
      this.listenerProcess.stdin.write(`minimize ${windowId}\n`);
    }
  }

  restoreWindow(windowId) {
    console.log('[WindowManager] Restoring window:', windowId);
    
    if (this.listenerProcess) {
      this.listenerProcess.stdin.write(`restore ${windowId}\n`);
    }
  }

  closeWindow(windowId) {
    console.log('[WindowManager] Closing window:', windowId);
    
    if (this.listenerProcess) {
      this.listenerProcess.stdin.write(`close ${windowId}\n`);
    }
  }

  async getWindowThumbnail(windowId) {
    return new Promise((resolve, reject) => {
      // Placeholder - implement screenshot functionality
      resolve('/icons/testWindow.png');
    });
  }

  getWindows() {
    return Array.from(this.windows.values());
  }

  destroy() {
    if (this.listenerProcess) {
      this.listenerProcess.kill();
    }
  }
}

module.exports = WaylandWindowManager;