'use strict';

/**
 * Stage 6 — API key encryption at rest via Electron safeStorage.
 *
 * The cipher is INJECTED: anything shaped like Electron's safeStorage
 * ({isEncryptionAvailable(), encryptString(plain) -> Buffer,
 * decryptString(buf) -> string}) works, which keeps this module pure
 * and unit-testable without Electron. main.js passes the real
 * `safeStorage` from the electron module.
 *
 * On-disk format: an encrypted key is stored as the string
 *   "enc:v1:<base64 of cipher bytes>"
 * in the same apiKey field that used to hold plaintext. Everything
 * else about settings.json is unchanged.
 *
 * Behaviour contract:
 *  - Encryption available: save encrypts, load decrypts. A legacy
 *    plaintext key loads as-is and is encrypted on the next save
 *    (transparent migration, no user action).
 *  - Encryption NOT available (e.g. Linux without a keyring): keys are
 *    stored as plaintext, exactly the pre-Stage-6 behaviour — the app
 *    keeps working and nothing is silently lost. The caller can check
 *    encryptionStatus() to surface this in the UI/logs.
 *  - A value that claims to be encrypted but cannot be decrypted
 *    (keychain changed, file copied from another machine/user) loads
 *    as an EMPTY key instead of crashing or leaking cipher text into
 *    an API request; the user simply re-enters the key.
 *  - Only providers.<id>.apiKey fields are treated as secrets. Models,
 *    workspace, makefun paths and the PUBLIC wallet address are never
 *    encrypted.
 */

const ENC_PREFIX = 'enc:v1:';

function isEncryptedValue(v) {
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

function cipherUsable(cipher) {
  if (!cipher) return false;
  try {
    return typeof cipher.isEncryptionAvailable === 'function'
      && cipher.isEncryptionAvailable()
      && typeof cipher.encryptString === 'function'
      && typeof cipher.decryptString === 'function';
  } catch (_) {
    return false;
  }
}

function encryptValue(plain, cipher) {
  const v = typeof plain === 'string' ? plain : '';
  if (!v) return '';
  if (isEncryptedValue(v)) return v; // never double-encrypt
  if (!cipherUsable(cipher)) return v; // documented plaintext fallback
  const buf = cipher.encryptString(v);
  return ENC_PREFIX + Buffer.from(buf).toString('base64');
}

function decryptValue(stored, cipher) {
  const v = typeof stored === 'string' ? stored : '';
  if (!v) return '';
  if (!isEncryptedValue(v)) return v; // legacy plaintext passes through
  if (!cipherUsable(cipher)) return ''; // cannot open it here; treat as unset
  try {
    const buf = Buffer.from(v.slice(ENC_PREFIX.length), 'base64');
    return cipher.decryptString(buf);
  } catch (_) {
    return ''; // foreign/corrupt cipher text: unset, never leak it onward
  }
}

function mapApiKeys(settings, fn) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings, providers: { ...(settings.providers || {}) } };
  for (const id of Object.keys(out.providers)) {
    const p = out.providers[id];
    if (p && typeof p === 'object' && typeof p.apiKey === 'string') {
      out.providers[id] = { ...p, apiKey: fn(p.apiKey) };
    }
  }
  return out;
}

/** Deep-copied settings with every apiKey encrypted for disk. */
function encryptSettingsSecrets(settings, cipher) {
  return mapApiKeys(settings, (v) => encryptValue(v, cipher));
}

/** Deep-copied settings with every apiKey decrypted for use. */
function decryptSettingsSecrets(settings, cipher) {
  return mapApiKeys(settings, (v) => decryptValue(v, cipher));
}

/** True when at least one stored apiKey is in encrypted form. */
function hasEncryptedSecrets(settings) {
  if (!settings || !settings.providers) return false;
  return Object.values(settings.providers).some((p) => p && isEncryptedValue(p.apiKey));
}

module.exports = {
  ENC_PREFIX,
  isEncryptedValue,
  cipherUsable,
  encryptValue,
  decryptValue,
  encryptSettingsSecrets,
  decryptSettingsSecrets,
  hasEncryptedSecrets,
};
