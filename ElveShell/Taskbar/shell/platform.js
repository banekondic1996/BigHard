// Platform abstraction layer for cross-platform compatibility
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const platform = os.platform();
const isLinux = platform === 'linux';
const isWindows = platform === 'win32';

// Platform-specific implementations
class PlatformAPI {
    // Get running applications
    async getRunningApps() {
        if (isLinux) {
            return this.getRunningAppsLinux();
        } else if (isWindows) {
            return this.getRunningAppsWindows();
        }
        return [];
    }

    async getRunningAppsLinux() {
        return new Promise((resolve) => {
            exec('wmctrl -lp 2>/dev/null || xdotool search --class "" 2>/dev/null', (error, stdout) => {
                if (error) {
                    resolve([]);
                    return;
                }

                const apps = new Map();
                const lines = stdout.trim().split('\n');

                for (const line of lines) {
                    if (!line.trim()) continue;
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 4) continue;

                    const pid = parts[2];
                    const title = parts.slice(4).join(' ');

                    // Get process name
                    exec(`ps -p ${pid} -o comm= 2>/dev/null`, (err, pname) => {
                        if (!err && pname.trim()) {
                            const processName = pname.trim();
                            const appId = processName.replace(/[^a-zA-Z0-9]/g, '_');

                            if (!apps.has(appId)) {
                                apps.set(appId, {
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

                setTimeout(() => resolve(Array.from(apps.values())), 500);
            });
        });
    }

    async getRunningAppsWindows() {
        // TODO: Implement using Win32 API
        // Will use EnumWindows and GetWindowText
        return [];
    }

    // Get system tray icons
    async getTrayIcons() {
        if (isLinux) {
            return this.getTrayIconsLinux();
        } else if (isWindows) {
            return this.getTrayIconsWindows();
        }
        return [];
    }

    async getTrayIconsLinux() {
        return new Promise((resolve) => {
            // Check for common tray applications
            exec('ps aux', (error, stdout) => {
                if (error) {
                    resolve([]);
                    return;
                }

                const trayApps = [];
                const commonTrayApps = [
                    { name: 'viber', icon: '💬', title: 'Viber' },
                    { name: 'skype', icon: '☎️', title: 'Skype' },
                    { name: 'discord', icon: '🎮', title: 'Discord' },
                    { name: 'telegram', icon: '✈️', title: 'Telegram' },
                    { name: 'slack', icon: '💼', title: 'Slack' },
                    { name: 'zoom', icon: '📹', title: 'Zoom' },
                    { name: 'dropbox', icon: '📦', title: 'Dropbox' },
                    { name: 'spotify', icon: '🎵', title: 'Spotify' }
                ];

                for (const app of commonTrayApps) {
                    if (stdout.toLowerCase().includes(app.name)) {
                        trayApps.push({
                            id: app.name,
                            title: app.title,
                            icon: app.icon,
                            processName: app.name
                        });
                    }
                }

                resolve(trayApps);
            });
        });
    }

    async getTrayIconsWindows() {
        // TODO: Implement using Shell_NotifyIcon
        return [];
    }

    // Get WiFi networks
    async getWiFiNetworks() {
        if (isLinux) {
            return this.getWiFiNetworksLinux();
        } else if (isWindows) {
            return this.getWiFiNetworksWindows();
        }
        return [];
    }

    async getWiFiNetworksLinux() {
        return new Promise((resolve) => {
            exec('nmcli -t -f SSID,SIGNAL,SECURITY device wifi list 2>/dev/null', (error, stdout) => {
                if (error) {
                    // Fallback to iwlist
                    exec('iwlist scan 2>/dev/null | grep -E "ESSID|Quality"', (err2, out2) => {
                        if (err2) {
                            resolve([]);
                        } else {
                            const networks = this.parseIwlistOutput(out2);
                            resolve(networks);
                        }
                    });
                    return;
                }

                const networks = [];
                const lines = stdout.trim().split('\n');

                for (const line of lines) {
                    const [ssid, signal, security] = line.split(':');
                    if (ssid && ssid !== '--') {
                        networks.push({
                            ssid: ssid,
                            signal: parseInt(signal) || 0,
                            secured: security && security !== '',
                            connected: false
                        });
                    }
                }

                // Get current connection
                exec('nmcli -t -f NAME connection show --active 2>/dev/null', (err, out) => {
                    if (!err) {
                        const activeSSID = out.trim().split('\n')[0];
                        const active = networks.find(n => n.ssid === activeSSID);
                        if (active) active.connected = true;
                    }
                    resolve(networks);
                });
            });
        });
    }

    parseIwlistOutput(output) {
        const networks = [];
        const lines = output.split('\n');
        let currentSSID = null;

        for (const line of lines) {
            if (line.includes('ESSID:')) {
                const match = line.match(/ESSID:"([^"]+)"/);
                if (match) {
                    currentSSID = match[1];
                    networks.push({
                        ssid: currentSSID,
                        signal: 0,
                        secured: false,
                        connected: false
                    });
                }
            } else if (line.includes('Quality') && currentSSID) {
                const match = line.match(/Quality[=:](\d+)\/(\d+)/);
                if (match) {
                    const signal = Math.round((parseInt(match[1]) / parseInt(match[2])) * 100);
                    networks[networks.length - 1].signal = signal;
                }
            }
        }

        return networks;
    }

    async getWiFiNetworksWindows() {
        // TODO: Implement using netsh wlan show networks
        return [];
    }

    // Control brightness
    setBrightness(value) {
        if (isLinux) {
            this.setBrightnessLinux(value);
        } else if (isWindows) {
            this.setBrightnessWindows(value);
        }
    }

    setBrightnessLinux(value) {
        exec(`brightnessctl set ${value}%`, (error) => {
            if (error) {
                exec(`xrandr --output $(xrandr | grep " connected" | cut -f1 -d " ") --brightness ${value/100}`, (err) => {
                    if (err) console.error('Brightness control not available');
                });
            }
        });
    }

    setBrightnessWindows(value) {
        // TODO: Implement using WMI or PowerShell
    }

    // Control volume
    setVolume(value) {
        if (isLinux) {
            this.setVolumeLinux(value);
        } else if (isWindows) {
            this.setVolumeWindows(value);
        }
    }

    setVolumeLinux(value) {
        exec(`amixer set Master ${value}%`, (error) => {
            if (error) {
                exec(`pactl set-sink-volume @DEFAULT_SINK@ ${value}%`, (err) => {
                    if (err) console.error('Volume control not available');
                });
            }
        });
    }

    setVolumeWindows(value) {
        // TODO: Implement using NirCmd or PowerShell
    }

    // Launch application
    launchApp(command) {
        exec(command, (error) => {
            if (error) {
                console.error('Launch error:', error);
            }
        });
    }

    // Find icon path
    findIcon(iconName) {
        if (isLinux) {
            return this.findIconLinux(iconName);
        } else if (isWindows) {
            return this.findIconWindows(iconName);
        }
        return null;
    }

    findIconLinux(iconName) {
        if (!iconName || iconName.startsWith('/')) return iconName;

        const iconPaths = [
            '/usr/share/pixmaps',
            '/usr/share/icons/hicolor/48x48/apps',
            '/usr/share/icons/hicolor/64x64/apps',
            '/usr/share/icons/hicolor/scalable/apps'
        ];

        for (const iconPath of iconPaths) {
            for (const ext of ['.png', '.svg', '.xpm']) {
                const fullPath = path.join(iconPath, iconName + ext);
                if (fs.existsSync(fullPath)) return fullPath;
            }
        }

        return null;
    }

    findIconWindows(iconName) {
        // TODO: Extract icons from .exe files
        return null;
    }
}

module.exports = new PlatformAPI();