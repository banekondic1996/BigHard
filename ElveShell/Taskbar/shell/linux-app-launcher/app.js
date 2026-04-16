const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Application state
let allApps = [];
let allCategories = {};
let categoryAppsCache = {}; // Pre-rendered HTML cache
let filteredApps = [];
let currentView = 'pinned';
let pinnedApps = [];
let appUsageCount = {};
let tooltipTimeout = null;
let contextMenuAppId = null;
let customApps = [];

// Settings
let settings = {
    iconSize: 48,
    showMostUsed: true,
    fullscreenMode: false
};

// Desktop file locations
const desktopFilePaths = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(process.env.HOME, '.local/share/applications')
];

// Icon theme paths
const iconThemePaths = [
    '/usr/share/icons',
    '/usr/share/pixmaps',
    path.join(process.env.HOME, '.local/share/icons'),
    path.join(process.env.HOME, '.icons')
];

// Category mapping
const categoryMapping = {
    'AudioVideo': { name: 'Multimedia', icon: '🎵' },
    'Audio': { name: 'Audio', icon: '🔊' },
    'Video': { name: 'Video', icon: '🎬' },
    'Development': { name: 'Development', icon: '💻' },
    'Education': { name: 'Education', icon: '📚' },
    'Game': { name: 'Games', icon: '🎮' },
    'Graphics': { name: 'Graphics', icon: '🎨' },
    'Network': { name: 'Internet', icon: '🌐' },
    'Office': { name: 'Office', icon: '📝' },
    'Settings': { name: 'Settings', icon: '⚙️' },
    'System': { name: 'System', icon: '🖥️' },
    'Utility': { name: 'Utilities', icon: '🔧' },
    'Accessories': { name: 'Accessories', icon: '📎' }
};

// Load data
function loadData() {
    try {
        const dataPath = path.join(process.env.HOME, '.config', 'linux-app-launcher');
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }

        const settingsFile = path.join(dataPath, 'settings.json');
        if (fs.existsSync(settingsFile)) {
            settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
        }

        const pinnedFile = path.join(dataPath, 'pinned.json');
        if (fs.existsSync(pinnedFile)) {
            pinnedApps = JSON.parse(fs.readFileSync(pinnedFile, 'utf8'));
        }

        const usageFile = path.join(dataPath, 'usage.json');
        if (fs.existsSync(usageFile)) {
            appUsageCount = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        }

        const customFile = path.join(dataPath, 'custom.json');
        if (fs.existsSync(customFile)) {
            customApps = JSON.parse(fs.readFileSync(customFile, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// Save data
function saveData() {
    try {
        const dataPath = path.join(process.env.HOME, '.config', 'linux-app-launcher');
        fs.writeFileSync(path.join(dataPath, 'settings.json'), JSON.stringify(settings, null, 2));
        fs.writeFileSync(path.join(dataPath, 'pinned.json'), JSON.stringify(pinnedApps, null, 2));
        fs.writeFileSync(path.join(dataPath, 'usage.json'), JSON.stringify(appUsageCount, null, 2));
        fs.writeFileSync(path.join(dataPath, 'custom.json'), JSON.stringify(customApps, null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Find icon path
function findIconPath(iconName) {
    if (!iconName) return null;
    if (iconName.startsWith('/') && fs.existsSync(iconName)) return iconName;

    const iconBaseName = iconName.replace(/\.(png|svg|xpm)$/, '');
    const sizes = ['64x64', '48x48', '128x128', '256x256', 'scalable', '32x32'];
    const extensions = ['.png', '.svg', '.xpm'];
    
    for (const themePath of iconThemePaths) {
        if (!fs.existsSync(themePath)) continue;

        for (const ext of extensions) {
            const directPath = path.join(themePath, iconBaseName + ext);
            if (fs.existsSync(directPath)) return directPath;
        }

        try {
            const themes = fs.readdirSync(themePath);
            for (const theme of themes) {
                const themeDir = path.join(themePath, theme);
                if (!fs.statSync(themeDir).isDirectory()) continue;

                for (const size of sizes) {
                    const sizeCategories = ['apps', 'applications', 'mimetypes', 'devices'];
                    for (const category of sizeCategories) {
                        const iconDir = path.join(themeDir, size, category);
                        if (!fs.existsSync(iconDir)) continue;

                        for (const ext of extensions) {
                            const iconPath = path.join(iconDir, iconBaseName + ext);
                            if (fs.existsSync(iconPath)) return iconPath;
                        }
                    }
                }
            }
        } catch (error) {
            // Continue
        }
    }
    return null;
}

// Parse desktop file
function parseDesktopFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const app = {
            name: '',
            exec: '',
            icon: '',
            comment: '',
            categories: [],
            terminal: false,
            noDisplay: false,
            filePath: filePath,
            id: path.basename(filePath, '.desktop')
        };

        let inDesktopEntry = false;
        for (let line of lines) {
            line = line.trim();
            if (line === '[Desktop Entry]') {
                inDesktopEntry = true;
                continue;
            }
            if (line.startsWith('[') && line !== '[Desktop Entry]') {
                inDesktopEntry = false;
                continue;
            }
            if (!inDesktopEntry) continue;

            if (line.startsWith('Name=') && !line.startsWith('Name[')) {
                app.name = line.substring(5);
            } else if (line.startsWith('Exec=')) {
                app.exec = line.substring(5);
            } else if (line.startsWith('Icon=')) {
                app.icon = line.substring(5);
            } else if (line.startsWith('Comment=') && !line.startsWith('Comment[')) {
                app.comment = line.substring(8);
            } else if (line.startsWith('Categories=')) {
                app.categories = line.substring(11).split(';').filter(c => c);
            } else if (line.startsWith('Terminal=')) {
                app.terminal = line.substring(9).toLowerCase() === 'true';
            } else if (line.startsWith('NoDisplay=')) {
                app.noDisplay = line.substring(10).toLowerCase() === 'true';
            }
        }

        if (!app.name || !app.exec || app.noDisplay) return null;
        app.exec = app.exec.replace(/%[a-zA-Z]/g, '').trim();

        if (app.icon) {
            const iconPath = findIconPath(app.icon);
            app.iconPath = iconPath || app.icon;
        }

        return app;
    } catch (error) {
        console.error(`Error parsing ${filePath}:`, error);
        return null;
    }
}

// Get primary category
function getPrimaryCategory(app) {
    if (!app.categories || app.categories.length === 0) return 'Other';
    for (const cat of app.categories) {
        if (categoryMapping[cat]) return categoryMapping[cat].name;
    }
    return 'Other';
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Generate app HTML
function generateAppHTML(app) {
    const appNameEscaped = escapeHtml(app.name);
    let iconHtml;
    
    if (app.iconPath && fs.existsSync(app.iconPath)) {
        iconHtml = `<img src="file://${app.iconPath}" alt="${appNameEscaped}">`;
    } else {
        iconHtml = `<div class="app-icon-fallback">${app.name.charAt(0).toUpperCase()}</div>`;
    }

    return `
        <div class="app-card" data-app-id="${app.id}">
            <div class="app-icon">${iconHtml}</div>
            <div class="app-name">${appNameEscaped}</div>
        </div>
    `;
}

// Pre-render all categories
function preRenderCategories() {
    categoryAppsCache = {};
    const sizeClass = settings.iconSize <= 32 ? 'small' : settings.iconSize >= 64 ? 'large' : 'medium';
    
    // Pinned apps
    const pinnedApps = getPinnedApps();
    categoryAppsCache['pinned'] = `<div class="apps-grid size-${sizeClass}">` + 
        pinnedApps.map(app => generateAppHTML(app)).join('') + '</div>';
    
    // Most used
    if (settings.showMostUsed) {
        const mostUsed = getMostUsedApps();
        categoryAppsCache['mostused'] = `<div class="apps-grid size-${sizeClass}">` + 
            mostUsed.map(app => generateAppHTML(app)).join('') + '</div>';
    }
    
    // All apps
    categoryAppsCache['all'] = `<div class="apps-grid size-${sizeClass}">` + 
        allApps.map(app => generateAppHTML(app)).join('') + '</div>';
    
    // Each category
    for (const [category, apps] of Object.entries(allCategories)) {
        categoryAppsCache[category] = `<div class="apps-grid size-${sizeClass}">` + 
            apps.map(app => generateAppHTML(app)).join('') + '</div>';
    }
}

// Scan applications - LOAD ONCE
function scanApplications() {
    console.log('Scanning applications...');
    allApps = [];
    
    for (const dirPath of desktopFilePaths) {
        if (!fs.existsSync(dirPath)) continue;

        try {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
                if (!file.endsWith('.desktop')) continue;
                const fullPath = path.join(dirPath, file);
                const app = parseDesktopFile(fullPath);
                if (app) {
                    app.category = getPrimaryCategory(app);
                    allApps.push(app);
                }
            }
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error);
        }
    }

    allApps.sort((a, b) => a.name.localeCompare(b.name));
    
    // Add custom apps
    allApps = [...allApps, ...customApps];
    
    // Build categories map
    allCategories = {};
    for (const app of allApps) {
        if (!allCategories[app.category]) {
            allCategories[app.category] = [];
        }
        allCategories[app.category].push(app);
    }
    
    // Cache for next time
    try {
        sessionStorage.setItem('cachedApps', JSON.stringify(allApps));
        sessionStorage.setItem('cachedCategories', JSON.stringify(allCategories));
    } catch (e) {
        console.error('Cache error:', e);
    }
    
    // Pre-render all categories
    preRenderCategories();
    
    console.log(`Found ${allApps.length} applications`);
    filteredApps = getPinnedApps();
}

// Get most used apps
function getMostUsedApps() {
    return Object.entries(appUsageCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id]) => allApps.find(app => app.id === id))
        .filter(app => app);
}

// Get pinned apps
function getPinnedApps() {
    return pinnedApps
        .map(id => allApps.find(app => app.id === id))
        .filter(app => app);
}

// Toggle pin
function togglePin(appId) {
    const index = pinnedApps.indexOf(appId);
    if (index === -1) {
        pinnedApps.push(appId);
    } else {
        pinnedApps.splice(index, 1);
    }
    saveData();
    preRenderCategories(); // Re-render cache
    if (currentView === 'pinned') {
        showCategory('pinned');
    }
}

// Launch app
function launchApp(app) {
    console.log(`Launching: ${app.name}`);
    appUsageCount[app.id] = (appUsageCount[app.id] || 0) + 1;
    saveData();
    exec(app.exec, (error) => {
        if (error) {
            console.error(`Error launching ${app.name}:`, error);
            alert(`Failed to launch ${app.name}\n\nCommand: ${app.exec}\n\nError: ${error.message}`);
        }
    });
}

// Render categories
function renderCategories() {
    const categoryList = document.getElementById('categoryList');
    let html = '';

    // Pinned apps
    const pinnedCount = getPinnedApps().length;
    html += `
        <div class="category-item ${currentView === 'pinned' ? 'active' : ''}" data-category="pinned">
            <span>📌 Pinned Apps</span>
            <span class="category-count">${pinnedCount}</span>
        </div>
    `;

    // Most used
    if (settings.showMostUsed) {
        const mostUsedCount = getMostUsedApps().length;
        html += `
            <div class="category-item ${currentView === 'mostused' ? 'active' : ''}" data-category="mostused">
                <span>⭐ Most Used</span>
                <span class="category-count">${mostUsedCount}</span>
            </div>
        `;
    }

    // All apps
    html += `
        <div class="category-item ${currentView === 'all' ? 'active' : ''}" data-category="all">
            <span>📱 All Apps</span>
            <span class="category-count">${allApps.length}</span>
        </div>
    `;

    // Regular categories
    const sortedCategories = Object.entries(allCategories).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [category, apps] of sortedCategories) {
        const icon = Object.values(categoryMapping).find(c => c.name === category)?.icon || '📦';
        const isActive = currentView === category;
        html += `
            <div class="category-item ${isActive ? 'active' : ''}" data-category="${category}">
                <span>${icon} ${category}</span>
                <span class="category-count">${apps.length}</span>
            </div>
        `;
    }

    categoryList.innerHTML = html;

    // Add hover handlers - just show pre-rendered HTML
    document.querySelectorAll('.category-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            showCategory(item.dataset.category);
        });
    });
}

// Show category (instant - just set innerHTML)
function showCategory(category) {
    currentView = category;
    const container = document.getElementById('appsContainer');
    
    // Use pre-rendered HTML
    if (categoryAppsCache[category]) {
        container.innerHTML = categoryAppsCache[category];
    } else {
        container.innerHTML = '<div class="no-apps">No applications found</div>';
    }
    
    // Update active state
    document.querySelectorAll('.category-item').forEach(item => {
        item.classList.toggle('active', item.dataset.category === category);
    });
    
    // Attach event listeners
    attachAppEventListeners();
}

// Attach event listeners to app cards
function attachAppEventListeners() {
    document.querySelectorAll('.app-card').forEach(card => {
        const appId = card.dataset.appId;
        const app = allApps.find(a => a.id === appId);
        
        card.addEventListener('click', () => launchApp(app));
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e, appId);
        });

        if (app.comment) {
            card.addEventListener('mouseenter', (e) => showTooltip(e, app.comment));
            card.addEventListener('mouseleave', hideTooltip);
        }
    });
}

// Show tooltip
function showTooltip(e, text) {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
        const tooltip = document.getElementById('tooltip');
        tooltip.textContent = text;
        tooltip.classList.add('show');
        const rect = e.target.getBoundingClientRect();
        tooltip.style.left = rect.left + (rect.width / 2) - (tooltip.offsetWidth / 2) + 'px';
        tooltip.style.top = rect.bottom + 10 + 'px';
    }, 2000);
}

// Hide tooltip
function hideTooltip() {
    clearTimeout(tooltipTimeout);
    document.getElementById('tooltip').classList.remove('show');
}

// Search filtering
function filterApps() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const categoryList = document.getElementById('categoryList');
    const searchOverlay = document.getElementById('searchOverlay');
    const container = document.getElementById('appsContainer');
    
    if (searchTerm) {
        // Show search, hide categories
        searchOverlay.classList.add('show');
        categoryList.classList.add('hidden');
        
        // Filter all apps
        const filtered = allApps.filter(app => 
            app.name.toLowerCase().includes(searchTerm) ||
            (app.comment && app.comment.toLowerCase().includes(searchTerm))
        );
        
        const sizeClass = settings.iconSize <= 32 ? 'small' : settings.iconSize >= 64 ? 'large' : 'medium';
        if (filtered.length > 0) {
            container.innerHTML = `<div class="apps-grid size-${sizeClass}">` + 
                filtered.map(app => generateAppHTML(app)).join('') + '</div>';
            attachAppEventListeners();
        } else {
            container.innerHTML = '<div class="no-apps">No applications found</div>';
        }
    } else {
        // Hide search, show categories
        searchOverlay.classList.remove('show');
        categoryList.classList.remove('hidden');
        
        // Show current category
        showCategory(currentView);
    }
}

// Context menu
function showContextMenu(e, appId) {
    const menu = document.getElementById('contextMenu');
    const pinItem = document.getElementById('contextPin');
    
    contextMenuAppId = appId;
    const isPinned = pinnedApps.includes(appId);
    
    pinItem.textContent = isPinned ? '📌 Unpin from List' : '📍 Pin to List';
    pinItem.classList.toggle('pinned', isPinned);
    
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
    menu.classList.add('show');
}

function hideContextMenu() {
    document.getElementById('contextMenu').classList.remove('show');
}

// Settings
function openSettings() {
    document.getElementById('iconSizeSlider').value = settings.iconSize;
    document.getElementById('iconSizeValue').textContent = settings.iconSize + 'px';
    document.getElementById('showMostUsed').checked = settings.showMostUsed;
    document.getElementById('fullscreenMode').checked = settings.fullscreenMode;
    document.getElementById('settingsModal').classList.add('show');
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('show');
}

function saveSettings() {
    settings.iconSize = parseInt(document.getElementById('iconSizeSlider').value);
    settings.showMostUsed = document.getElementById('showMostUsed').checked;
    settings.fullscreenMode = document.getElementById('fullscreenMode').checked;
    
    // Apply fullscreen mode
    if (settings.fullscreenMode) {
        document.body.classList.add('fullscreen');
    } else {
        document.body.classList.remove('fullscreen');
    }
    
    saveData();
    preRenderCategories();
    renderCategories();
    showCategory(currentView);
    closeSettings();
}

// Add custom app
function addCustomApp() {
    const name = document.getElementById('customAppName').value.trim();
    const execFile = document.getElementById('customAppExec').files[0];
    const iconFile = document.getElementById('customAppIcon').files[0];
    
    if (!name || !execFile) {
        alert('Please provide app name and executable file');
        return;
    }
    
    const customApp = {
        id: 'custom_' + Date.now(),
        name: name,
        exec: execFile.path,
        icon: iconFile ? iconFile.path : '',
        iconPath: iconFile ? iconFile.path : '',
        comment: 'Custom application',
        category: 'Other',
        terminal: false
    };
    
    customApps.push(customApp);
    allApps.push(customApp);
    
    // Update categories
    if (!allCategories['Other']) {
        allCategories['Other'] = [];
    }
    allCategories['Other'].push(customApp);
    
    saveData();
    preRenderCategories();
    
    // Clear inputs
    document.getElementById('customAppName').value = '';
    document.getElementById('customAppExec').value = '';
    document.getElementById('customAppIcon').value = '';
    
    renderCategories();
    showCategory(currentView);
    
    alert('Custom application added successfully!');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    scanApplications();
    renderCategories();
    showCategory(currentView);
    
    // Apply fullscreen mode if enabled
    if (settings.fullscreenMode) {
        document.body.classList.add('fullscreen');
    }

    // Event listeners
    const searchInput = document.getElementById('searchInput');
    
    // Keyboard typing triggers search
    document.addEventListener('keydown', (e) => {
        // Only trigger if not already focused on input and not a modifier key
        if (document.activeElement !== searchInput && 
            e.key.length === 1 && 
            !e.ctrlKey && 
            !e.metaKey && 
            !e.altKey) {
            searchInput.focus();
        }
    });
    
    searchInput.addEventListener('input', filterApps);
    
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', closeSettings);
    document.getElementById('saveSettings').addEventListener('click', saveSettings);
    document.getElementById('addCustomApp').addEventListener('click', addCustomApp);
    
    document.getElementById('iconSizeSlider').addEventListener('input', (e) => {
        document.getElementById('iconSizeValue').textContent = e.target.value + 'px';
    });
    
    // Context menu
    document.getElementById('contextPin').addEventListener('click', () => {
        if (contextMenuAppId) {
            togglePin(contextMenuAppId);
        }
        hideContextMenu();
    });
    
    document.addEventListener('click', hideContextMenu);
    
    // Close modal on background click
    document.getElementById('settingsModal').addEventListener('click', (e) => {
        if (e.target.id === 'settingsModal') closeSettings();
    });
});