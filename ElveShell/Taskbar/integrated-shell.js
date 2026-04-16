// integrated-shell.js
// Integrates compositor IPC with your taskbar shell

const createCompositorBackend = require('./compositor-backend');
const path = require('path');
const fs = require('fs');
//const { exec } = require('child_process');

console.log('[Shell] Initializing integrated shell...');

const labwcClient = createCompositorBackend();
const barAppsElement  = document.getElementById('barAppsID');
const trayIconsElement = document.getElementById('trayIconsID');

const windowButtons = new Map();   // windowId → button element
const windowStates  = new Map();   // windowId → { minimized, focused, appId }
const trayRegistry  = new Map();   // trayId   → { name, icon, visible, onClick }
const appGroups     = new Map();   // appId → { pinnedButton, windowIds: Set, groupElement }

let desktopFileCache = {};

// ─── Persistence ─────────────────────────────────────────────────────────────
const dataDir     = nw.App.dataPath;
const pinnedFile  = path.join(dataDir, 'pinned_apps.json');
const trayVisFile = path.join(dataDir, 'tray_visibility.json');
const sortOrderFile = path.join(dataDir, 'taskbar_order.json');

function readJSON(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return def; }
}
function writeJSON(file, obj) {
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch(e) {}
}

pinnedApps = readJSON(pinnedFile,  []);
let trayVis    = readJSON(trayVisFile, {});
let taskbarOrder = readJSON(sortOrderFile, []);

const SHELL_WINDOW_KEYS = new Set([
    'top',
    'desk',
    'elve',
    'elve desktop',
    'elve desktop1',
    'elve-desktop'
]);

function normalizeAppKey(raw) {
    if (!raw) return 'unknown';
    let key = String(raw).trim().toLowerCase();
    key = key.split(' ')[0];
    key = key.split('/').pop();
    key = key.replace(/\.desktop$/i, '').replace(/\.sh$/i, '');
    key = key.replace(/^flatpak:/, '');
    key = key.replace(/^org\.(kde|gnome|freedesktop)\./, '');
    const parts = key.split('.');
    if (parts.length > 1) {
        key = parts[parts.length - 1];
    }
    return key || 'unknown';
}

function isShellWindow(window) {
    if (!window) return false;
    const candidates = [
        window.app_id,
        window.appId,
        window.title,
        window.class,
        window.role
    ];
    return candidates.some((value) => {
        const key = normalizeAppKey(value);
        return SHELL_WINDOW_KEYS.has(key);
    });
}

function getPinnedIdentity(pinnedApp) {
    if (!pinnedApp) return '';
    return pinnedApp.desktopFile
        || pinnedApp.appId
        || (pinnedApp.exec ? pinnedApp.exec.split(' ')[0] : '')
        || pinnedApp.name
        || '';
}

function findPinnedIndexForApp(appId) {
    const appKey = normalizeAppKey(appId);
    return pinnedApps.findIndex((pinnedApp) => {
        const pinnedKey = normalizeAppKey(getPinnedIdentity(pinnedApp));
        return pinnedKey === appKey;
    });
}

function isPinnedApp(appId) {
    return findPinnedIndexForApp(appId) !== -1;
}

function savePinned()  { writeJSON(pinnedFile,   pinnedApps); }
function saveTrayVis() { writeJSON(trayVisFile,  trayVis);   }
function saveTaskbarOrder() { 
    // Save current order of buttons
    const order = Array.from(barAppsElement.children).map(el => {
        return el.dataset.appId || el.dataset.windowId || el.dataset.pinnedId;
    }).filter(Boolean);
    writeJSON(sortOrderFile, order);
}

// ─── Connect ──────────────────────────────────────────────────────────────────
labwcClient.connect();

labwcClient.on('connected', () => {
    console.log('[Shell] Connected to compositor backend:', labwcClient.name || 'unknown');
    scanDesktopFiles();
    renderPinnedApps();
    renderTrayIcons();
});

labwcClient.on('disconnected', () => {
    console.log('[Shell] Disconnected from compositor backend:', labwcClient.name || 'unknown');
});

labwcClient.on('window_list', (windows) => {
    refreshTaskbar(windows);
});

labwcClient.on('window_created', (window) => {
    addWindowToTaskbar(window);
});

labwcClient.on('window_closed', (window) => {
    console.log('[Shell] Window closed:', window.id);
    // Wait a bit to ensure the window is fully gone
    setTimeout(() => {
        removeWindowFromTaskbar(window.id);
    }, 50);
});

labwcClient.on('unmapped', (window) => {
    console.log('[Shell] Window unmapped:', window.id);
    const state = windowStates.get(window.id);
    if (state) {
        state.minimized = true;
        windowStates.set(window.id, state);
        applyButtonState(window.id);
    }
});

labwcClient.on('window_title_changed', (w) => updateWindowTitle(w.id, w.title));
labwcClient.on('title_changed',        (w) => updateWindowTitle(w.id, w.title));
labwcClient.on('window_focused',       (w) => updateActiveWindow(w.id));
labwcClient.on('focused',              (w) => updateActiveWindow(w.id));
labwcClient.on('window_state_changed', (w) => updateWindowState(w.id, w));

labwcClient.on('minimized', (w) => {
    const state = windowStates.get(w.id);
    if (state) {
        state.minimized = w.minimized !== undefined ? w.minimized : true;
        windowStates.set(w.id, state);
        applyButtonState(w.id);
    }
});

labwcClient.on('maximized', (w) => {
    const state = windowStates.get(w.id);
    if (state) {
        state.minimized = false;
        windowStates.set(w.id, state);
        applyButtonState(w.id);
    }
    // Re-focus so it rises above the shell
    setTimeout(() => labwcClient.focusWindow(w.id), 80);
});

labwcClient.on('moved', () => {});
labwcClient.on('cursor', ({ x, y }) => updateCursorDisplay(x, y));

// ─── Thumbnail shared state (INSTANT SWITCH) ──────────────────────────────────
let currentThumbId       = null;
let thumbHideTimer       = null;
let activeThumbContainer = null;

function showThumb(windowId, thumbContainer, thumbTitle, thumbPreview) {
    // INSTANT SWITCH: Immediately hide previous thumbnail without delay
    if (activeThumbContainer && activeThumbContainer !== thumbContainer) {
        activeThumbContainer.classList.add('hide');
    }
    
    // Clear any pending hide timer
    clearTimeout(thumbHideTimer);
    thumbHideTimer = null;

    currentThumbId       = windowId;
    activeThumbContainer = thumbContainer;

    const winData = labwcClient.windows.get(windowId);
    thumbTitle.textContent = (winData && winData.title) || windowId;
    thumbContainer.classList.remove('hide');
    
    // Show placeholder for now (implement thumbnail in labwc-ipc later)
    displayPlaceholder(thumbPreview, winData);
}

function scheduleHideThumb(thumbContainer) {
    thumbHideTimer = setTimeout(() => {
        thumbContainer.classList.add('hide');
        currentThumbId       = null;
        activeThumbContainer = null;
    }, 400);
}

// ─── Desktop file / icon scanning ────────────────────────────────────────────
function scanDesktopFiles() {
    const dirs = [
        '/usr/share/applications',
        '/usr/local/share/applications',
        path.join(process.env.HOME, '.local/share/applications')
    ];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) return;
        try {
            fs.readdirSync(dir).forEach(f => {
                if (!f.endsWith('.desktop')) return;
                const info = parseDesktopFile(path.join(dir, f));
                if (info) desktopFileCache[info.id] = info;
            });
        } catch(e) {}
    });
    console.log('[Shell] Cached', Object.keys(desktopFileCache).length, 'desktop files');
}

function parseDesktopFile(filePath) {
    try {
        const info = { id: path.basename(filePath, '.desktop'), name:'', icon:'', exec:'' };
        let inEntry = false;
        for (let line of fs.readFileSync(filePath, 'utf8').split('\n')) {
            line = line.trim();
            if (line === '[Desktop Entry]')      { inEntry = true; continue; }
            if (line.startsWith('[') && inEntry) break;
            if (!inEntry) continue;
            if (line.startsWith('Name=') && !line.startsWith('Name[')) info.name = line.slice(5);
            else if (line.startsWith('Icon='))  info.icon = line.slice(5);
            else if (line.startsWith('Exec='))  info.exec = line.slice(5);
        }
        if (info.icon) { const p = findIconPath(info.icon); if (p) info.iconPath = p; }
        return info;
    } catch(e) { return null; }
}

function findIconPath(iconName) {
    if (!iconName) return null;
    if (iconName.startsWith('/') && fs.existsSync(iconName)) return iconName;
    const base = iconName.replace(/\.(png|svg|xpm)$/, '');
    const sizes = ['48x48','64x64','128x128','scalable','32x32','256x256'];
    const exts  = ['.png','.svg','.xpm'];
    const themes = [
        '/usr/share/icons/hicolor',
        '/usr/share/icons/breeze',
        '/usr/share/icons/breeze-dark',
        '/usr/share/icons/oxygen',
        '/usr/share/icons/Papirus',
        '/usr/share/icons/Papirus-Dark',
        '/usr/share/icons/gnome',
        '/usr/share/icons/Adwaita',
        '/usr/share/pixmaps',
        path.join(process.env.HOME, '.local/share/icons'),
        path.join(process.env.HOME, '.icons')
    ];
    
    // First try: exact match in pixmaps
    for (const ext of exts) { 
        const p = '/usr/share/pixmaps/' + base + ext; 
        if (fs.existsSync(p)) return p; 
    }
    
    for (const t of themes) {
        if (!fs.existsSync(t)) continue;
        
        // Try direct match
        for (const ext of exts) { 
            const p = path.join(t, base + ext); 
            if (fs.existsSync(p)) return p; 
        }
        
        // Try in size/category directories
        for (const sz of sizes) {
            for (const cat of ['apps','applications','mimetypes','categories','actions']) {
                for (const ext of exts) { 
                    const p = path.join(t, sz, cat, base + ext); 
                    if (fs.existsSync(p)) return p; 
                }
            }
        }
    }
    return null;
}

function getIconForApp(appId) {
    if (!appId) return '/icons/testWindow.png';
    if (desktopFileCache[appId]?.iconPath) return desktopFileCache[appId].iconPath;
    const simple = appId.split('.').pop();
    const lower  = appId.toLowerCase();
    for (const [id, info] of Object.entries(desktopFileCache)) {
        if ((id.toLowerCase().includes(lower) || lower.includes(id.toLowerCase()) ||
             simple.toLowerCase() === id.split('.').pop().toLowerCase()) && info.iconPath && fs.existsSync(info.iconPath))
            return info.iconPath;
    }
    for (const v of [appId, simple, appId.toLowerCase(), simple.toLowerCase(),
                     appId.replace('org.kde.',''), appId.replace('org.gnome.','')]) {
        const p = findIconPath(v); if (p) return p;
    }
    return '/icons/testWindow.png';
}

// Always use file:// for absolute paths
function iconSrc(p) {
    if (!p) return '/icons/testWindow.png';
    return p.startsWith('/') ? 'file://' + p : p;
}

function launchAppDescriptor(app) {
    if (!app) return;

    const desktopId = String(app.desktopFile || app.appId || '').trim();
    const execLine = String(app.exec || '').trim();
    const extraArgs = String(app.args || '').trim();

    if (desktopId) {
        const cmd = `gtk-launch "${desktopId.replace(/"/g, '\\"')}"`;
        exec(cmd, (gtkErr) => {
            if (!gtkErr) return;
            if (!execLine) {
                console.error('[Shell] gtk-launch failed:', gtkErr.message);
                return;
            }
            let fallback = execLine.replace(/%[fFuUdDnNickvm]/g, '').trim();
            if (extraArgs) fallback += ' ' + extraArgs;
            exec(fallback, (fallbackErr, stdout, stderr) => {
                if (fallbackErr) {
                    console.error('[Shell] Launch fallback error:', fallbackErr.message);
                    if (stderr) console.error('[Shell] stderr:', stderr);
                }
            });
        });
        return;
    }

    if (!execLine) return;
    let command = execLine.replace(/%[fFuUdDnNickvm]/g, '').trim();
    if (extraArgs) command += ' ' + extraArgs;
    exec(command, (err, stdout, stderr) => {
        if (err) {
            console.error('[Shell] Launch error:', err.message);
            if (stderr) console.error('[Shell] stderr:', stderr);
        }
    });
}

function requestAndRenderThumbnail(windowId, previewElement, winData) {
    displayPlaceholder(previewElement, winData);
    labwcClient.requestThumbnail(windowId, { width: 200, height: 120 })
        .then((thumbPath) => {
            if (!thumbPath || !previewElement.isConnected) {
                return;
            }
            const img = document.createElement('img');
            img.src = iconSrc(thumbPath) + '?t=' + Date.now();
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:4px';
            img.onerror = () => displayPlaceholder(previewElement, winData);
            previewElement.innerHTML = '';
            previewElement.appendChild(img);
        })
        .catch(() => {
            displayPlaceholder(previewElement, winData);
        });
}

// ─── App Grouping Logic ───────────────────────────────────────────────────────
function getOrCreateGroupElement(appId, iconPath) {
    // First check if any existing group matches this appId
    for (const [existingAppId, group] of appGroups.entries()) {
        const existingClean = normalizeAppKey(existingAppId);
        const newClean = normalizeAppKey(appId);
        
        if (existingAppId === appId || existingClean === newClean) {
            console.log('[Shell] Using existing group:', existingAppId, 'for', appId);
            return group;
        }
    }
    
    if (!appGroups.has(appId)) {
        appGroups.set(appId, { 
            pinnedButton: null, 
            windowIds: new Set(), 
            groupElement: null 
        });
    }
    
    const group = appGroups.get(appId);
    
    if (!group.groupElement) {
        const groupEl = document.createElement('div');
        groupEl.className = 'taskbutton color darkMode app-group';
        groupEl.dataset.appId = appId;
        groupEl.style.cssText = 'cursor:pointer;position:relative';
        
        // Main icon
        const img = document.createElement('img');
        img.src = iconSrc(iconPath || getIconForApp(appId));
        img.className = 'darkMode';
        img.style.cssText = 'height:100%;width:100%;object-fit:contain';
        img.onerror = () => { img.src = '/icons/testWindow.png'; };
        
        // Window count indicator
        const indicator = document.createElement('div');
        indicator.className = 'window-count-indicator';
        indicator.style.cssText = 'position:absolute;bottom:2px;right:2px;background:rgba(59,130,246,0.9);color:white;font-size:9px;padding:1px 4px;border-radius:3px;display:none';
        
        groupEl.append(img, indicator);
        group.groupElement = groupEl;
        
        // Insert in correct position (after pinned, or at end)
        insertGroupElementInOrder(groupEl, appId);
    }
    
    return group;
}

function insertGroupElementInOrder(groupEl, appId) {
    // Check if this app is pinned
    const pinnedIndex = findPinnedIndexForApp(appId);
    
    if (pinnedIndex !== -1) {
        // Insert at pinned position
        const pinnedButtons = Array.from(barAppsElement.querySelectorAll('.pinned-app-btn'));
        if (pinnedButtons[pinnedIndex]) {
            barAppsElement.insertBefore(groupEl, pinnedButtons[pinnedIndex]);
            pinnedButtons[pinnedIndex].remove(); // Remove the old pinned button
        } else {
            barAppsElement.appendChild(groupEl);
        }
    } else {
        // Insert at end (after all pinned apps)
        barAppsElement.appendChild(groupEl);
    }
}

function updateGroupIndicator(appId) {
    const group = appGroups.get(appId);
    if (!group || !group.groupElement) return;
    
    const count = group.windowIds.size;
    const indicator = group.groupElement.querySelector('.window-count-indicator');
    
    if (count > 1) {
        indicator.textContent = count;
        indicator.style.display = 'block';
    } else {
        indicator.style.display = 'none';
    }
}

function createGroupThumbnail(appId) {
    const group = appGroups.get(appId);
    if (!group || !group.groupElement) return;
    
    // Remove old thumbnail if exists
    const oldThumb = group.groupElement.querySelector('.group-appThumb');
    if (oldThumb) oldThumb.remove();
    
    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'group-appThumb hide darkMode';
    Object.assign(thumbContainer.style, {
        position:'absolute', bottom:'100%', left:'50%',
        transform:'translateX(-50%)', marginBottom:'10px',
        background:'rgba(30,30,30,0.95)',
        border:'1px solid rgba(255,255,255,0.2)',
        borderRadius:'8px', padding:'8px',
        minWidth:'220px', zIndex:'100000',
        maxHeight:'400px', overflowY:'auto'
    });
    
    // Add all windows in this group
    group.windowIds.forEach(windowId => {
        const winData = labwcClient.windows.get(windowId);
        if (!winData) return;
        
        const winThumb = document.createElement('div');
        winThumb.style.cssText = 'padding:6px;margin:4px 0;background:rgba(255,255,255,0.05);border-radius:6px;cursor:pointer;transition:background 0.15s';
        winThumb.onmouseenter = () => { winThumb.style.background = 'rgba(255,255,255,0.12)'; };
        winThumb.onmouseleave = () => { winThumb.style.background = 'rgba(255,255,255,0.05)'; };
        winThumb.onclick = (e) => {
            e.stopPropagation();
            const state = windowStates.get(windowId);
            if (state && state.minimized) labwcClient.focusWindow(windowId);
            else labwcClient.focusWindow(windowId);
            thumbContainer.classList.add('hide');
        };
        
        const title = document.createElement('div');
        title.style.cssText = 'color:white;font-size:11px;margin-bottom:6px;font-weight:500';
        title.textContent = winData.title || 'Window';
        
        const preview = document.createElement('div');
        Object.assign(preview.style, {
            width:'200px', height:'120px',
            background:'rgba(255,255,255,0.05)', borderRadius:'4px',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'rgba(255,255,255,0.3)', overflow:'hidden'
        });
        
        requestAndRenderThumbnail(windowId, preview, winData);
        
        winThumb.append(title, preview);
        thumbContainer.appendChild(winThumb);
    });
    
    group.groupElement.appendChild(thumbContainer);
    
    // Setup hover handlers
    group.groupElement.onmouseenter = () => {
        clearTimeout(thumbHideTimer);
        if (activeThumbContainer && activeThumbContainer !== thumbContainer) {
            activeThumbContainer.classList.add('hide');
        }
        activeThumbContainer = thumbContainer;
        thumbContainer.classList.remove('hide');
    };
    
    group.groupElement.onmouseleave = () => {
        scheduleHideThumb(thumbContainer);
    };
    
    thumbContainer.onmouseenter = () => { clearTimeout(thumbHideTimer); };
    thumbContainer.onmouseleave = () => { scheduleHideThumb(thumbContainer); };
    
    // Click handler
    group.groupElement.onclick = (e) => {
        if (e.target.closest('.group-appThumb')) return; // Clicking inside thumbnail
        
        if (group.windowIds.size === 1) {
            // Single window - focus or minimize
            const windowId = Array.from(group.windowIds)[0];
            const state = windowStates.get(windowId);
            if (state && state.minimized) labwcClient.focusWindow(windowId);
            else if (state && state.focused) labwcClient.minimizeWindow(windowId);
            else labwcClient.focusWindow(windowId);
        } else {
            // Multiple windows - show thumbnail picker
            thumbContainer.classList.toggle('hide');
        }
    };
    
    // Context menu
    group.groupElement.oncontextmenu = (e) => {
        e.preventDefault();
        showGroupContextMenu(e, appId);
    };
}

// ─── Add window to taskbar (with grouping) ────────────────────────────────────
function addWindowToTaskbar(window) {
    if (isShellWindow(window)) return;
    if (windowButtons.has(window.id)) return;
    
    const appId = window.app_id || 'unknown';
    
    // Find matching pinned app and use its ID for grouping
    let groupId = appId;
    const pinnedIndex = findPinnedIndexForApp(appId);
    if (pinnedIndex !== -1) {
        groupId = getPinnedIdentity(pinnedApps[pinnedIndex]) || appId;
        console.log('[Shell] ✓ Matched', appId, '→', groupId);
    }
    
    // Store the groupId in window state
    windowStates.set(window.id, { minimized: false, focused: false, appId: groupId });
    
    const iconPath = getIconForApp(appId);
    const group = getOrCreateGroupElement(groupId, iconPath);
    
    group.windowIds.add(window.id);
    windowButtons.set(window.id, group.groupElement);
    
    updateGroupIndicator(groupId);
    createGroupThumbnail(groupId);
    applyGroupState(groupId);
}

function displayPlaceholder(previewElement, winData) {
    previewElement.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:rgba(255,255,255,0.4);font-size:11px;padding:12px;text-align:center';
    
    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:24px;opacity:0.5';
    icon.textContent = '🖼️';
    
    const text = document.createElement('div');
    text.textContent = 'Window preview';
    
    const info = document.createElement('div');
    info.style.cssText = 'font-size:9px;opacity:0.6;margin-top:4px';
    if (winData) {
        info.textContent = `${winData.width || 0}×${winData.height || 0}`;
    }
    
    placeholder.appendChild(icon);
    placeholder.appendChild(text);
    if (winData && winData.width) {
        placeholder.appendChild(info);
    }
    
    previewElement.appendChild(placeholder);
}

// ─── Remove / state ───────────────────────────────────────────────────────────
function removeWindowFromTaskbar(windowId) {
    const state = windowStates.get(windowId);
    if (!state) return;
    
    const appId = state.appId;
    const group = appGroups.get(appId);
    
    if (group) {
        group.windowIds.delete(windowId);
        
        if (group.windowIds.size === 0) {
            // No more windows - check if pinned
            const isPinned = isPinnedApp(appId);
            
            if (!isPinned && group.groupElement) {
                // Remove group completely
                group.groupElement.remove();
                appGroups.delete(appId);
            } else if (isPinned) {
                // Convert back to pinned button
                const pinnedIndex = findPinnedIndexForApp(appId);
                if (pinnedIndex !== -1) {
                    createPinnedButton(pinnedApps[pinnedIndex].exec, pinnedIndex);
                }
                if (group.groupElement) group.groupElement.remove();
                appGroups.delete(appId);
            }
        } else {
            // Update group
            updateGroupIndicator(appId);
            createGroupThumbnail(appId);
            applyGroupState(appId);
        }
    }
    
    windowButtons.delete(windowId);
    windowStates.delete(windowId);
}

function updateWindowState(windowId, data) {
    const state = windowStates.get(windowId);
    if (!state) return;
    
    if (data.minimized !== undefined) state.minimized = data.minimized;
    windowStates.set(windowId, state);
    
    if (state.appId) {
        applyGroupState(state.appId);
    }
}

function applyGroupState(appId) {
    const group = appGroups.get(appId);
    if (!group || !group.groupElement) return;
    
    let hasMinimized = false;
    let hasFocused = false;
    
    group.windowIds.forEach(winId => {
        const state = windowStates.get(winId);
        if (state) {
            if (state.minimized) hasMinimized = true;
            if (state.focused) hasFocused = true;
        }
    });
    
    // Visual state
    if (hasFocused) {
        group.groupElement.classList.add('active-window');
        group.groupElement.style.opacity = '1';
    } else {
        group.groupElement.classList.remove('active-window');
        group.groupElement.style.opacity = hasMinimized ? '0.5' : '1';
    }
}

function applyButtonState(windowId) {
    const state = windowStates.get(windowId);
    if (!state || !state.appId) return;
    applyGroupState(state.appId);
}

function updateWindowTitle(windowId, title) {
    // Titles are shown in thumbnails, which are regenerated on hover
    const state = windowStates.get(windowId);
    if (state && state.appId) {
        const group = appGroups.get(state.appId);
        if (group) {
            createGroupThumbnail(state.appId);
        }
    }
}

function updateActiveWindow(windowId) {
    windowStates.forEach((state, id) => {
        state.focused = (id === windowId);
        windowStates.set(id, state);
        if (state.appId) {
            applyGroupState(state.appId);
        }
    });
}

function refreshTaskbar(windows) {
    const visibleWindows = (windows || []).filter((w) => !isShellWindow(w));

    // Clear all
    windowButtons.forEach((el, id) => {
        // Don't remove if still exists
        if (!visibleWindows.find(w => w.id === id)) {
            removeWindowFromTaskbar(id);
        }
    });
    
    windowButtons.clear();
    windowStates.clear();
    appGroups.clear();

    renderPinnedApps();
    visibleWindows.forEach(w => addWindowToTaskbar(w));
}

// ─── Pinned apps ──────────────────────────────────────────────────────────────
function renderPinnedApps() {
    barAppsElement.querySelectorAll('.pinned-app-btn').forEach(el => el.remove());
    pinnedApps.forEach((app, idx) => {
        createPinnedButton(app.exec, idx);
    });
}

function createPinnedButton(appIdOrExec, pinnedIdx) {
    // Check if this app already has windows open
    const targetKey = normalizeAppKey(appIdOrExec);
    const existingGroup = Array.from(appGroups.values()).find(g => 
        g.groupElement && normalizeAppKey(g.groupElement.dataset.appId) === targetKey
    );
    
    if (existingGroup && existingGroup.windowIds.size > 0) {
        // Already has a group with windows, don't create pinned button
        return;
    }
    
    const app = pinnedApps[pinnedIdx] || { exec: appIdOrExec, icon: getIconForApp(appIdOrExec) };
    
    const btn = document.createElement('div');
    btn.className = 'taskbutton color darkMode pinned-app-btn';
    btn.dataset.pinnedId = 'pin_' + pinnedIdx;
    btn.dataset.appId = app.exec;
    btn.style.cssText = 'cursor:pointer;position:relative';

    const img = document.createElement('img');
    img.src = iconSrc(app.iconPath || app.icon);
    img.className = 'darkMode';
    img.style.cssText = 'height:100%;width:100%;object-fit:contain';
    img.title = app.name || app.exec;
    img.onerror = () => { img.src = '/icons/testWindow.png'; };

    btn.appendChild(img);
    btn.onclick = () => launchAppDescriptor(app);
    btn.oncontextmenu = (e) => { e.preventDefault(); showPinContextMenu(e, pinnedIdx); };
    barAppsElement.insertBefore(btn, barAppsElement.children[pinnedIdx] || null);
}

function showPinContextMenu(e, pinnedIdx) {
    removeExistingMenus();
    const menu = makeMenuEl(e.clientX, e.clientY - 160, e);
    addMenuItem(menu, '✏️  Edit pin…', () => { openEditPinDialog(pinnedIdx); menu.remove(); });
    addMenuItem(menu, '📌  Unpin',     () => { 
        pinnedApps.splice(pinnedIdx, 1); 
        savePinned(); 
        renderPinnedApps(); 
        menu.remove(); 
    });
    document.body.appendChild(menu);
    delayedOutsideClose(menu);
}

function showGroupContextMenu(e, appId) {
    removeExistingMenus();
    const menu = makeMenuEl(e.clientX, e.clientY - 170, e);
    
    const group = appGroups.get(appId);
    if (!group) return;
    
    // Add menu items for each window
    group.windowIds.forEach(windowId => {
        const winData = labwcClient.windows.get(windowId);
        if (winData) {
            addMenuItem(menu, `Focus: ${winData.title || 'Window'}`, () => {
                labwcClient.focusWindow(windowId);
                menu.remove();
            });
        }
    });
    
    addMenuSep(menu);
    
    // Pin/Unpin
    const isPinned = isPinnedApp(appId);
    
    if (!isPinned) {
        addMenuItem(menu, '📌  Pin to taskbar', () => {
            const iconPath = getIconForApp(appId);
            const winData = labwcClient.windows.get(Array.from(group.windowIds)[0]);
            
            // Find the desktop file for this app
            const desktopInfo = desktopFileCache[appId] || 
                               Object.values(desktopFileCache).find(d => 
                                   d.exec.includes(appId) || appId.includes(d.id)
                               );
            
            pinnedApps.push({ 
                name: winData?.title || desktopInfo?.name || appId, 
                exec: desktopInfo?.exec || appId, 
                args: '', 
                iconPath, 
                icon: iconPath,
                desktopFile: desktopInfo?.id,
                appId
            });
            savePinned(); 
            renderPinnedApps(); 
            menu.remove();
        });
    } else {
        addMenuItem(menu, '📌  Unpin from taskbar', () => {
            const targetKey = normalizeAppKey(appId);
            pinnedApps = pinnedApps.filter((p) =>
                normalizeAppKey(getPinnedIdentity(p)) !== targetKey
            );
            savePinned(); 
            renderPinnedApps(); 
            menu.remove();
        });
    }
    
    addMenuSep(menu);
    
    // Close all
    addMenuItem(menu, 'Close all', () => { 
        group.windowIds.forEach(winId => labwcClient.closeWindow(winId));
        menu.remove(); 
    }, '#ff6b6b');
    
    document.body.appendChild(menu);
    delayedOutsideClose(menu);
}

// ─── Edit pin dialog ──────────────────────────────────────────────────────────
function openEditPinDialog(idx) {
    removeExistingMenus();
    const app = pinnedApps[idx] || {};

    const overlay = document.createElement('div');
    overlay.id = 'editPinOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45)';

    const dlg = document.createElement('div');
    dlg.style.cssText = 'background:rgba(30,30,35,0.98);border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:22px;width:340px;color:white;font:14px/1.5 sans-serif;box-sizing:border-box';
    dlg.innerHTML = `
        <div style="font-weight:600;margin-bottom:16px;font-size:15px">Edit Pinned App</div>
        ${dlgField('Name',      'epName', app.name    ||'')}
        ${dlgField('Command',   'epExec', app.exec    ||'')}
        ${dlgField('Arguments', 'epArgs', app.args    ||'')}
        ${dlgField('Icon path', 'epIcon', app.iconPath||app.icon||'')}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button id="epCancel" style="${dlgBtn('#555')}">Cancel</button>
            <button id="epSave"   style="${dlgBtn('#7b4ccc')}">Save</button>
        </div>`;

    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    overlay.querySelector('#epCancel').onclick = () => overlay.remove();
    overlay.querySelector('#epSave').onclick = () => {
        const iconVal = overlay.querySelector('#epIcon').value.trim();
        pinnedApps[idx] = {
            name:     overlay.querySelector('#epName').value.trim(),
            exec:     overlay.querySelector('#epExec').value.trim(),
            args:     overlay.querySelector('#epArgs').value.trim(),
            iconPath: iconVal,
            icon:     iconVal
        };
        savePinned();
        renderPinnedApps();
        overlay.remove();
    };
}

function dlgField(label, id, val) {
    return `<div style="margin-bottom:10px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:rgba(255,255,255,.45);margin-bottom:4px">${label}</div>
        <input id="${id}" value="${String(val).replace(/"/g,'&quot;')}" style="width:100%;padding:7px 9px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:white;font-size:12.5px;outline:none;box-sizing:border-box">
    </div>`;
}
function dlgBtn(bg) { return `padding:7px 18px;background:${bg};border:none;border-radius:6px;color:white;cursor:pointer;font-size:12.5px`; }

function createVirtualReferenceFromEvent(event) {
    return {
        getBoundingClientRect() {
            const x = event?.clientX ?? window.innerWidth / 2;
            const y = event?.clientY ?? window.innerHeight / 2;
            return {
                x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0
            };
        },
        contextElement: document.body
    };
}

function attachPopper(element, event, placement = 'top') {
    if (!element || !event || !window.Popper?.createPopper) {
        return null;
    }
    if (element._popperInstance) {
        element._popperInstance.destroy();
        element._popperInstance = null;
    }
    element.style.position = 'fixed';
    element._popperInstance = window.Popper.createPopper(
        createVirtualReferenceFromEvent(event),
        element,
        {
            placement,
            strategy: 'fixed',
            modifiers: [
                { name: 'offset', options: { offset: [0, 10] } },
                { name: 'flip', options: { padding: 8 } },
                { name: 'preventOverflow', options: { padding: 8 } }
            ]
        }
    );
    return element._popperInstance;
}

// ─── Menu helpers ─────────────────────────────────────────────────────────────
function makeMenuEl(x, y, anchorEvent) {
    const menu = document.createElement('div');
    menu.className = 'shell-ctx-menu';
    Object.assign(menu.style, {
        position:'fixed', left:x+'px', top:Math.max(10, y)+'px',
        background:'rgba(28,28,32,0.97)',
        border:'1px solid rgba(255,255,255,0.14)',
        borderRadius:'8px', padding:'4px 0',
        zIndex:'200000', minWidth:'165px',
        boxShadow:'0 8px 28px rgba(0,0,0,0.55)',
        backdropFilter:'blur(16px)'
    });
    attachPopper(menu, anchorEvent, 'top-start');
    return menu;
}
function addMenuItem(menu, label, action, color) {
    const item = document.createElement('div');
    item.textContent = label;
    Object.assign(item.style, { padding:'9px 18px', color: color||'white', cursor:'pointer', fontSize:'13px', transition:'background .1s' });
    item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,0.09)'; };
    item.onmouseleave = () => { item.style.background = ''; };
    item.onclick = action;
    menu.appendChild(item);
}
function addMenuSep(menu) {
    const s = document.createElement('div');
    s.style.cssText = 'height:1px;background:rgba(255,255,255,0.09);margin:3px 0';
    menu.appendChild(s);
}
function removeExistingMenus() {
    document.querySelectorAll('.shell-ctx-menu').forEach((menu) => {
        if (menu._popperInstance) {
            menu._popperInstance.destroy();
            menu._popperInstance = null;
        }
        menu.remove();
    });
    document.getElementById('editPinOverlay')?.remove();
}
function delayedOutsideClose(menu) {
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 100);
}

// ─── Tray icons ───────────────────────────────────────────────────────────────
window.registerTrayIcon = function(id, name, iconAbsPath, onClick) {
    trayRegistry.set(id, { name, icon: iconAbsPath, onClick, visible: trayVis[id] !== false });
    renderTrayIcons();
};
window.unregisterTrayIcon = function(id) {
    trayRegistry.delete(id);
    renderTrayIcons();
};

function renderTrayIcons() {
    if (!trayIconsElement) return;
    trayIconsElement.innerHTML = '';

    trayRegistry.forEach((entry, id) => {
        if (!entry.visible) return;
        trayIconsElement.appendChild(makeTrayIconEl(id, entry));
    });

    const hasHidden = Array.from(trayRegistry.values()).some(e => !e.visible);
    if (hasHidden) {
        const more = document.createElement('div');
        more.className = 'taskbutton color darkMode';
        more.style.cssText = 'font-size:11px;cursor:pointer;padding:0 5px;opacity:.6';
        more.textContent = '▲';
        more.title = 'Hidden tray icons';
        more.onclick = (e) => { e.stopPropagation(); showHiddenTrayPanel(e); };
        trayIconsElement.appendChild(more);
    }

    // Settings cog
    const cog = document.createElement('div');
    cog.className = 'taskbutton color darkMode';
    cog.title = 'Configure tray icons';
    cog.style.cssText = 'cursor:pointer;font-size:12px;opacity:.45;padding:0 4px';
    cog.textContent = '⚙';
    cog.onclick = (e) => { e.stopPropagation(); showTraySettingsPanel(e); };
    trayIconsElement.appendChild(cog);
}

function makeTrayIconEl(id, entry) {
    const div = document.createElement('div');
    div.className = 'taskbutton color darkMode';
    div.title = entry.name;
    div.style.cursor = 'pointer';
    const img = document.createElement('img');
    img.src = iconSrc(entry.icon);
    img.style.cssText = 'height:55%;width:auto;object-fit:contain';
    img.onerror = () => { img.style.display='none'; };
    div.appendChild(img);
    div.onclick = () => { if (entry.onClick) entry.onClick(); };
    return div;
}

function showHiddenTrayPanel(e) {
    removeExistingMenus();
    const panel = makeMenuEl(e.clientX - 80, e.clientY - 200, e);
    panel.style.cssText += ';display:flex;flex-wrap:wrap;gap:4px;padding:8px;max-width:180px';
    trayRegistry.forEach((entry, id) => {
        if (entry.visible) return;
        const btn = makeTrayIconEl(id, entry);
        btn.style.width = '32px'; btn.style.height = '32px';
        panel.appendChild(btn);
    });
    document.body.appendChild(panel);
    delayedOutsideClose(panel);
}

function showTraySettingsPanel(e) {
    removeExistingMenus();
    const panel = makeMenuEl(e.clientX - 180, e.clientY - 240, e);
    panel.style.padding = '12px';
    panel.style.minWidth = '210px';

    const title = document.createElement('div');
    title.textContent = 'TRAY ICONS';
    title.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.4);margin-bottom:10px';
    panel.appendChild(title);

    if (!trayRegistry.size) {
        const empty = document.createElement('div');
        empty.textContent = 'No tray icons registered.';
        empty.style.cssText = 'font-size:12px;color:rgba(255,255,255,.4)';
        panel.appendChild(empty);
    } else {
        trayRegistry.forEach((entry, id) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0';

            const img = document.createElement('img');
            img.src = iconSrc(entry.icon);
            img.style.cssText = 'width:16px;height:16px;object-fit:contain;flex-shrink:0';
            img.onerror = () => { img.style.display='none'; };

            const lbl = document.createElement('span');
            lbl.textContent = entry.name;
            lbl.style.cssText = 'flex:1;font-size:12.5px;color:white';

            const tog = document.createElement('div');
            tog.style.cssText = `width:30px;height:17px;border-radius:9px;position:relative;cursor:pointer;flex-shrink:0;transition:background .2s;background:${entry.visible ? 'var(--accent-color, rgba(176,176,176,0.72))' : 'rgba(255,255,255,0.12)'}`;
            const knob = document.createElement('div');
            knob.style.cssText = `position:absolute;top:2px;width:13px;height:13px;border-radius:50%;background:white;transition:left .2s;left:${entry.visible ? '15px' : '2px'}`;
            tog.appendChild(knob);
            tog.onclick = () => {
                entry.visible = !entry.visible;
                trayVis[id] = entry.visible;
                saveTrayVis();
                renderTrayIcons();
                panel.remove();
            };

            row.append(img, lbl, tog);
            panel.appendChild(row);
        });
    }
    document.body.appendChild(panel);
    delayedOutsideClose(panel);
}

// ─── Sortable.js integration ─────────────────────────────────────────────────
if (typeof Sortable !== 'undefined') {
    new Sortable(barAppsElement, {
        animation: 200,
        ghostClass: 'blue-background-class',
        onEnd: function() {
            saveTaskbarOrder();
        }
    });
}

// ─── Webview message bridge (app menu -> shell) ──────────────────────────────
window.addEventListener('message', (event) => {
    const data = event && event.data ? event.data : null;
    if (!data || typeof data !== 'object') return;

    if (data.action === 'closeAppMenu') {
        const appMenu = document.getElementById('appMenuID');
        if (appMenu) {
            if (appMenu._popperInstance) {
                appMenu._popperInstance.destroy();
                appMenu._popperInstance = null;
            }
            appMenu.classList.add('hide');
        }
        return;
    }

    if (data.action === 'launchApp' && data.app) {
        launchAppDescriptor(data.app);
        return;
    }

    if (data.action === 'pinApp' && data.app) {
        const incoming = data.app;
        const incomingKey = normalizeAppKey(incoming.desktopFile || incoming.exec || incoming.name);
        const exists = pinnedApps.some((p) =>
            normalizeAppKey(getPinnedIdentity(p)) === incomingKey
        );
        if (!exists) {
            pinnedApps.push({
                name: incoming.name || incoming.desktopFile || incoming.exec || 'App',
                exec: incoming.exec || incoming.desktopFile || '',
                args: incoming.args || '',
                iconPath: incoming.icon || '',
                icon: incoming.icon || '',
                desktopFile: incoming.desktopFile || '',
                appId: incoming.desktopFile || ''
            });
            savePinned();
            renderPinnedApps();
        }
    }
});

// ─── Pop-up overrides ─────────────────────────────────────────────────────────
window.openControlCenter = function(event) {
    const el = document.getElementById('controlCenterID');
    if (el.classList.contains('hide')) {
        if (!attachPopper(el, event, 'top-end') && event) {
            const ccWidth = 350;
            let leftPos = event.clientX - 175;
            if (leftPos < 0) leftPos = 10;
            if (leftPos + ccWidth > window.innerWidth) leftPos = window.innerWidth - ccWidth - 10;
            el.style.left = leftPos + 'px';
        }
        el.classList.remove('hide');
    } else {
        if (el._popperInstance) {
            el._popperInstance.destroy();
            el._popperInstance = null;
        }
        el.classList.add('hide');
    }
};

window.openCalendar = function(event) {
    const el = document.getElementById('calendarID');
    if (el.classList.contains('hide')) {
        if (!attachPopper(el, event, 'top-end') && event) {
            el.style.left = Math.min(event.clientX - 155, window.innerWidth - 330) + 'px';
        }
        el.classList.remove('hide');
    } else {
        if (el._popperInstance) {
            el._popperInstance.destroy();
            el._popperInstance = null;
        }
        el.classList.add('hide');
    }
};

window.openAppMenu = function(event) {
    const el = document.getElementById('appMenuID');
    const bounds = typeof window.applyAppMenuBounds === 'function'
        ? window.applyAppMenuBounds()
        : {
            width: parseInt(el.style.width || el.offsetWidth || 600, 10),
            height: parseInt(el.style.height || el.offsetHeight || 560, 10)
        };

    if (el.classList.contains('hide')) {
        el.style.width = `${bounds.width}px`;
        el.style.height = `${bounds.height}px`;
        if (!attachPopper(el, event, 'top') && event) {
            const menuW = bounds.width;
            const menuH = bounds.height;
            
            // Center horizontally on cursor, but keep above taskbar
            let leftPos = event.clientX - menuW / 2;
            
            // Ensure it doesn't go offscreen
            if (leftPos < 10) leftPos = 10;
            if (leftPos + menuW > window.innerWidth - 10) leftPos = window.innerWidth - menuW - 10;
            
            el.style.left = leftPos + 'px';
            el.style.width = menuW + 'px';
            el.style.height = menuH + 'px';
        }
        el.classList.remove('hide');
    } else {
        if (el._popperInstance) {
            el._popperInstance.destroy();
            el._popperInstance = null;
        }
        el.classList.add('hide');
    }
};

// ─── Style ────────────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
    .taskbutton.active-window {
        background: var(--accent-color, rgba(255,255,255,0.2)) !important;
        border-bottom: 3px solid rgba(59,130,246,0.9) !important;
    }
    .appThumb.hide, .group-appThumb.hide { 
        display: none !important; 
    }
    .window-count-indicator {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
    }
    #cursor-position {
        position:fixed;top:10px;right:10px;
        background:rgba(0,0,0,.8);color:white;padding:5px 10px;
        border-radius:5px;font-size:12px;font-family:monospace;
        z-index:100001;pointer-events:none;
        backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);
    }
`;
document.head.appendChild(style);

// ─── Cursor ───────────────────────────────────────────────────────────────────
let cursorDisplay = null;
function updateCursorDisplay(x, y) {
    if (!cursorDisplay) {
        cursorDisplay = document.createElement('div');
        cursorDisplay.id = 'cursor-position';
        document.body.appendChild(cursorDisplay);
    }
    cursorDisplay.textContent = `X: ${Math.round(x)}, Y: ${Math.round(y)}`;
}

window.labwcClient = labwcClient;
console.log('[Shell] Integrated shell initialized');
