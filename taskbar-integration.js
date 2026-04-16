// taskbar-integration.js
// Direct integration with labwc via our custom IPC

console.log('[Taskbar] Loading labwc taskbar integration...');

const LabwcClient = require('./labwc-client');
const IconPreviewManager = require('./icon-preview-manager');
const path = require('path');
const fs = require('fs');

// Initialize the labwc client
console.log('[Taskbar] Initializing labwc client...');
const client = new LabwcClient();

// Initialize icon and preview manager
console.log('[Taskbar] Initializing icon manager...');
const iconManager = new IconPreviewManager();

// Store window-to-taskbar mapping
const windowToTaskbarMap = new Map();
const appIdToButtonMap = new Map();

// Connect to labwc compositor
client.connect();

console.log('[Taskbar] Environment:');
console.log('  XDG_SESSION_TYPE:', process.env.XDG_SESSION_TYPE);
console.log('  WAYLAND_DISPLAY:', process.env.WAYLAND_DISPLAY);

// Handle connection events
client.on('connected', () => {
  console.log('[Taskbar] ✓ Connected to labwc compositor');
  // Request initial window list
  client.send({ cmd: 'list' });
});

client.on('disconnected', () => {
  console.warn('[Taskbar] ✗ Disconnected from labwc compositor');
});

client.on('error', (err) => {
  console.error('[Taskbar] Connection error:', err.message);
});

// Handle window list (initial load)
client.on('window_list', (windows) => {
  console.log('[Taskbar] Received window list:', windows.length, 'windows');
  
  // Clear existing taskbar
  const barElement = document.getElementById('barAppsID');
  if (barElement) {
    barElement.innerHTML = '';
    windowToTaskbarMap.clear();
    appIdToButtonMap.clear();
  }
  
  // Add ALL windows (including minimized)
  windows.forEach(window => {
    addWindowToTaskbar(window);
  });
});

// Handle new windows
client.on('window_created', (window) => {
  console.log('[Taskbar] New window created:', window.title || window.app_id);
  addWindowToTaskbar(window);
});

client.on('mapped', (window) => {
  console.log('[Taskbar] Window mapped:', window.title || window.app_id);
  addWindowToTaskbar(window);
});

// Handle closed windows
client.on('window_closed', (window) => {
  console.log('[Taskbar] Window closed:', window.id);
  removeWindowFromTaskbar(window);
});

client.on('unmapped', (window) => {
  console.log('[Taskbar] Window unmapped:', window.id);
  //removeWindowFromTaskbar(window);
});

// Handle window state changes
client.on('window_state_changed', (window) => {
  console.log('[Taskbar] Window state changed:', window.id, {
    minimized: window.minimized,
    maximized: window.maximized,
    focused: window.focused
  });
  
  updateWindowState(window);
});

client.on('window_focused', (window) => {
  console.log('[Taskbar] Window focused:', window.id);
  updateWindowFocus(window.id);
});

client.on('window_title_changed', (window) => {
  console.log('[Taskbar] Window title changed:', window.title);
  updateWindowTitle(window);
});

// Add window to taskbar
async function addWindowToTaskbar(windowInfo) {
  console.log('[Taskbar] Adding window to taskbar:', {
    id: windowInfo.id,
    title: windowInfo.title,
    app_id: windowInfo.app_id,
    minimized: windowInfo.minimized,
    pid: windowInfo.pid
  });
  
  const barElement = document.getElementById('barAppsID');
  
  if (!barElement) {
    console.error('[Taskbar] barAppsID element not found!');
    return;
  }
  
  // Check if button already exists for this app
  const appId = windowInfo.app_id || 'unknown';
  let button = appIdToButtonMap.get(appId);
  
  if (button) {
    console.log('[Taskbar] App button already exists, adding thumbnail');
    await addThumbnailToButton(button, windowInfo);
  } else {
    // Get real icon
    const icon = await iconManager.getIconForApp(appId, windowInfo.pid);
    console.log('[Taskbar] Creating new button with icon:', icon);
    
    button = await createTaskbarButton(windowInfo, icon);
    barElement.appendChild(button);
    
    appIdToButtonMap.set(appId, button);
    console.log('[Taskbar] Button added, total apps:', appIdToButtonMap.size);
  }
  
  windowToTaskbarMap.set(windowInfo.id, button);
  
  // Update state immediately
  updateWindowState(windowInfo);
}

// Create taskbar button element
function createTaskbarButton(windowInfo, icon) {
  const button = document.createElement('div');
  button.className = 'taskbutton color darkMode';
  button.dataset.appId = windowInfo.app_id || 'unknown';
  button.dataset.windowId = windowInfo.id;
  button.title = windowInfo.title || windowInfo.app_id || 'Window';
  
  // Create thumbnail container
  const thumbContainer = document.createElement('div');
  thumbContainer.className = 'appThumb hide darkMode';
  thumbContainer.style.cssText = `
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(30, 30, 30, 0.95);
    backdrop-filter: blur(20px);
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    min-width: 150px;
  `;
  
  button.appendChild(thumbContainer);
  
  // Create main icon
  const mainIcon = document.createElement('img');
  mainIcon.src = icon;
  mainIcon.className = 'darkMode';
  mainIcon.dataset.windowId = windowInfo.id;
  mainIcon.style.cssText = 'height: 100%; width: 100%; object-fit: contain;';
  mainIcon.onclick = () => handleWindowClick(windowInfo.id);
  
  button.appendChild(mainIcon);
  
  // Add hover events
  button.onmouseenter = function(e) {
    const thumb = this.querySelector('.appThumb');
    if (thumb && thumb.children.length > 0) {
      thumb.classList.remove('hide');
    }
  };
  
  button.onmouseleave = function() {
    const thumb = this.querySelector('.appThumb');
    if (thumb) {
      thumb.classList.add('hide');
    }
  };
  
  // Add first thumbnail
  addThumbnailToButton(button, windowInfo);
  
  return button;
}

// Add thumbnail to existing button
function addThumbnailToButton(button, windowInfo) {
  const thumbContainer = button.querySelector('.appThumb');
  if (!thumbContainer) return;
  
  const icon = getIconForApp(windowInfo.app_id || 'unknown');
  
  const thumbItem = document.createElement('div');
  thumbItem.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
    margin: 2px 0;
  `;
  thumbItem.dataset.windowId = windowInfo.id;
  
  thumbItem.onmouseenter = function() {
    this.style.background = 'rgba(255, 255, 255, 0.1)';
  };
  
  thumbItem.onmouseleave = function() {
    this.style.background = 'transparent';
  };
  
  thumbItem.onclick = () => handleWindowClick(windowInfo.id);
  
  const thumbIcon = document.createElement('img');
  thumbIcon.src = icon;
  thumbIcon.style.cssText = 'width: 24px; height: 24px; object-fit: contain;';
  
  const thumbText = document.createElement('span');
  thumbText.textContent = windowInfo.title || windowInfo.app_id || 'Window';
  thumbText.style.cssText = `
    color: #fff;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 150px;
  `;
  
  thumbItem.appendChild(thumbIcon);
  thumbItem.appendChild(thumbText);
  thumbContainer.appendChild(thumbItem);
}

// Remove window from taskbar
function removeWindowFromTaskbar(windowInfo) {
  console.log('[Taskbar] Removing window from taskbar:', windowInfo.id);
  
  const button = windowToTaskbarMap.get(windowInfo.id);
  
  if (!button) {
    console.warn('[Taskbar] Window button not found:', windowInfo.id);
    return;
  }
  
  // Clear preview cache
  iconManager.clearPreview(windowInfo.id);
  
  // Remove thumbnail for this specific window
  const thumbContainer = button.querySelector('.appThumb');
  if (thumbContainer) {
    const thumbItem = thumbContainer.querySelector(`[data-window-id="${windowInfo.id}"]`);
    if (thumbItem) {
      thumbItem.remove();
    }
    
    // If no more thumbnails, remove the entire button
    if (thumbContainer.children.length === 0) {
      const appId = button.dataset.appId;
      button.remove();
      appIdToButtonMap.delete(appId);
      console.log('[Taskbar] Button removed, remaining apps:', appIdToButtonMap.size);
    }
  }
  
  windowToTaskbarMap.delete(windowInfo.id);
}

// Update window state
function updateWindowState(windowInfo) {
  const button = windowToTaskbarMap.get(windowInfo.id);
  if (!button) return;
  
  // Update focused state
  if (windowInfo.focused) {
    button.classList.add('active');
  } else {
    button.classList.remove('active');
  }
  
  // Handle minimized state
  if (windowInfo.minimized) {
    button.style.opacity = '0.5';
  } else {
    button.style.opacity = '1';
  }
}

// Update focus state
function updateWindowFocus(focusedWindowId) {
  // Remove active class from all buttons
  windowToTaskbarMap.forEach((button, windowId) => {
    if (windowId === focusedWindowId) {
      button.classList.add('active');
    } else {
      button.classList.remove('active');
    }
  });
}

// Update window title
function updateWindowTitle(windowInfo) {
  const button = windowToTaskbarMap.get(windowInfo.id);
  if (!button) return;
  
  button.title = windowInfo.title || windowInfo.app_id || 'Window';
  
  // Update thumbnail text
  const thumbContainer = button.querySelector('.appThumb');
  if (thumbContainer) {
    const thumbItem = thumbContainer.querySelector(`[data-window-id="${windowInfo.id}"]`);
    if (thumbItem) {
      const thumbText = thumbItem.querySelector('span');
      if (thumbText) {
        thumbText.textContent = windowInfo.title || windowInfo.app_id || 'Window';
      }
    }
  }
}

// Handle window click
function handleWindowClick(windowId) {
  console.log('[Taskbar] Window clicked:', windowId);
  
  const windows = client.getWindows();
  const window = windows.find(w => w.id === windowId);
  
  if (!window) {
    console.warn('[Taskbar] Window not found:', windowId);
    return;
  }
  
  console.log('[Taskbar] Window state:', {
    focused: window.focused,
    minimized: window.minimized
  });
  
  if (window.focused && !window.minimized) {
    // Window is focused - minimize it
    console.log('[Taskbar] Minimizing focused window');
    client.minimizeWindow(windowId);
  } else if (window.minimized) {
    // Window is minimized - restore and focus
    console.log('[Taskbar] Restoring minimized window');
    client.minimizeWindow(windowId); // Toggle minimize
    client.focusWindow(windowId);
  } else {
    // Window is not focused - focus it
    console.log('[Taskbar] Focusing window');
    client.focusWindow(windowId);
  }
}

// Get icon for application (fallback only)
async function getIconForApp(appId) {
  // This is now handled by iconManager
  return await iconManager.getIconForApp(appId, null);
}

// Initialize on load
console.log('[Taskbar] Setting up initialization...');

function initialize() {
  console.log('[Taskbar] Initialize called');
  
  const barElement = document.getElementById('barAppsID');
  if (!barElement) {
    console.error('[Taskbar] barAppsID element not found! Retrying in 1 second...');
    setTimeout(initialize, 1000);
    return;
  }
  
  console.log('[Taskbar] ✓ barAppsID element found');
  console.log('[Taskbar] Waiting for labwc connection...');
  
  // The window list will be populated via the 'window_list' event
  // when the connection is established
}

if (document.readyState === 'loading') {
  console.log('[Taskbar] Document loading, adding event listener');
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  console.log('[Taskbar] Document ready, initializing now');
  initialize();
}

// Global helper functions for compatibility
window.handleWindowClickGlobal = handleWindowClick;

window.showORhideAPP = function(windowId) {
  handleWindowClick(windowId);
};

// Manual test function
window.testTaskbar = function() {
  console.log('[Taskbar] TEST: Current state:');
  console.log('  Connected:', client.socket ? 'yes' : 'no');
  console.log('  Windows:', client.windows.size);
  console.log('  Buttons:', appIdToButtonMap.size);
  
  client.windows.forEach((win, id) => {
    console.log(`    ${id}: ${win.title || win.app_id}`);
  });
};

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  console.log('[Taskbar] Cleaning up...');
  client.disconnect();
  iconManager.clearAllCaches();
});

console.log('[Taskbar] Integration script loaded');

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    client,
    iconManager,
    handleWindowClick,
    testTaskbar: window.testTaskbar
  };
}