const cursorModule = require('./build/Release/ignore_mouse_wayland');

// Start X11 mouse ignore for a specific PID
cursorModule.startIgnoreMouseEvents(process.pid); // Example: use your NW.js app's PID

// Start position tracking with initial x, y
cursorModule.startTrackingPosition(500, 300); // Replace with your NW.js app's initial position

// Get cursor position
setInterval(() => {
    const pos = cursorModule.getCursorPosition();
    console.log(`Cursor position: x=${pos.x}, y=${pos.y}`);
}, 100);

// Optionally stop later
// cursorModule.stopIgnoreMouseEvents();
