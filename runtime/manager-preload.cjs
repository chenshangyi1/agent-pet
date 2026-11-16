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
  onUpdated: callback => subscribe('companion:connectors-updated', callback),
  onTab: callback => subscribe('companion:manager-tab', callback),
  bot: Object.freeze({
    state: () => ipcRenderer.invoke('companion:bot', { action: 'state' }),
    save: config => ipcRenderer.invoke('companion:bot', { action: 'save', config }),
    regeneratePairing: () => ipcRenderer.invoke('companion:bot', { action: 'pair' }),
    testPush: channel => ipcRenderer.invoke('companion:bot', { action: 'test', channel }),
    stopJob: jobId => ipcRenderer.invoke('companion:bot', { action: 'stop-job', jobId }),
    browseCwd: () => ipcRenderer.invoke('companion:bot', { action: 'browse-cwd' }),
    onUpdated: callback => subscribe('companion:bot-updated', callback),
  }),
}));
