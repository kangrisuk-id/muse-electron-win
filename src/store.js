'use strict';

/**
 * Settings persistence: one JSON file in the app's userData folder.
 *
 * Shape:
 * {
 *   activeProvider: 'gemini',
 *   providers: {
 *     gemini:     { apiKey: '', model: 'gemini-3.5-flash', customModel: '' },
 *     openai:     { apiKey: '', model: 'gpt-4o',          customModel: '' },
 *     openrouter: { apiKey: '', model: 'anthropic/claude-sonnet-4', customModel: '' },
 *     nvidia:     { apiKey: '', model: 'meta/llama-3.3-70b-instruct', customModel: '' }
 *   },
 *   workspace: '',
 *   makefunMode: false,
 *   makefun: { kitDir: '', keypairPath: '', slug: '', repoUrl: '', title: '',
 *              wallet: '' }
 * }
 *
 * makefun.wallet is the PUBLIC agent wallet address used by the
 * "Bounty Baru" wizard for .makefun/owner.json; empty means the wizard's
 * built-in default. It is a public address, never a key.
 *
 * makefun.keypairPath is a PATH only (default ~/.makefun/
 * makefun-keypair.json); the keypair file itself is read solely by the
 * kit CLI at submit time, never by this app.
 *
 * API keys live ONLY in this local file and are sent ONLY to their own
 * provider's endpoint. Since Stage 6 they are stored ENCRYPTED at rest
 * (Electron safeStorage / OS keychain, "enc:v1:…" values — see
 * src/secrets.js) whenever the OS keychain is available; plaintext is
 * kept in memory only. Without a keychain the legacy plaintext format
 * is the documented fallback.
 */

const fs = require('fs');
const path = require('path');
const { PROVIDER_ORDER, defaultModel } = require('./providers');
const { encryptSettingsSecrets, decryptSettingsSecrets } = require('./secrets');

function defaultSettings() {
  const providers = {};
  for (const id of PROVIDER_ORDER) {
    providers[id] = { apiKey: '', model: defaultModel(id), customModel: '' };
  }
  return {
    activeProvider: 'gemini',
    providers,
    workspace: '',
    permissions: { mode: 'tanya', alwaysTools: [] },
    makefunMode: false,
    makefun: { kitDir: '', keypairPath: '', slug: '', repoUrl: '', title: '', wallet: '' },
  };
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

/**
 * Load settings. `cipher` (optional) is an Electron-safeStorage-shaped
 * object: encrypted apiKey values ("enc:v1:…") are decrypted into
 * memory; plaintext values from older versions pass through and are
 * encrypted on the next save (transparent migration).
 */
function loadSettings(userDataDir, cipher) {
  const base = defaultSettings();
  const file = settingsPath(userDataDir);
  if (!fs.existsSync(file)) return base;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = {
      ...base, ...raw,
      providers: { ...base.providers },
      permissions: { ...base.permissions, ...(raw.permissions || {}) },
      makefun: { ...base.makefun, ...(raw.makefun || {}) },
    };
    for (const id of PROVIDER_ORDER) {
      if (raw.providers && raw.providers[id]) {
        merged.providers[id] = { ...base.providers[id], ...raw.providers[id] };
      }
    }
    if (!PROVIDER_ORDER.includes(merged.activeProvider)) merged.activeProvider = 'gemini';
    return decryptSettingsSecrets(merged, cipher);
  } catch (_) {
    return base;
  }
}

/**
 * Save settings. With a usable `cipher`, apiKey fields are written to
 * disk encrypted ("enc:v1:…"); the RETURNED settings keep plaintext
 * keys in memory so the running app never re-reads cipher text. Without
 * a cipher the file format is the legacy plaintext one.
 */
function saveSettings(userDataDir, settings, cipher) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const onDisk = encryptSettingsSecrets(settings, cipher);
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(onDisk, null, 2), 'utf8');
  return settings;
}

/** Resolve the effective {providerId, apiKey, model} for the active provider. */
function resolveActive(settings) {
  const providerId = settings.activeProvider;
  const p = (settings.providers && settings.providers[providerId]) || {};
  const model = (p.customModel && p.customModel.trim()) || p.model || defaultModel(providerId);
  return { providerId, apiKey: p.apiKey || '', model };
}

module.exports = { defaultSettings, loadSettings, saveSettings, resolveActive, settingsPath };
