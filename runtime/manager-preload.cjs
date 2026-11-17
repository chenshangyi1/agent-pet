'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('agentManager', Object.freeze({
  list: () => ipcRenderer.invoke('companion:connectors', { action: 'list' }),
  enable: id => ipcRenderer.invoke('companion:connectors', { action: 'enable', id }),
  enableAll: () => ipcRenderer.invoke('companion:connectors', { action: 'enable-all' }),
  disable: id => ipcRenderer.invoke('companion:connectors', { action: 'disable', id }),
  openApp: id => ipcRenderer.invoke('companion:connectors', { action: 'open', id }),
  getAutoStart: () => ipcRenderer.invoke('companion:connectors', { action: 'autostart-state' }),
  setAutoStart: enabled => ipcRenderer.invoke('companion:connectors', { action: 'autostart', enabled: !!enabled }),
  onUpdated: callback => subscribe('companion:connectors-updated', callback),
  onAutoStartUpdated: callback => subscribe('companion:autostart-updated', callback),
}));
