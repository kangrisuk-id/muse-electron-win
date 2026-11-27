'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ENC_PREFIX, isEncryptedValue, cipherUsable,
  encryptValue, decryptValue,
  encryptSettingsSecrets, decryptSettingsSecrets, hasEncryptedSecrets,
} = require('../src/secrets');
const { loadSettings, saveSettings, defaultSettings, settingsPath } = require('../src/store');

// A reversible fake cipher with the exact Electron safeStorage shape:
// encryptString returns a Buffer whose bytes are the UTF-8 of the plain
// text with each byte XORed — enough to prove round-trip + format
// without any OS keychain.
function fakeCipher() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ 0x5a)).toString('utf8'),
  };
}
const noCipher = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('x'); }, decryptString: () => { throw new Error('x'); } };

function sampleSettings() {
  const s = defaultSettings();
  s.providers.gemini.apiKey = 'AIza-test-key-123';
  s.providers.nvidia.apiKey = 'nvapi-xyz';
  s.workspace = '/tmp/ws';
  return s;
}

test('encrypt/decrypt round-trips and uses the enc:v1: format', () => {
  const c = fakeCipher();
  const enc = encryptValue('sk-secret', c);
  assert.ok(enc.startsWith(ENC_PREFIX));
  assert.ok(isEncryptedValue(enc));
  assert.ok(!enc.includes('sk-secret'), 'cipher text must not contain the plain key');
  assert.equal(decryptValue(enc, c), 'sk-secret');
  assert.equal(encryptValue('', c), '');
  assert.equal(encryptValue(enc, c), enc, 'never double-encrypts');
});

test('without a usable cipher, values stay plaintext (documented fallback)', () => {
  assert.equal(cipherUsable(null), false);
  assert.equal(cipherUsable(noCipher), false);
  assert.equal(cipherUsable(fakeCipher()), true);
  assert.equal(encryptValue('sk-plain', null), 'sk-plain');
  assert.equal(encryptValue('sk-plain', noCipher), 'sk-plain');
});

test('legacy plaintext loads as-is; foreign cipher text loads as empty', () => {
  const c = fakeCipher();
  assert.equal(decryptValue('sk-legacy', c), 'sk-legacy');
  assert.equal(decryptValue('sk-legacy', null), 'sk-legacy');
  const enc = encryptValue('sk-secret', c);
  assert.equal(decryptValue(enc, null), '', 'encrypted value without cipher = unset, not leaked');
  assert.equal(decryptValue(enc, noCipher), '');
  const corrupt = ENC_PREFIX + Buffer.from('bukan cipher text valid ###').toString('base64');
  const strictCipher = {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from(p),
    decryptString: () => { throw new Error('decrypt failed'); },
  };
  assert.equal(decryptValue(corrupt, strictCipher), '', 'corrupt cipher text = unset, no crash');
});

test('settings mapping encrypts ONLY provider apiKey fields', () => {
  const c = fakeCipher();
  const s = sampleSettings();
  const enc = encryptSettingsSecrets(s, c);
  assert.ok(isEncryptedValue(enc.providers.gemini.apiKey));
  assert.ok(isEncryptedValue(enc.providers.nvidia.apiKey));
  assert.equal(enc.providers.openai.apiKey, '', 'empty keys stay empty');
  assert.equal(enc.workspace, '/tmp/ws', 'non-secret fields untouched');
  assert.equal(enc.providers.gemini.model, s.providers.gemini.model);
  assert.equal(s.providers.gemini.apiKey, 'AIza-test-key-123', 'input settings not mutated');
  assert.ok(hasEncryptedSecrets(enc));
  assert.ok(!hasEncryptedSecrets(s));
  const back = decryptSettingsSecrets(enc, c);
  assert.deepEqual(back, s);
});

test('store integration: disk holds cipher text, memory holds plaintext, legacy migrates', () => {
  const c = fakeCipher();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-store-'));
  const s = sampleSettings();

  const returned = saveSettings(dir, s, c);
  assert.equal(returned.providers.gemini.apiKey, 'AIza-test-key-123', 'returned settings keep plaintext');
  const onDisk = JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'));
  assert.ok(isEncryptedValue(onDisk.providers.gemini.apiKey), 'disk is encrypted');
  assert.ok(!JSON.stringify(onDisk).includes('AIza-test-key-123'), 'no plaintext key anywhere on disk');

  const loaded = loadSettings(dir, c);
  assert.equal(loaded.providers.gemini.apiKey, 'AIza-test-key-123');
  assert.equal(loaded.providers.nvidia.apiKey, 'nvapi-xyz');

  // Legacy file (no cipher at save time) loads with any cipher and is
  // encrypted by the next save — transparent migration.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-store-legacy-'));
  saveSettings(dir2, s, null);
  const legacyDisk = JSON.parse(fs.readFileSync(settingsPath(dir2), 'utf8'));
  assert.equal(legacyDisk.providers.gemini.apiKey, 'AIza-test-key-123', 'no cipher = legacy format');
  const migrated = loadSettings(dir2, c);
  assert.equal(migrated.providers.gemini.apiKey, 'AIza-test-key-123');
  saveSettings(dir2, migrated, c);
  const migratedDisk = JSON.parse(fs.readFileSync(settingsPath(dir2), 'utf8'));
  assert.ok(isEncryptedValue(migratedDisk.providers.gemini.apiKey), 'migrated on next save');

  // Encrypted file opened where the keychain is gone: keys read as
  // empty (user re-enters), everything else survives.
  const orphaned = loadSettings(dir, null);
  assert.equal(orphaned.providers.gemini.apiKey, '');
  assert.equal(orphaned.workspace, '/tmp/ws');
});
