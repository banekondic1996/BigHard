const { spawn } = require('child_process');
const path = require('path');

const nwCommand = process.platform === 'win32' ? 'nw.cmd' : 'nw';
const apps = [
  path.resolve(__dirname, '..', 'ElveShell', 'Desktop'),
  path.resolve(__dirname, '..', 'ElveShell', 'Taskbar')
];

function launchApp(appPath) {
  const child = spawn(nwCommand, [appPath], {
    cwd: path.resolve(__dirname, '..'),
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (error) => {
    console.error(`[start-nw] Failed to launch ${appPath}:`, error.message);
    process.exitCode = 1;
  });

  child.unref();
}

launchApp(apps[0]);
setTimeout(() => launchApp(apps[1]), 2200);
