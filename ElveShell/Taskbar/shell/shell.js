const compositor = require('./compositor');

class DesktopShell {
  constructor() {
    this.windows = [];
  }
  
  async init() {
    try {
      // Connect to Mutter via GObject Introspection
      compositor.init();
      console.log('Connected to Mutter!');
      
      // Set ourselves as bottom layer
      setTimeout(() => this.setupShellWindow(), 1000);
      
      // Start update loops
      this.updateCursor();
      this.updateTime();
      this.refreshWindows();
      
      setInterval(() => this.refreshWindows(), 1000);
      
    } catch (error) {
      console.error('Failed to initialize:', error);
      document.body.innerHTML = `
        <div style="color: red; padding: 20px;">
          <h1>Error connecting to Mutter</h1>
          <p>${error.message}</p>
          <p>Make sure Mutter is running with the js-shell plugin.</p>
        </div>
      `;
    }
  }
  
  setupShellWindow() {
    const windows = compositor.getWindows();
    const shellWin = windows.find(w => 
      w.title === 'Custom Desktop Shell' ||
      w.title.includes('index.html')
    );
    
    if (shellWin) {
      compositor.lowerWindow(shellWin.id);
      this.shellWindowId = shellWin.id;
    }
  }
  
  updateCursor() {
    try {
      const pos = compositor.getCursorPosition();
      document.getElementById('cursor-pos').textContent = 
        `x: ${pos.x}, y: ${pos.y}`;
    } catch (error) {
      // Ignore cursor errors
    }
    requestAnimationFrame(() => this.updateCursor());
  }
  
  updateTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    document.getElementById('time').textContent = timeStr;
    setTimeout(() => this.updateTime(), 1000);
  }
  
  refreshWindows() {
    try {
      this.windows = compositor.getWindows()
        .filter(w => w.id !== this.shellWindowId);
      this.renderWindowList();
    } catch (error) {
      console.error('Failed to get windows:', error);
    }
  }
  
  renderWindowList() {
    const list = document.getElementById('window-list');
    list.innerHTML = '';
    
    this.windows.forEach(win => {
      const button = document.createElement('div');
      button.className = 'window-button';
      
      // Show decoration type
      const icon = win.isClientDecorated ? '◆' : '▪';
      button.textContent = `${icon} ${win.title}`;
      button.title = win.isClientDecorated ? 
        'Client-side decorations' : 
        'Server-side decorations';
      
      button.onclick = () => this.focusWindow(win.id);
      button.oncontextmenu = (e) => {
        e.preventDefault();
        this.showWindowMenu(win, e.clientX, e.clientY);
      };
      
      list.appendChild(button);
    });
  }
  
  focusWindow(windowId) {
    // Focusing is automatic when clicking
  }
  
  showWindowMenu(win, x, y) {
    const menu = document.getElementById('context-menu');
    
    menu.innerHTML = `
      <div class="menu-item" onclick="shell.maximizeWindow(${win.id})">
        ${win.isMaximized ? 'Unmaximize' : 'Maximize'}
      </div>
      <div class="menu-item" onclick="shell.minimizeWindow(${win.id})">
        Minimize
      </div>
      <div class="menu-separator"></div>
      <div class="menu-item" onclick="shell.makeAbove(${win.id})">
        Always on Top
      </div>
      <div class="menu-item" onclick="shell.unmakeAbove(${win.id})">
        Remove Always on Top
      </div>
      <div class="menu-separator"></div>
      <div class="menu-item disabled">
        ${win.isClientDecorated ? '◆ Custom Titlebar' : '▪ System Titlebar'}
      </div>
    `;
    
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.add('visible');
    
    setTimeout(() => {
      document.addEventListener('click', () => {
        menu.classList.remove('visible');
      }, { once: true });
    }, 100);
  }
  
  maximizeWindow(windowId) {
    const win = this.windows.find(w => w.id === windowId);
    if (win) {
      if (win.isMaximized) {
        compositor.unmaximizeWindow(windowId);
      } else {
        compositor.maximizeWindow(windowId);
      }
      setTimeout(() => this.refreshWindows(), 100);
    }
  }
  
  minimizeWindow(windowId) {
    compositor.minimizeWindow(windowId);
    setTimeout(() => this.refreshWindows(), 100);
  }
  
  makeAbove(windowId) {
    compositor.makeAbove(windowId);
  }
  
  unmakeAbove(windowId) {
    compositor.unmakeAbove(windowId);
  }
}

// Initialize shell
const shell = new DesktopShell();
shell.init();