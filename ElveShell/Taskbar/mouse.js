const { spawn } = require('child_process');
const process = spawn('libinput', ['debug-events']);
const ignoreMouse = require('ignore-mouse'); // Your custom module

let virtualCursor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let cursorElement;
let isDragging = false;
let dragElement = null;
let offsetX = 0, offsetY = 0;
let processID=nw.process.ppid;

win.setAlwaysOnTop(true);

// Set the window to be a tooltip to ignore real mouse clicks
console.log('Main process PID:', process.pid);

document.addEventListener('DOMContentLoaded', () => {
    cursorElement = document.createElement('div');
    cursorElement.style.position = 'absolute';
    cursorElement.style.width = '10px';
    cursorElement.style.height = '10px';
    cursorElement.style.borderRadius = '50%';
    cursorElement.style.background = 'red';
    cursorElement.style.pointerEvents = 'none';
    cursorElement.style.zIndex = '9999';
    document.body.appendChild(cursorElement);

    // Create a movable blue square
    let blueSquare = document.createElement('div');
    blueSquare.style.position = 'absolute';
    blueSquare.style.width = '50px';
    blueSquare.style.height = '50px';
    blueSquare.style.background = 'blue';
    blueSquare.style.top = '100px';
    blueSquare.style.left = '100px';
    blueSquare.style.cursor = 'grab';
    document.body.appendChild(blueSquare);
});

process.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
        const match = line.match(/event6\s+POINTER_MOTION\s+\S+\s+\S+\s+(-?\d+\.\d+)\/\s*(-?\d+\.\d+)/);
        if (match) {
            const dx = parseFloat(match[1]);
            const dy = parseFloat(match[2]);
            updateVirtualCursor(dx, dy);
        }
    });
});

function updateVirtualCursor(dx, dy) {
    virtualCursor.x = Math.max(0, Math.min(window.innerWidth, virtualCursor.x + dx));
    virtualCursor.y = Math.max(0, Math.min(window.innerHeight, virtualCursor.y + dy));
    
    
        cursorElement.style.left = `${virtualCursor.x}px`;
        cursorElement.style.top = `${virtualCursor.y}px`;
    
    
    const hoveredElement = document.elementFromPoint(virtualCursor.x, virtualCursor.y);
    
    const moveEvent = new MouseEvent('mousemove', {
        clientX: virtualCursor.x,
        clientY: virtualCursor.y,
        bubbles: true
    });
    hoveredElement?.dispatchEvent(moveEvent);
}

document.addEventListener('mousedown', (e) => {
    const target = document.elementFromPoint(virtualCursor.x, virtualCursor.y);
    if (target && target.style.cursor === 'grab') {
        isDragging = true;
        dragElement = target;
        offsetX = virtualCursor.x - target.offsetLeft;
        offsetY = virtualCursor.y - target.offsetTop;
    }
    const downEvent = new MouseEvent('mousedown', {
        clientX: virtualCursor.x,
        clientY: virtualCursor.y,
        bubbles: true
    });
    target?.dispatchEvent(downEvent);
});

document.addEventListener('mouseup', () => {
    isDragging = false;
    dragElement = null;
});
document.addEventListener('mousemove', () => {
    const target = document.elementFromPoint(virtualCursor.x, virtualCursor.y);
    if (target==document.body.parentElement){
        ignoreMouse.ignoreMouseEvents(processID, true);
        console.log("ignore");
        /* console.log(target); */
    }
    if (isDragging && dragElement) {
        dragElement.style.left = `${virtualCursor.x - offsetX}px`;
        dragElement.style.top = `${virtualCursor.y - offsetY}px`;
    }
    if (target!=document.body.parentElement){
        ignoreMouse.ignoreMouseEvents(processID, false);
        /* console.log(target); */
        console.log("dont ignore");
    }
});

process.on('exit', () => process.kill());
