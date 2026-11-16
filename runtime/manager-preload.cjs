'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentManager', Object.freeze({
  list: () => ipcRenderer.invoke('companion:connectors', { action: 'list' }),
  enable: id => ipcRenderer.invoke('companion:connectors', { action: 'enable', id }),
  enableAll: () => ipcRenderer.invoke('companion:connectors', { action: 'enable-all' }),
  disable: id => ipcRenderer.invoke('companion:connectors', { action: 'disable', id }),
  openApp: id => ipcRenderer.invoke('companion:connectors', { action: 'open', id }),
  onUpdated: callback => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on('companion:connectors-updated', listener);
    return () => ipcRenderer.removeListener('companion:connectors-updated', listener);
  },
}));
