'use strict';

/**
 * Preload bridge — the ONLY surface the renderer can touch.
 * contextIsolation stays on and nodeIntegration stays off in main.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listProviders: () => ipcRenderer.invoke('providers:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  newSession: () => ipcRenderer.invoke('session:new'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  getSessionUsage: (id) => ipcRenderer.invoke('session:usage', id),
  getUsageOverview: () => ipcRenderer.invoke('session:usageOverview'),
  sendChat: (text) => ipcRenderer.invoke('chat:send', text),
  abortChat: () => ipcRenderer.invoke('chat:abort'),
  pickParentDir: () => ipcRenderer.invoke('wizard:pickParent'),
  createBounty: (args) => ipcRenderer.invoke('wizard:create', args),
  listMakefunSessions: () => ipcRenderer.invoke('makefun:sessions'),
  selectKitDir: () => ipcRenderer.invoke('makefun:selectKit'),
  makefunBundle: (args) => ipcRenderer.invoke('makefun:bundle', args),
  makefunCheck: (args) => ipcRenderer.invoke('makefun:check', args),
  makefunSubmit: (args) => ipcRenderer.invoke('makefun:submit', args),
  onMakefunLog: (callback) => {
    const listener = (_evt, data) => callback(data);
    ipcRenderer.on('makefun:log', listener);
    return () => ipcRenderer.removeListener('makefun:log', listener);
  },
  onAgentEvent: (callback) => {
    const listener = (_evt, data) => callback(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
