const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600, webPreferences: { nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
  win.loadFile('index.html');

  // Open second window on IPC request (for multi-window tests)
  ipcMain.on('open-second-window', () => {
    const win2 = new BrowserWindow({ width: 600, height: 400, webPreferences: { nodeIntegration: false } });
    win2.loadFile('second.html');
  });
});
app.on('window-all-closed', () => app.quit());
