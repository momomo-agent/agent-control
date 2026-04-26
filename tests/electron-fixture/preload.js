const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('testAPI', {
  openSecondWindow: () => ipcRenderer.send('open-second-window')
});
