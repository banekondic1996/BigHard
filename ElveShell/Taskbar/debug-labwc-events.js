// debug-labwc-events.js
// Add this to your shell to see ALL events from labwc

console.log('[DEBUG] ========================================');
console.log('[DEBUG] Event Monitoring Started');
console.log('[DEBUG] ========================================');

// Intercept ALL events from labwcClient
const originalEmit = labwcClient.emit;
labwcClient.emit = function(event, ...args) {
    const timestamp = new Date().toISOString().split('T')[1];
    console.log(`[DEBUG ${timestamp}] 📡 Event: ${event}`, args);
    return originalEmit.call(this, event, ...args);
};

// Also log the raw data handler
const originalHandleMessage = labwcClient.handleMessage;
labwcClient.handleMessage = function(msg) {
    const timestamp = new Date().toISOString().split('T')[1];
    console.log(`[DEBUG ${timestamp}] 📨 Raw message:`, JSON.stringify(msg, null, 2));
    return originalHandleMessage.call(this, msg);
};

// Track minimize command being sent
const originalMinimize = labwcClient.minimizeWindow;
labwcClient.minimizeWindow = function(windowId) {
    console.log('[DEBUG] ⚠️ MINIMIZE COMMAND SENT for:', windowId);
    console.log('[DEBUG] Current window state:', labwcClient.windows.get(windowId));
    return originalMinimize.call(this, windowId);
};

// Track focus command being sent
const originalFocus = labwcClient.focusWindow;
labwcClient.focusWindow = function(windowId) {
    console.log('[DEBUG] ✓ FOCUS COMMAND SENT for:', windowId);
    console.log('[DEBUG] Current window state:', labwcClient.windows.get(windowId));
    return originalFocus.call(this, windowId);
};

// Log window map state periodically
setInterval(() => {
    console.log('[DEBUG] ==========================================');
    console.log('[DEBUG] Current State:');
    console.log('[DEBUG] Windows in labwcClient.windows:', labwcClient.windows.size);
    labwcClient.windows.forEach((win, id) => {
        console.log(`[DEBUG]   - ${id}: ${win.title} (focused: ${win.focused}, minimized: ${win.minimized})`);
    });
    console.log('[DEBUG] Buttons in taskbar:', windowButtons.size);
    windowButtons.forEach((btn, id) => {
        console.log(`[DEBUG]   - ${id}: opacity=${btn.style.opacity}`);
    });
    console.log('[DEBUG] ==========================================');
}, 10000);

console.log('[DEBUG] Event monitoring active');
console.log('[DEBUG] ');
console.log('[DEBUG] TEST PROCEDURE:');
console.log('[DEBUG] 1. Open Firefox');
console.log('[DEBUG] 2. Click minimize button in Firefox window');
console.log('[DEBUG] 3. Watch console for sequence of events');
console.log('[DEBUG] ');
console.log('[DEBUG] EXPECTED SEQUENCE:');
console.log('[DEBUG]   📡 Event: minimized');
console.log('[DEBUG]   Window state - minimized: true');
console.log('[DEBUG]   Button stays in taskbar (opacity: 0.5)');
console.log('[DEBUG] ');
console.log('[DEBUG] PROBLEM SEQUENCE (if you see this, labwc has a bug):');
console.log('[DEBUG]   📡 Event: closed OR unmapped');
console.log('[DEBUG]   removeWindowFromTaskbar called');
console.log('[DEBUG]   Button disappears from taskbar');
console.log('[DEBUG] ');

// Add window to track when taskbar button is clicked
document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-window-id]');
    if (target) {
        const windowId = target.dataset.windowId;
        console.log('[DEBUG] 🖱️ TASKBAR BUTTON CLICKED for:', windowId);
        const win = labwcClient.windows.get(windowId);
        if (win) {
            console.log('[DEBUG] Window state BEFORE click:', {
                focused: win.focused,
                minimized: win.minimized,
                title: win.title
            });
        }
    }
}, true);

console.log('[DEBUG] Ready. Click on taskbar icons to see debug info.');