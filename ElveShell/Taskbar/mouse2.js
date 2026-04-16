
/* const ignoreMouse = require('ignore-mouse'); // Your custom module */
const ignoreMouse = require('ignore-mouse-wayland');
let processID=nw.process.ppid;

// Set the window to be a tooltip to ignore real mouse clicks
console.log('Main process PID:', process.pid);

ignoreMouse.startIgnoreMouseEvents(processID);

try {
    ignoreMouse.startTrackingPosition(500, 300); // Replace with your NW.js app's initial position
} catch (error) {
    console.error("Error starting position tracking:", error);
}
// Get cursor position
setInterval(() => {
    const pos = ignoreMouse.getCursorPosition();
    console.log(`Cursor position: x=${pos.x}, y=${pos.y}`);
}, 100);

