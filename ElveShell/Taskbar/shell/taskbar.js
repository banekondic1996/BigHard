const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Sortable = require('sortablejs');
const dbus = require('dbus-next');

// State
let taskbarPinnedApps = [];
let runningApps = new Map();
let trayApps = [];
let menuWindow = null;
let currentTrayApp = null;
let sessionBus = null;
let selectedWiFiSSID = null;

// Load taskbar pins
function loadTaskbarPins() {
    try {
        const configPath = path.join(process.env.HOME, '.config', 'linux-taskbar', 'pinned.json');
        if (fs.existsSync(configPath)) {
            taskbarPinnedApps = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading taskbar pins:', error);
    }
}

// Save taskbar pins
function saveTaskbarPins() {
    try {
        const configPath = path.join(process.env.HOME, '.config', 'linux-taskbar');
        if (!fs.existsSync(configPath)) {
            fs.mkdirSync(configPath, { recursive: true });
        }
        fs.writeFileSync(path.join(configPath, 'pinned.json'), JSON.stringify(taskbarPinnedApps, null, 2));
    } catch (error) {
        console.error('Error saving taskbar pins:', error);
    }
}

// Toggle taskbar pin
function toggleTaskbarPin(appInfo) {
    const index = taskbarPinnedApps.findIndex(a => a.id === appInfo.id);
    if (index === -1) {
        taskbarPinnedApps.push(appInfo);
    } else {
        taskbarPinnedApps.splice(index, 1);
    }
    saveTaskbarPins();
    renderTaskbar();
}

// Monitor running apps via D-Bus
async function initDBusMonitoring() {
    try {
        sessionBus = dbus.sessionBus();
        
        // Try to monitor window manager
        const obj = await sessionBus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
        const dbusMgr = obj.getInterface('org.freedesktop.DBus');
        
        // List all services
        const names = await dbusMgr.ListNames();
        console.log('D-Bus services found:', names.length);
        
        // Monitor app launches
        dbusMgr.on('NameOwnerChanged', (name, oldOwner, newOwner) => {
            if (newOwner && name.startsWith('org.')) {
                console.log('App launched via D-Bus:', name);
                setTimeout(updateRunningApps, 500);
            }
        });
        
    } catch (error) {
        console.log('D-Bus monitoring unavailable, using fallback');
    }
}

// Update running apps (fallback method)
async function updateRunningApps() {
    exec('wmctrl -lp 2>/dev/null', (error, stdout) => {
        if (error) {
            // Try alternative
            exec('xdotool search --class "" 2>/dev/null', (err2) => {
                if (!err2) parseWindowList('', 'xdotool');
            });
            return;
        }
        parseWindowList(stdout, 'wmctrl');
    });
}

function parseWindowList(output, tool) {
    const newApps = new Map();
    const lines = output.trim().split('\n');
    
    for (const line of lines) {
        if (!line.trim()) continue;
        
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        
        const pid = parts[2];
        const title = parts.slice(4).join(' ');
        
        exec(`ps -p ${pid} -o comm= 2>/dev/null`, (error, pname) => {
            if (!error && pname.trim()) {
                const processName = pname.trim();
                const appId = processName.replace(/[^a-zA-Z0-9]/g, '_');
                
                if (!newApps.has(appId)) {
                    newApps.set(appId, {
                        id: appId,
                        name: title || processName,
                        processName: processName,
                        pid: pid,
                        title: title
                    });
                }
            }
        });
    }
    
    setTimeout(() => {
        runningApps = newApps;
        renderTaskbar();
    }, 500);
}

// Monitor tray icons
async function updateTrayIcons() {
    exec('ps aux', (error, stdout) => {
        if (error) return;
        
        trayApps = [];
        const apps = [
            { name: 'viber', icon: '💬', title: 'Viber' },
            { name: 'skype', icon: '☎️', title: 'Skype' },
            { name: 'discord', icon: '🎮', title: 'Discord' },
            { name: 'telegram', icon: '✈️', title: 'Telegram' },
            { name: 'slack', icon: '💼', title: 'Slack' },
            { name: 'zoom', icon: '📹', title: 'Zoom' },
            { name: 'dropbox', icon: '📦', title: 'Dropbox' },
            { name: 'spotify', icon: '🎵', title: 'Spotify' }
        ];
        
        for (const app of apps) {
            if (stdout.toLowerCase().includes(app.name)) {
                // Get PID
                exec(`pgrep -i ${app.name}`, (err, pid) => {
                    if (!err && pid.trim()) {
                        trayApps.push({
                            ...app,
                            pid: pid.trim().split('\n')[0]
                        });
                        renderTray();
                    }
                });
            }
        }
    });
}

// Load WiFi networks
async function loadWiFiNetworks() {
    const wifiList = document.getElementById('wifiList');
    wifiList.innerHTML = '<div class="wifi-item">Scanning...</div>';
    
    exec('nmcli -t -f SSID,SIGNAL,SECURITY,ACTIVE device wifi list 2>/dev/null', (error, stdout) => {
        if (error) {
            wifiList.innerHTML = '<div class="wifi-item">WiFi not available</div>';
            return;
        }
        
        const networks = [];
        const lines = stdout.trim().split('\n');
        
        for (const line of lines) {
            const [ssid, signal, security, active] = line.split(':');
            if (ssid && ssid !== '--') {
                networks.push({
                    ssid: ssid,
                    signal: parseInt(signal) || 0,
                    secured: security && security !== '',
                    connected: active === 'yes'
                });
            }
        }
        
        if (networks.length === 0) {
            wifiList.innerHTML = '<div class="wifi-item">No networks found</div>';
            return;
        }
        
        wifiList.innerHTML = '';
        for (const network of networks) {
            const item = document.createElement('div');
            item.className = 'wifi-item' + (network.connected ? ' connected' : '');
            
            // Signal strength indicator
            let signalIcon = '📶';
            if (network.signal < 30) signalIcon = '📶';
            else if (network.signal < 60) signalIcon = '📶';
            else signalIcon = '📶';
            
            item.innerHTML = `
                <span><span class="wifi-signal">${signalIcon}</span>${network.ssid} (${network.signal}%)</span>
                <span>${network.connected ? '✓' : (network.secured ? '🔒' : '')}</span>
            `;
            
            if (!network.connected) {
                item.style.cursor = 'pointer';
                item.addEventListener('click', () => connectToWiFi(network));
            }
            
            wifiList.appendChild(item);
        }
    });
}

// Connect to WiFi
function connectToWiFi(network) {
    selectedWiFiSSID = network.ssid;
    
    if (network.secured) {
        // Show password dialog
        document.getElementById('wifiSSIDLabel').textContent = `Network: ${network.ssid}`;
        document.getElementById('wifiPassword').value = '';
        document.getElementById('wifiPasswordModal').classList.add('show');
        document.getElementById('wifiPassword').focus();
    } else {
        // Connect without password
        doWiFiConnect(network.ssid, '');
    }
}

// Perform WiFi connection
function doWiFiConnect(ssid, password) {
    console.log('Connecting to:', ssid);
    
    const cmd = password 
        ? `nmcli device wifi connect "${ssid}" password "${password}"`
        : `nmcli device wifi connect "${ssid}"`;
    
    exec(cmd, (error) => {
        if (error) {
            alert('Failed to connect to WiFi');
        } else {
            alert('Connected successfully!');
            setTimeout(loadWiFiNetworks, 1000);
        }
        document.getElementById('wifiPasswordModal').classList.remove('show');
    });
}

// Find icon
function findIcon(iconName) {
    if (!iconName || iconName.startsWith('/')) return iconName;
    
    const iconPaths = [
        '/usr/share/pixmaps',
        '/usr/share/icons/hicolor/48x48/apps',
        '/usr/share/icons/hicolor/64x64/apps'
    ];
    
    for (const iconPath of iconPaths) {
        for (const ext of ['.png', '.svg', '.xpm']) {
            const fullPath = path.join(iconPath, iconName + ext);
            if (fs.existsSync(fullPath)) return fullPath;
        }
    }
    
    return null;
}

// Launch app
function launchApp(app) {
    console.log('Launching:', app.name || app.id);
    exec(app.exec || app.processName || app.id);
}
const buttonElement = document.getElementById("startButton");
const rect = buttonElement.getBoundingClientRect();
const menuX = Math.round(rect.left);
const menuY = Math.round(rect.top - 700); // Above taskbar
//const menuY = Math.round(window.screen.height - rect.bottom - 700);
<webview id="transferDialogID" onmouseleave="" class="hide" allowtransparency allownw style="position: absolute;z-index: 10000;width: 1050px;height: 477px;bottom: 178;display: block;" partition="trusted" src="../linux-app-launcher/index.html" type=""></webview>
// menuWindow=nw.Window.open('../linux-app-launcher/index.html', {
//     x: menuX,
//     y: menuY,
//     width: 900,
//     height: 700,
//     frame: false,
//     resizable: false,
//     title: 'Application Menu',
//     show: true,
//     focus: true
// }, (win) => {
//     menuWindow = win;
//     win.on('closed', () => {
//         //menuWindow = null;
//     });
// });
// Open start menu
function openStartMenu(buttonElement) {
   if(menuWindow==null){

}
else{
    console.log(getCursorPosition());
    menuWindow.toggle('show');
}
}

// Render taskbar
function renderTaskbar() {
    const pinnedContainer = document.getElementById('pinnedApps');
    const runningContainer = document.getElementById('runningApps');
    const separator = document.getElementById('runningSeparator');
    
    // Render pinned apps
    pinnedContainer.innerHTML = '';
    for (const app of taskbarPinnedApps) {
        const isRunning = runningApps.has(app.id);
        
        const btn = document.createElement('button');
        btn.className = 'app-button pinned' + (isRunning ? ' running' : '');
        btn.dataset.appId = app.id;
        
        const iconPath = findIcon(app.icon);
        if (iconPath && fs.existsSync(iconPath)) {
            btn.innerHTML = `<img src="file://${iconPath}" class="app-icon" alt="${app.name}">`;
        } else {
            btn.innerHTML = `<div class="app-icon-fallback">${app.name.charAt(0)}</div>`;
        }
        
        btn.title = app.name;
        btn.addEventListener('click', () => launchApp(app));
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showAppContextMenu(e, app, true);
        });
        
        pinnedContainer.appendChild(btn);
    }
    
    // Render running apps
    runningContainer.innerHTML = '';
    const runningNotPinned = Array.from(runningApps.values()).filter(
        ra => !taskbarPinnedApps.find(pa => pa.id === ra.id)
    );
    
    if (runningNotPinned.length > 0) {
        separator.style.display = 'block';
        for (const app of runningNotPinned) {
            const btn = document.createElement('button');
            btn.className = 'app-button running active';
            
            const iconPath = findIcon(app.processName);
            if (iconPath && fs.existsSync(iconPath)) {
                btn.innerHTML = `<img src="file://${iconPath}" class="app-icon">`;
            } else {
                btn.innerHTML = `<div class="app-icon-fallback">${app.name.charAt(0)}</div>`;
            }
            
            btn.title = app.name;
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showAppContextMenu(e, app, false);
            });
            
            runningContainer.appendChild(btn);
        }
    } else {
        separator.style.display = 'none';
    }
    
    // Sortable
    if (pinnedContainer.children.length > 0 && !pinnedContainer.sortable) {
        Sortable.create(pinnedContainer, {
            animation: 150,
            onEnd: (evt) => {
                const item = taskbarPinnedApps.splice(evt.oldIndex, 1)[0];
                taskbarPinnedApps.splice(evt.newIndex, 0, item);
                saveTaskbarPins();
            }
        });
        pinnedContainer.sortable = true;
    }
}

// Context menu positioning
function positionContextMenu(menu, x, y) {
    const menuHeight = 100; // Approximate
    const windowHeight = window.innerHeight;
    
    // If too close to bottom, show above
    if (y + menuHeight > windowHeight) {
        menu.style.top = (y - menuHeight - 10) + 'px';
    } else {
        menu.style.top = y + 'px';
    }
    
    menu.style.left = x + 'px';
}

// App context menu
function showAppContextMenu(e, app, isPinned) {
    const menu = document.createElement('div');
    menu.className = 'tray-context-menu show';
    menu.id = 'tempAppMenu';
    
    const pinItem = document.createElement('div');
    pinItem.className = 'tray-menu-item';
    pinItem.textContent = isPinned ? 'Unpin from Taskbar' : 'Pin to Taskbar';
    pinItem.addEventListener('click', () => {
        toggleTaskbarPin(app);
        document.body.removeChild(menu);
    });
    
    const quitItem = document.createElement('div');
    quitItem.className = 'tray-menu-item';
    quitItem.textContent = 'Quit';
    quitItem.addEventListener('click', () => {
        if (app.pid) {
            exec(`kill ${app.pid}`);
        }
        document.body.removeChild(menu);
    });
    
    menu.appendChild(pinItem);
    menu.appendChild(quitItem);
    document.body.appendChild(menu);
    
    positionContextMenu(menu, e.pageX, e.pageY);
    
    setTimeout(() => {
        const closeMenu = () => {
            if (menu.parentElement) document.body.removeChild(menu);
            document.removeEventListener('click', closeMenu);
        };
        document.addEventListener('click', closeMenu);
    }, 100);
}

// Render tray
function renderTray() {
    const trayContainer = document.getElementById('systemTray');
    trayContainer.innerHTML = '';
    
    for (const app of trayApps) {
        const btn = document.createElement('button');
        btn.className = 'tray-icon';
        btn.title = app.title;
        
        const iconPath = findIcon(app.name);
        if (iconPath && fs.existsSync(iconPath)) {
            const img = document.createElement('img');
            img.src = 'file://' + iconPath;
            btn.appendChild(img);
        } else {
            btn.textContent = app.icon || app.title.charAt(0);
        }
        
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showTrayContextMenu(e, app);
        });
        
        btn.addEventListener('click', () => {
            console.log('Opening:', app.title);
            exec(`wmctrl -a "${app.title}"`);
        });
        
        trayContainer.appendChild(btn);
    }
}

// Tray context menu
function showTrayContextMenu(e, app) {
    const menu = document.getElementById('trayContextMenu');
    currentTrayApp = app;
    
    positionContextMenu(menu, e.pageX, e.pageY);
    menu.classList.add('show');
}

function hideTrayContextMenu() {
    document.getElementById('trayContextMenu').classList.remove('show');
}

// Power functions
function powerShutdown() {
    if (confirm('Shutdown now?')) {
        exec('systemctl poweroff');
    }
}

function powerRestart() {
    if (confirm('Restart now?')) {
        exec('systemctl reboot');
    }
}

function powerSleep() {
    exec('systemctl suspend');
}

function powerLock() {
    exec('loginctl lock-session');
}

function powerLogout() {
    if (confirm('Logout now?')) {
        exec('loginctl terminate-user $USER');
    }
}

// Update clock
function updateClock() {
    const now = new Date();
    document.getElementById('time').textContent = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', minute: '2-digit', hour12: false 
    });
    document.getElementById('date').textContent = now.toLocaleDateString('en-US', { 
        month: 'short', day: 'numeric' 
    });
}

// System menu
function toggleSystemMenu() {
    const menu = document.getElementById('systemMenu');
    const btn = document.getElementById('systemButton');
    const rect = btn.getBoundingClientRect();
    
    menu.classList.toggle('show');
    
    if (menu.classList.contains('show')) {
        // Position above button
        menu.style.right = '10px';
        menu.style.bottom = '55px';Menu
        loadWiFiNetworks();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    loadTaskbarPins();
    renderTaskbar();
    updateClock();
    
    // D-Bus monitoring
    initDBusMonitoring();
    
    // Polling updates
    setInterval(updateRunningApps, 2000);
    setInterval(updateTrayIcons, 3000);
    setInterval(updateClock, 60000);
    
    updateRunningApps();
    updateTrayIcons();
    
    // Events
    document.getElementById('startButton').addEventListener('click', (e) => openStartMenu(e.currentTarget));
    document.getElementById('systemButton').addEventListener('click', toggleSystemMenu);
    document.getElementById('brightnessSlider').addEventListener('input', (e) => {
        document.getElementById('brightnessValue').textContent = e.target.value + '%';
        exec(`brightnessctl set ${e.target.value}%`);
    });
    document.getElementById('volumeSlider').addEventListener('input', (e) => {
        document.getElementById('volumeValue').textContent = e.target.value + '%';
        exec(`amixer set Master ${e.target.value}%`);
    });
    
    document.getElementById('trayOpen').addEventListener('click', () => {
        if (currentTrayApp) exec(`wmctrl -a "${currentTrayApp.title}"`);
        hideTrayContextMenu();
    });
    
    document.getElementById('trayQuit').addEventListener('click', () => {
        if (currentTrayApp && currentTrayApp.pid) {
            exec(`kill ${currentTrayApp.pid}`);
            setTimeout(updateTrayIcons, 500);
        }
        hideTrayContextMenu();
    });
    
    // WiFi
    document.getElementById('wifiScan').addEventListener('click', loadWiFiNetworks);
    document.getElementById('wifiConnect').addEventListener('click', () => {
        const password = document.getElementById('wifiPassword').value;
        doWiFiConnect(selectedWiFiSSID, password);
    });
    document.getElementById('wifiCancel').addEventListener('click', () => {
        document.getElementById('wifiPasswordModal').classList.remove('show');
    });
    
    // Power
    document.getElementById('powerShutdown').addEventListener('click', powerShutdown);
    document.getElementById('powerRestart').addEventListener('click', powerRestart);
    document.getElementById('powerSleep').addEventListener('click', powerSleep);
    document.getElementById('powerLock').addEventListener('click', powerLock);
    document.getElementById('powerLogout').addEventListener('click', powerLogout);
    
    // Close menus
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('systemMenu');
        const btn = document.getElementById('systemButton');
        if (!menu.contains(e.target) && !btn.contains(e.target)) {
            menu.classList.remove('show');
        }
        
        if (!e.target.classList.contains('tray-icon')) {
            hideTrayContextMenu();
        }
    });
});