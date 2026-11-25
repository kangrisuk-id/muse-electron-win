'use strict';

/**
 * Muse Agent Desktop — Electron main process.
 *
 * Owns: settings (userData/settings.json), the session store, the workspace
 * selection, and the agent loop. The renderer talks to this process only
 * through the preload bridge (contextIsolation on, nodeIntegration off).
 *
 * This is the user's own app running on the user's own API keys.
 * It is NOT an official Meta app.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProviders } = require('./src/providers');
const { loadSettings, saveSettings, resolveActive } = require('./src/store');
const { SessionStore, historyFromEntries, uiMessagesFromEntries } = require('./src/sessions');
const { createToolRunner } = require('./src/tools');
const { runAgentTurn } = require('./src/agent');

let win = null;
let settings = null;
let sessionStore = null;
let currentSession = null; // {meta, history: []}
let currentAbort = null;
let chatBusy = false;

function userDataDir() {
  return app.getPath('userData');
}

function loadMakefunRules() {
  const candidates = [
    process.env.MUSE_MAKEFUN_RULES || '',
    path.join(os.homedir(), 'workspace', 'makefun-agent-rules', '.clinerules'),
    path.join(__dirname, 'assets', 'makefun-rules.txt'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch (_) { /* try next */ }
  }
  return null;
}

function publicSettings() {
  // The renderer needs the keys to show them in the Settings form (masked
  // password inputs). Keys never leave this machine except to their provider.
  return JSON.parse(JSON.stringify(settings));
}

function ensureSession() {
  if (currentSession) return currentSession;
  const active = resolveActive(settings);
  const meta = sessionStore.create({
    cwd: settings.workspace || '',
    provider: active.providerId,
    model: active.model,
  });
  currentSession = { meta, history: [] };
  return currentSession;
}

function rebuildHistory(entries, workspaceRoot) {
  // Handles both the current block-shaped recording and v1 session files.
  return historyFromEntries(entries, workspaceRoot);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'Muse Agent Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  settings = loadSettings(userDataDir());
  sessionStore = new SessionStore(userDataDir());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------- IPC ---------------------------------- */

ipcMain.handle('providers:list', () => listProviders());

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:save', (_evt, next) => {
  settings = saveSettings(userDataDir(), next);
  return publicSettings();
});

ipcMain.handle('workspace:select', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Pilih folder workspace',
  });
  if (result.canceled || !result.filePaths[0]) return settings.workspace || '';
  settings.workspace = result.filePaths[0];
  saveSettings(userDataDir(), settings);
  // A new workspace starts a fresh session so recordings stay per-workspace.
  currentSession = null;
  return settings.workspace;
});

ipcMain.handle('session:new', () => {
  currentSession = null;
  const s = ensureSession();
  return { meta: s.meta, messages: [] };
});

ipcMain.handle('session:list', () => sessionStore.list());

ipcMain.handle('session:load', (_evt, id) => {
  const entries = sessionStore.load(id);
  const meta = sessionStore.meta(id);
  if (!meta) throw new Error('Sesi tidak ditemukan: ' + id);
  currentSession = { meta, history: rebuildHistory(entries, meta.cwd || settings.workspace || '') };
  const uiMessages = uiMessagesFromEntries(entries, meta.cwd || settings.workspace || '');
  return { meta, messages: uiMessages };
});

ipcMain.handle('chat:abort', () => {
  if (currentAbort) currentAbort.abort();
  return true;
});

ipcMain.handle('chat:send', async (_evt, text) => {
  if (chatBusy) throw new Error('Agent sedang bekerja — tunggu atau tekan Stop.');
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu (tombol Workspace).');
  const active = resolveActive(settings);
  if (!active.apiKey) {
    throw new Error('API key provider aktif belum diisi. Buka Settings.');
  }
  const session = ensureSession();
  // Keep the session header honest about which model is doing the work.
  session.meta.provider = active.providerId;
  session.meta.model = active.model;
  session.meta.cwd = settings.workspace;

  const toolRunner = createToolRunner(settings.workspace);
  session.history.push({ role: 'user', content: String(text || '') });

  chatBusy = true;
  currentAbort = new AbortController();
  try {
    const result = await runAgentTurn({
      providerId: active.providerId,
      apiKey: active.apiKey,
      model: active.model,
      history: session.history,
      toolRunner,
      session: { store: sessionStore, meta: session.meta },
      workspace: settings.workspace,
      makefunRules: settings.makefunMode ? loadMakefunRules() : null,
      signal: currentAbort.signal,
      onEvent: (evt) => {
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', evt);
      },
    });
    return { ok: true, finalText: result.finalText, sessionId: session.meta.id };
  } finally {
    chatBusy = false;
    currentAbort = null;
  }
});
