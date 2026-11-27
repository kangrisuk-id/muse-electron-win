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

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProviders } = require('./src/providers');
const { loadSettings, saveSettings, resolveActive } = require('./src/store');
const { cipherUsable } = require('./src/secrets');

// Stage 6: API keys are encrypted at rest with Electron safeStorage
// (Windows DPAPI / OS keychain). The cipher is only consulted after
// the app is ready; when the OS keychain is unavailable the store
// falls back to the legacy plaintext format (see src/secrets.js).
function settingsCipher() {
  return cipherUsable(safeStorage) ? safeStorage : null;
}
const { SessionStore, historyFromEntries, uiMessagesFromEntries } = require('./src/sessions');
const { createToolRunner } = require('./src/tools');
const { runAgentTurn } = require('./src/agent');
const makefun = require('./src/makefun');
const { summarizeEntries, summarizeSessions } = require('./src/usage');
const { createGit } = require('./src/git');
const tournament = require('./src/tournament');
const { chatCompletion } = require('./src/providers');
const { createBountyProject, DEFAULT_WALLET } = require('./src/wizard');
const { PermissionGate } = require('./src/permissions');
const { searchSessions, sessionToMarkdown } = require('./src/search');

let win = null;
let settings = null;
let sessionStore = null;
let currentSession = null; // {meta, history: []}
let currentAbort = null;
let chatBusy = false;
let makefunBusy = false;

/* --------------------- Stage 7: izin tool ------------------------------ */
// One gate per app run; session grants reset whenever the session or
// workspace changes. Pending approval prompts resolve through
// 'agent:approval-response'; Stop/abort denies everything outstanding,
// and an unanswered prompt times out to DENY (safe default).
const permissionGate = new PermissionGate({ mode: 'tanya', alwaysTools: [] });
const pendingApprovals = new Map(); // id -> {resolve, name}
let approvalSeq = 0;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function denyAllPendingApprovals() {
  for (const entry of pendingApprovals.values()) entry.resolve(false);
  pendingApprovals.clear();
}

function approveToolViaUi(name, args) {
  permissionGate.setPermissions(settings.permissions);
  if (permissionGate.decide(name) === 'allow') return Promise.resolve(true);
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const id = 'appr-' + (++approvalSeq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingApprovals.delete(id)) resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(id, {
      name,
      resolve: (ok) => { clearTimeout(timer); resolve(ok); },
    });
    win.webContents.send('agent:approval-request', {
      id, name, summary: PermissionGate.summarize(name, args), args,
    });
  });
}

ipcMain.on('agent:approval-response', (_evt, payload) => {
  const { id, decision } = payload || {};
  const entry = pendingApprovals.get(id);
  if (!entry) return;
  pendingApprovals.delete(id);
  const { approved, persistAlways } = permissionGate.applyDecision(entry.name, decision);
  if (persistAlways) {
    settings.permissions = permissionGate.permissions;
    saveSettings(userDataDir(), settings, settingsCipher());
  }
  entry.resolve(approved);
});

ipcMain.handle('permissions:get', () => {
  permissionGate.setPermissions(settings.permissions);
  return permissionGate.permissions;
});

ipcMain.handle('permissions:setMode', (_evt, mode) => {
  permissionGate.setPermissions({ ...(settings.permissions || {}), mode });
  settings.permissions = permissionGate.permissions;
  saveSettings(userDataDir(), settings, settingsCipher());
  return settings.permissions;
});

function userDataDir() {
  return app.getPath('userData');
}

function makefunRulesPath() {
  const candidates = [
    process.env.MUSE_MAKEFUN_RULES || '',
    path.join(os.homedir(), 'workspace', 'makefun-agent-rules', '.clinerules'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch (_) { /* try next */ }
  }
  return candidates[candidates.length - 1] || '';
}

function loadMakefunRules() {
  const candidates = [
    makefunRulesPath(),
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
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  settings = loadSettings(userDataDir(), settingsCipher());
  console.log(settingsCipher()
    ? '[settings] Enkripsi API key aktif (safeStorage OS).'
    : '[settings] safeStorage tidak tersedia — API key disimpan format lama (plaintext).');
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
  settings = saveSettings(userDataDir(), next, settingsCipher());
  return publicSettings();
});

ipcMain.handle('workspace:select', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Pilih folder workspace',
  });
  if (result.canceled || !result.filePaths[0]) return settings.workspace || '';
  settings.workspace = result.filePaths[0];
  saveSettings(userDataDir(), settings, settingsCipher());
  // A new workspace starts a fresh session so recordings stay per-workspace.
  currentSession = null;
  permissionGate.resetSession();
  return settings.workspace;
});

ipcMain.handle('session:new', () => {
  currentSession = null;
  permissionGate.resetSession();
  const s = ensureSession();
  return { meta: s.meta, messages: [] };
});

ipcMain.handle('session:list', () => sessionStore.list());

/* --------------------- Stage 10: cari & ekspor sesi -------------------- */

ipcMain.handle('session:search', (_evt, query) => searchSessions(sessionStore, String(query || '')));

ipcMain.handle('session:export', async (_evt, id) => {
  const target = id || (currentSession && currentSession.meta && currentSession.meta.id);
  if (!target) return null;
  const meta = sessionStore.meta(target);
  if (!meta) return null;
  const markdown = sessionToMarkdown(meta, sessionStore.load(target));
  const stamp = String(meta.createdAt || '').slice(0, 10) || 'sesi';
  const result = await dialog.showSaveDialog(win, {
    title: 'Ekspor sesi ke Markdown',
    defaultPath: 'muse-sesi-' + stamp + '-' + String(target).slice(0, 8) + '.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, markdown, 'utf8');
  return result.filePath;
});

/* --------------------- Stage 4: sesi & biaya --------------------------- */

ipcMain.handle('session:usage', (_evt, id) => {
  const target = id || (currentSession && currentSession.meta && currentSession.meta.id);
  if (!target) return null;
  const entries = sessionStore.load(target);
  const meta = sessionStore.meta(target);
  if (!meta) return null;
  return { meta, summary: summarizeEntries(entries) };
});

ipcMain.handle('session:usageOverview', () => {
  const items = sessionStore.list().map((s) => {
    const entries = sessionStore.load(s.id);
    return {
      id: s.id, createdAt: s.createdAt, cwd: s.cwd,
      provider: s.provider, model: s.model, preview: s.preview,
      summary: summarizeEntries(entries),
    };
  });
  return { overview: summarizeSessions(items), sessions: items };
});

/* ----------------- Stage 5: git bawaan + turnamen ---------------------- */

let gitBusy = false;
let tournamentBusy = false;

ipcMain.handle('git:info', async () => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  return createGit(settings.workspace).info();
});

ipcMain.handle('git:commit', async (_evt, { message }) => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  if (gitBusy) throw new Error('Operasi git lain sedang berjalan.');
  gitBusy = true;
  try {
    return await createGit(settings.workspace).commitAll(message);
  } finally {
    gitBusy = false;
  }
});

ipcMain.handle('tournament:generate', async (_evt, { brief, criteria, count }) => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  if (tournamentBusy) throw new Error('Turnamen lain sedang dibuat — tunggu selesai.');
  const active = resolveActive(settings);
  if (!active.apiKey) throw new Error('API key provider aktif belum diisi. Buka Settings.');
  if (!String(brief || '').trim()) throw new Error('Isi brief dulu.');
  tournamentBusy = true;
  try {
    const prompt = tournament.buildCandidatePrompt({ brief, criteria, count });
    const json = await chatCompletion({
      providerId: active.providerId,
      apiKey: active.apiKey,
      model: active.model,
      messages: [
        { role: 'system', content: 'Kamu menghasilkan kandidat teks untuk kontes yang dinilai juri. Patuhi aturan output persis.' },
        { role: 'user', content: prompt },
      ],
    });
    const text = (json.choices[0].message && json.choices[0].message.content) || '';
    const texts = tournament.parseCandidates(text, tournament.clampCount(count));
    if (!texts.length) throw new Error('Model tidak mengembalikan kandidat yang bisa dibaca. Coba lagi.');
    const t = tournament.createTournament({ brief, criteria, texts });
    tournament.saveTournament(settings.workspace, t);
    return t;
  } finally {
    tournamentBusy = false;
  }
});

ipcMain.handle('tournament:list', () => {
  if (!settings.workspace) return [];
  return tournament.listTournaments(settings.workspace);
});

ipcMain.handle('tournament:load', (_evt, id) => {
  if (!settings.workspace) return null;
  return tournament.loadTournament(settings.workspace, id);
});

ipcMain.handle('tournament:save', (_evt, t) => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  if (!t || !t.id || !Array.isArray(t.candidates)) throw new Error('Data turnamen tidak valid.');
  tournament.saveTournament(settings.workspace, t);
  return tournament.loadTournament(settings.workspace, t.id);
});

ipcMain.handle('session:load', (_evt, id) => {
  const entries = sessionStore.load(id);
  const meta = sessionStore.meta(id);
  if (!meta) throw new Error('Sesi tidak ditemukan: ' + id);
  currentSession = { meta, history: rebuildHistory(entries, meta.cwd || settings.workspace || '') };
  const uiMessages = uiMessagesFromEntries(entries, meta.cwd || settings.workspace || '');
  return { meta, messages: uiMessages };
});

/* ---------------------------- Bounty Baru ------------------------------ */

ipcMain.handle('wizard:pickParent', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Pilih folder induk proyek bounty',
  });
  if (result.canceled || !result.filePaths[0]) return '';
  return result.filePaths[0];
});

ipcMain.handle('wizard:create', async (_evt, { parentDir, folderName, slug, wallet }) => {
  const res = createBountyProject({
    parentDir,
    folderName,
    slug,
    wallet: wallet || settings.makefun.wallet || DEFAULT_WALLET,
    rulesSource: makefunRulesPath(),
  });
  // The new project becomes the active workspace (fresh session, same
  // mechanism as workspace:select) so work starts in the right folder.
  settings.workspace = res.dir;
  if (res.slug) settings.makefun.slug = res.slug;
  if (wallet) settings.makefun.wallet = wallet;
  saveSettings(userDataDir(), settings, settingsCipher());
  currentSession = null;
  return res;
});

/* ----------------------------- make.fun -------------------------------- */

function makefunLog(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('makefun:log', evt);
}

async function runMakefunStep(fn) {
  if (makefunBusy) throw new Error('Langkah make.fun lain sedang berjalan — tunggu selesai.');
  makefunBusy = true;
  try {
    return await fn();
  } finally {
    makefunBusy = false;
  }
}

ipcMain.handle('makefun:sessions', () => {
  if (!settings.workspace) return [];
  return makefun.listWorkspaceSessions(settings.workspace);
});

ipcMain.handle('makefun:selectKit', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Pilih folder kit kompetisi make.fun',
  });
  if (result.canceled || !result.filePaths[0]) return '';
  return result.filePaths[0];
});

ipcMain.handle('makefun:bundle', async (_evt, { kitDir, sessionFile }) => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  return runMakefunStep(async () => {
    const res = await makefun.runBundle(
      { workspace: settings.workspace, kitDir, sessionFile },
      makefunLog
    );
    return { code: res.code, outPath: res.outPath, vendor: res.vendor, model: res.model, args: res.args };
  });
});

ipcMain.handle('makefun:check', async (_evt, { kitDir }) => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  return runMakefunStep(async () => {
    const transcripts = path.join(settings.workspace, makefun.BUNDLE_FILENAME);
    if (!fs.existsSync(transcripts)) throw new Error('Bundle belum ada — jalankan Bundle dulu.');
    const res = await makefun.runCheck(
      { workspace: settings.workspace, kitDir, transcripts },
      makefunLog
    );
    return { code: res.code, commit: res.commit, parsed: res.parsed };
  });
});

ipcMain.handle('makefun:submit', async (_evt, { kitDir, slug, repoUrl, title }) => {
  if (!settings.workspace) throw new Error('Pilih folder workspace dulu.');
  return runMakefunStep(async () => {
    const bundlePath = path.join(settings.workspace, makefun.BUNDLE_FILENAME);
    if (!fs.existsSync(bundlePath)) throw new Error('Bundle belum ada — jalankan Bundle dulu.');
    const commit = await makefun.gitHead(settings.workspace);
    if (!commit) throw new Error('Workspace bukan repo git (atau belum ada commit) — commit dulu sebelum submit.');
    const res = await makefun.runSubmit(
      {
        kitDir,
        competition: slug,
        repoUrl,
        commit,
        bundlePath,
        keypairPath: makefun.resolveKeypairPath(settings),
        title,
      },
      makefunLog
    );
    return { code: res.code, submissionId: res.submissionId, claimCode: res.claimCode, checkedLine: res.checkedLine };
  });
});

// Stage 11: links inside rendered Markdown open in the system
// browser — only http(s)/mailto, never arbitrary protocols.
ipcMain.handle('app:openExternal', async (_evt, url) => {
  const u = String(url || '');
  if (/^(https?:\/\/|mailto:)/i.test(u)) {
    await shell.openExternal(u);
    return true;
  }
  return false;
});

ipcMain.handle('chat:abort', () => {
  denyAllPendingApprovals();
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
      approveTool: approveToolViaUi,
      // Stage 9: attaching a delta observer switches the turn to SSE
      // streaming; fragments reach the renderer as 'assistant_delta'
      // events through onEvent below.
      onDelta: () => {},
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
