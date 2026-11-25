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
  sendChat: (text) => ipcRenderer.invoke('chat:send', text),
  abortChat: () => ipcRenderer.invoke('chat:abort'),
  onAgentEvent: (callback) => {
    const listener = (_evt, data) => callback(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
