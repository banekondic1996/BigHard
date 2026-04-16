const cursorModule = require('./build/Release/cursor_module');

function getCursorPosition() {
    return cursorModule.getCursorPosition();
}

setInterval(() => {
    const pos = getCursorPosition();
    console.log(`Cursor position: x=${pos.x}, y=${pos.y}`);
}, 100);
