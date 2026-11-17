'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companion', Object.freeze({
  action: body => ipcRenderer.invoke('companion:action', body),
  window: (action, value) => ipcRenderer.invoke('companion:window', action, value),
  onMode: callback => { const listener = (_event, mode) => callback(mode); ipcRenderer.on('companion:mode', listener); return () => ipcRenderer.removeListener('companion:mode', listener); },
  onUpdated: callback => { const listener = () => callback(); ipcRenderer.on('companion:updated', listener); return () => ipcRenderer.removeListener('companion:updated', listener); },
}));
