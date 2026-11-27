'use strict';

/* Muse Agent Desktop — renderer (vanilla JS, talks to main via window.api). */

const $ = (id) => document.getElementById(id);

let providers = [];
let settings = null;
let busy = false;
let currentSessionId = null;
const pendingTools = new Map(); // toolCallId -> <details> element

/* ------------------------------ helpers ------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function scrollDown() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const who = role === 'user' ? 'Kamu' : role === 'error' ? 'Error' : 'Agent';
  div.innerHTML = '<span class="who">' + who + '</span>' + esc(content);
  $('messages').appendChild(div);
  scrollDown();
  return div;
}

function addToolCall(id, name, args) {
  const details = document.createElement('details');
  details.className = 'tool';
  const argsText = JSON.stringify(args || {});
  details.innerHTML =
    '<summary>🔧 ' + esc(name) + ' <span class="args">' + esc(argsText.slice(0, 120)) + '</span></summary>' +
    '<pre class="args-full">' + esc(argsText) + '</pre>' +
    '<pre class="result">menunggu hasil…</pre>';
  $('messages').appendChild(details);
  if (id) pendingTools.set(id, details);
  scrollDown();
}

function fillToolResult(id, name, result, isError) {
  const details = (id && pendingTools.get(id)) || null;
  if (!details) {
    addToolCall(null, name, {});
    const all = document.querySelectorAll('details.tool');
    const last = all[all.length - 1];
    last.querySelector('.result').textContent = (isError ? 'ERROR\n' : '') + result;
    return;
  }
  const pre = details.querySelector('.result');
  pre.textContent = (isError ? 'ERROR\n' : '') + result;
  if (isError) pre.style.color = '#e0655f';
  pendingTools.delete(id);
  scrollDown();
}

/* ------------------------------ header -------------------------------- */

function effectiveModel(p) {
  const s = settings.providers[p.id] || {};
  return (s.customModel && s.customModel.trim()) || s.model || (p.models[0] && p.models[0].id) || '';
}

function renderHeader() {
  const active = providers.find((p) => p.id === settings.activeProvider) || providers[0];
  if (active) {
    $('activeInfo').textContent = active.label + ' · ' + effectiveModel(active);
  }
  $('workspacePath').textContent = settings.workspace || 'belum dipilih';
  $('workspacePath').title = settings.workspace || '';
  $('makefunToggle').checked = !!settings.makefunMode;
}

/* ----------------------------- sessions ------------------------------- */

async function refreshSessions() {
  const list = await window.api.listSessions();
  const box = $('sessionList');
  box.innerHTML = '';
  for (const s of list) {
    const div = document.createElement('div');
    div.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString('id-ID') : '';
    const usageMeta = s.usage && s.usage.totalTokens
      ? ' · ' + fmtTokens(s.usage.totalTokens) + ' token · ' + fmtUSD(s.usage.costUSD) : '';
    div.innerHTML =
      '<div class="s-preview">' + esc(s.preview || '(sesi kosong)') + '</div>' +
      '<div class="s-meta">' + esc(when) + ' · ' + esc(s.provider || '') + ' · ' + s.messages + ' pesan' + esc(usageMeta) + '</div>';
    div.title = s.cwd || '';
    div.onclick = () => loadSession(s.id);
    box.appendChild(div);
  }
}

async function loadSession(id) {
  const { meta, messages } = await window.api.loadSession(id);
  currentSessionId = meta.id;
  $('messages').innerHTML = '';
  pendingTools.clear();
  for (const e of messages) {
    if (e.type === 'user' && e.message) addMessage('user', e.message.content || '');
    else if (e.type === 'assistant' && e.message && e.message.content) addMessage('assistant', e.message.content);
    else if (e.type === 'tool_use') addToolCall(null, e.name, e.args);
    else if (e.type === 'tool_result') fillToolResult(null, e.name, e.result || '', e.isError);
  }
  await refreshSessions();
}

/* ------------------------- Stage 4: usage panel ------------------------ */

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + ' rb';
  return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + ' jt';
}

function fmtUSD(c) {
  if (c === null || c === undefined) return '—';
  const v = Number(c);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

function fmtDuration(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return s + ' dtk';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' mnt ' + (s % 60) + ' dtk';
  return Math.floor(m / 60) + ' jam ' + (m % 60) + ' mnt';
}

function usageCard(label, value, sub) {
  return '<div class="usage-card"><div class="u-value">' + esc(value) + '</div>' +
    '<div class="u-label">' + esc(label) + '</div>' +
    (sub ? '<div class="u-sub">' + esc(sub) + '</div>' : '') + '</div>';
}

async function openUsage() {
  const data = await window.api.getUsageOverview();
  const o = data.overview;
  $('usageOverview').innerHTML =
    usageCard('Total token', fmtTokens(o.totalTokens), fmtTokens(o.inputTokens) + ' masuk · ' + fmtTokens(o.outputTokens) + ' keluar') +
    usageCard('Estimasi biaya', fmtUSD(o.costUSD), o.unpricedTokens ? fmtTokens(o.unpricedTokens) + ' token belum terharga' : 'semua turn terharga') +
    usageCard('Sesi', String(o.sessions), o.assistantTurns + ' turn asisten · ' + o.toolCalls + ' tool call');

  const cur = currentSessionId ? await window.api.getSessionUsage(currentSessionId) : null;
  if (cur && cur.summary) {
    const s = cur.summary;
    $('usageCurrent').textContent =
      (cur.meta.provider || '?') + ' · ' + (cur.meta.model || '?') +
      '\nToken: ' + fmtTokens(s.inputTokens) + ' masuk · ' + fmtTokens(s.outputTokens) + ' keluar' +
      (s.cacheReadTokens ? ' · cache baca ' + fmtTokens(s.cacheReadTokens) : '') +
      '\nEstimasi: ' + fmtUSD(s.costUSD) +
      (s.unpricedTokens ? ' (+ ' + fmtTokens(s.unpricedTokens) + ' token belum terharga)' : '') +
      '\nAktivitas: ' + s.userMessages + ' pesan user · ' + s.assistantTurns + ' turn · ' +
      s.toolCalls + ' tool call · ' + s.toolResults + ' hasil · durasi ' + fmtDuration(s.durationMs);
    const rows = s.turns.map((t, i) =>
      '<tr><td>' + (i + 1) + '</td><td>' + esc(t.timestamp ? new Date(t.timestamp).toLocaleTimeString('id-ID') : '') +
      '</td><td>' + esc(t.model || '') + '</td><td>' + fmtTokens(t.inputTokens) + '</td><td>' +
      fmtTokens(t.outputTokens) + '</td><td>' + fmtUSD(t.costUSD) + '</td></tr>').join('');
    $('usageTurns').innerHTML = s.turns.length
      ? '<table class="usage-table"><thead><tr><th>#</th><th>Waktu</th><th>Model</th><th>Masuk</th><th>Keluar</th><th>Estimasi</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p class="hint">Sesi ini belum punya turn ber-usage tercatat.</p>';
  } else {
    $('usageCurrent').textContent = 'Belum ada sesi aktif.';
    $('usageTurns').innerHTML = '';
  }

  const items = data.sessions.map((it) => {
    const s = it.summary;
    const when = it.createdAt ? new Date(it.createdAt).toLocaleString('id-ID') : '';
    return '<div class="session-item' + (it.id === currentSessionId ? ' active' : '') + '" data-usage-session="' + esc(it.id) + '">' +
      '<div class="s-preview">' + esc(it.preview || '(sesi kosong)') + '</div>' +
      '<div class="s-meta">' + esc(when) + ' · ' + esc(it.provider || '') + '/' + esc(it.model || '') + '</div>' +
      '<div class="s-meta">' + fmtTokens(s.totalTokens) + ' token · ' + fmtUSD(s.costUSD) +
      (s.unpricedTokens ? ' · ' + fmtTokens(s.unpricedTokens) + ' belum terharga' : '') +
      ' · ' + s.toolCalls + ' tool · ' + fmtDuration(s.durationMs) + '</div></div>';
  }).join('');
  $('usageSessions').innerHTML = items || '<p class="hint">Belum ada sesi tersimpan.</p>';
  document.querySelectorAll('[data-usage-session]').forEach((el) => {
    el.onclick = async () => {
      $('usageOverlay').classList.add('hidden');
      await loadSession(el.getAttribute('data-usage-session'));
    };
  });
  $('usageOverlay').classList.remove('hidden');
}

/* ------------------------------ settings ------------------------------ */

function renderSettingsForm() {
  const wrap = $('providerForms');
  wrap.innerHTML = '';
  for (const p of providers) {
    const s = settings.providers[p.id] || { apiKey: '', model: '', customModel: '' };
    const card = document.createElement('div');
    card.className = 'provider-card' + (settings.activeProvider === p.id ? ' active' : '');
    const options = p.models
      .map((m) => '<option value="' + esc(m.id) + '"' + (s.model === m.id ? ' selected' : '') + '>' + esc(m.label) + '</option>')
      .join('');
    card.innerHTML =
      '<h3>' + esc(p.label) +
      '  <label class="active-radio"><input type="radio" name="activeProvider" value="' + p.id + '"' +
      (settings.activeProvider === p.id ? ' checked' : '') + '> Provider aktif</label></h3>' +
      '<label>API Key</label>' +
      '<input type="password" data-field="apiKey" data-provider="' + p.id + '" value="' + esc(s.apiKey) + '" placeholder="tempel API key di sini" autocomplete="off" />' +
      '<div class="key-hint">' + esc(p.keyHint) + '<br>Endpoint: ' + esc(p.baseUrl) + '</div>' +
      '<label>Model</label>' +
      '<select data-field="model" data-provider="' + p.id + '">' + options + '</select>' +
      '<label>Model kustom (opsional — menimpa dropdown)</label>' +
      '<input type="text" data-field="customModel" data-provider="' + p.id + '" value="' + esc(s.customModel) + '" placeholder="mis. nama model lain dari provider ini" autocomplete="off" />';
    wrap.appendChild(card);
  }
}

function collectSettings() {
  const next = JSON.parse(JSON.stringify(settings));
  const active = document.querySelector('input[name="activeProvider"]:checked');
  if (active) next.activeProvider = active.value;
  document.querySelectorAll('[data-field]').forEach((el) => {
    const pid = el.getAttribute('data-provider');
    const field = el.getAttribute('data-field');
    if (!next.providers[pid]) next.providers[pid] = {};
    next.providers[pid][field] = el.value;
  });
  return next;
}

/* -------------------------------- chat -------------------------------- */

async function send() {
  const text = $('input').value.trim();
  if (!text || busy) return;
  if (!settings.workspace) {
    addMessage('error', 'Pilih folder workspace dulu lewat tombol Workspace di atas.');
    return;
  }
  $('input').value = '';
  addMessage('user', text);
  busy = true;
  $('sendBtn').disabled = true;
  $('stopBtn').disabled = false;
  try {
    await window.api.sendChat(text);
  } catch (err) {
    addMessage('error', err && err.message ? err.message : String(err));
  } finally {
    busy = false;
    $('sendBtn').disabled = false;
    $('stopBtn').disabled = true;
    await refreshSessions();
  }
}

/* ------------------------------ make.fun ------------------------------ */

let mfBusy = false;
let mfSubmitArmed = false;
let mfArmTimer = null;

function mfLog(text, isErr) {
  const pre = $('mfLog');
  const span = document.createElement('span');
  if (isErr) span.className = 'err';
  span.textContent = text + '\n';
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
}

function mfSummary(text, kind) {
  const box = $('mfSummary');
  box.textContent = text;
  box.className = 'mf-summary' + (kind ? ' ' + kind : '');
}

function mfDisarm() {
  mfSubmitArmed = false;
  if (mfArmTimer) { clearTimeout(mfArmTimer); mfArmTimer = null; }
  const btn = $('mfSubmitBtn');
  btn.classList.remove('armed');
  btn.textContent = '3 · Submit';
}

function mfSetBusy(busy) {
  mfBusy = busy;
  for (const id of ['mfBundleBtn', 'mfCheckBtn', 'mfSubmitBtn']) $(id).disabled = busy;
}

function mfCollect() {
  if (!settings.makefun) settings.makefun = {};
  settings.makefun.kitDir = $('mfKitDir').value.trim();
  settings.makefun.slug = $('mfSlug').value.trim();
  settings.makefun.repoUrl = $('mfRepoUrl').value.trim();
  settings.makefun.title = $('mfTitle').value.trim();
  settings.makefun.keypairPath = $('mfKeypair').value.trim();
  return settings.makefun;
}

async function mfPersist() {
  mfCollect();
  settings = await window.api.saveSettings(settings);
}

async function refreshMfSessions() {
  const list = await window.api.listMakefunSessions();
  const sel = $('mfSession');
  sel.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(belum ada sesi terekam di workspace ini)';
    sel.appendChild(opt);
    return;
  }
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.file;
    const when = s.createdAt ? new Date(s.createdAt).toLocaleString('id-ID') : '';
    opt.textContent = when + ' · ' + (s.provider || '?') + '/' + (s.model || '?') + ' · ' + (s.preview || '(tanpa prompt)');
    sel.appendChild(opt);
  }
}

async function openMakefun() {
  const mf = settings.makefun || {};
  $('mfKitDir').value = mf.kitDir || '';
  $('mfSlug').value = mf.slug || '';
  $('mfRepoUrl').value = mf.repoUrl || '';
  $('mfTitle').value = mf.title || '';
  $('mfKeypair').value = mf.keypairPath || '';
  mfDisarm();
  await refreshMfSessions();
  $('makefunOverlay').classList.remove('hidden');
}

function mfRequireKit() {
  const kitDir = $('mfKitDir').value.trim();
  if (!kitDir) throw new Error('Isi folder kit dulu.');
  return kitDir;
}

async function mfBundle() {
  if (mfBusy) return;
  mfDisarm();
  try {
    const kitDir = mfRequireKit();
    const sessionFile = $('mfSession').value;
    if (!sessionFile) throw new Error('Tidak ada sesi terekam untuk di-bundle.');
    await mfPersist();
    mfSetBusy(true);
    mfSummary('Membuat bundle…', '');
    const res = await window.api.makefunBundle({ kitDir, sessionFile });
    if (res.code === 0) {
      mfSummary('Bundle selesai: ' + res.outPath + '\nDinyatakan: harness claude-code · provider ' + res.vendor + ' · model ' + res.model, 'ok');
    } else {
      mfSummary('Bundle GAGAL (exit ' + res.code + ') — baca log di bawah; pesan CLI ditampilkan apa adanya.', 'bad');
    }
  } catch (err) {
    mfSummary('Error: ' + (err && err.message ? err.message : String(err)), 'bad');
  } finally {
    mfSetBusy(false);
  }
}

async function mfCheck() {
  if (mfBusy) return;
  mfDisarm();
  try {
    const kitDir = mfRequireKit();
    await mfPersist();
    mfSetBusy(true);
    mfSummary('Menjalankan check lokal…', '');
    const res = await window.api.makefunCheck({ kitDir });
    const p = res.parsed || {};
    let text = 'Check: ' + p.passed + ' passed · ' + p.failed + ' failed · ' +
      p.skipped + ' skipped · ' + p.atSubmission + ' at submission';
    if (p.failedNames && p.failedNames.length) text += '\nGagal: ' + p.failedNames.join(', ');
    if (p.verdictLine) text += '\n' + p.verdictLine;
    mfSummary(text, p.ok && res.code === 0 ? 'ok' : 'bad');
  } catch (err) {
    mfSummary('Error: ' + (err && err.message ? err.message : String(err)), 'bad');
  } finally {
    mfSetBusy(false);
  }
}

async function mfSubmit() {
  if (mfBusy) return;
  // Two-step confirm: the first click only arms the button; a second,
  // deliberate click within 15 seconds performs the submission. Any
  // other action (or the timeout) disarms it.
  if (!mfSubmitArmed) {
    mfSubmitArmed = true;
    const btn = $('mfSubmitBtn');
    btn.classList.add('armed');
    btn.textContent = '⚠ Klik lagi untuk BENAR-BENAR submit';
    mfSummary('Submit mengirim entry ke make.fun dan tidak bisa dibatalkan dari aplikasi. Klik tombol Submit sekali lagi untuk melanjutkan, atau lakukan hal lain untuk membatalkan.', 'bad');
    mfArmTimer = setTimeout(mfDisarm, 15000);
    return;
  }
  mfDisarm();
  try {
    const kitDir = mfRequireKit();
    const slug = $('mfSlug').value.trim();
    const repoUrl = $('mfRepoUrl').value.trim();
    const title = $('mfTitle').value.trim();
    if (!slug) throw new Error('Isi slug kompetisi dulu.');
    if (!repoUrl) throw new Error('Isi URL repo dulu.');
    if (!title) throw new Error('Isi judul submission dulu.');
    await mfPersist();
    mfSetBusy(true);
    mfSummary('Mengirim submission…', '');
    const res = await window.api.makefunSubmit({ kitDir, slug, repoUrl, title });
    if (res.code === 0 && res.submissionId) {
      mfSummary('SUBMITTED ✓\nSubmission: ' + res.submissionId +
        (res.claimCode ? '\nClaim code: ' + res.claimCode : '') +
        (res.checkedLine ? '\n' + res.checkedLine : ''), 'ok');
    } else {
      mfSummary('Submit GAGAL (exit ' + res.code + ') — baca log di bawah; pesan CLI ditampilkan apa adanya.', 'bad');
    }
  } catch (err) {
    mfSummary('Error: ' + (err && err.message ? err.message : String(err)), 'bad');
  } finally {
    mfSetBusy(false);
  }
}

/* ----------------------------- Bounty Baru ---------------------------- */

const DEFAULT_WALLET = '6cXDbrdPH6yCbdGoDDFRYw8G2dWV3VQazAc71f6WAaur';
let wzBusy = false;

function wzSummary(text, kind) {
  const box = $('wzSummary');
  box.textContent = text;
  box.className = 'mf-summary' + (kind ? ' ' + kind : '');
}

function openWizard() {
  $('wzParent').value = settings.workspace ? settings.workspace.replace(/[\\/][^\\/]*$/, '') : '';
  $('wzFolder').value = '';
  $('wzSlug').value = '';
  $('wzWallet').value = (settings.makefun && settings.makefun.wallet) || DEFAULT_WALLET;
  $('wzSummary').className = 'mf-summary hidden';
  $('wizardOverlay').classList.remove('hidden');
}

async function wzCreate() {
  if (wzBusy) return;
  const parentDir = $('wzParent').value.trim();
  const folderName = $('wzFolder').value.trim();
  const slug = $('wzSlug').value.trim();
  const wallet = $('wzWallet').value.trim();
  if (!parentDir) { wzSummary('Isi folder induk dulu.', 'bad'); return; }
  if (!folderName) { wzSummary('Isi nama folder proyek dulu.', 'bad'); return; }
  wzBusy = true;
  $('wzCreateBtn').disabled = true;
  try {
    const res = await window.api.createBounty({ parentDir, folderName, slug, wallet });
    settings = await window.api.getSettings();
    currentSessionId = null;
    renderHeader();
    let text = 'Proyek dibuat: ' + res.dir +
      '\nFile: ' + res.files.join(', ') +
      '\nGit: 1 commit awal ' + (res.git && res.git.commit ? res.git.commit.slice(0, 8) : '') +
      '\nWorkspace aplikasi sekarang: folder baru ini.';
    if (res.warnings && res.warnings.length) text += '\n\n⚠ ' + res.warnings.join('\n⚠ ');
    wzSummary(text, res.warnings && res.warnings.length ? 'bad' : 'ok');
    addMessage('assistant', 'Proyek bounty baru dibuat dan dijadikan workspace aktif: ' + res.dir);
  } catch (err) {
    wzSummary('Error: ' + (err && err.message ? err.message : String(err)), 'bad');
  } finally {
    wzBusy = false;
    $('wzCreateBtn').disabled = false;
  }
}

/* -------------------------------- init -------------------------------- */

async function init() {
  providers = await window.api.listProviders();
  settings = await window.api.getSettings();
  renderHeader();
  const s = await window.api.newSession();
  currentSessionId = s.meta.id;
  await refreshSessions();

  window.api.onAgentEvent((evt) => {
    if (evt.kind === 'assistant') addMessage('assistant', evt.content);
    else if (evt.kind === 'tool_call') addToolCall(evt.id, evt.name, evt.args);
    else if (evt.kind === 'tool_result') fillToolResult(evt.id, evt.name, evt.result, evt.isError);
  });

  $('sendBtn').onclick = send;
  $('stopBtn').onclick = () => window.api.abortChat();
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('newSessionBtn').onclick = async () => {
    const s2 = await window.api.newSession();
    currentSessionId = s2.meta.id;
    $('messages').innerHTML = '';
    pendingTools.clear();
    await refreshSessions();
  };
  $('workspaceBtn').onclick = async () => {
    const path = await window.api.selectWorkspace();
    settings.workspace = path;
    currentSessionId = null;
    renderHeader();
  };
  $('makefunToggle').onchange = async (e) => {
    settings.makefunMode = e.target.checked;
    settings = await window.api.saveSettings(settings);
    if (settings.makefunMode) {
      addMessage('assistant', 'Mode make.fun aktif: rules make.fun disuntikkan ke system prompt. Pastikan workspace adalah folder repo bounty-nya.');
    }
  };
  window.api.onMakefunLog((evt) => mfLog(evt.line, evt.stream === 'stderr'));
  $('usageBtn').onclick = () => { openUsage().catch((err) => addMessage('error', err.message || String(err))); };
  $('usageClose').onclick = () => $('usageOverlay').classList.add('hidden');
  $('wizardBtn').onclick = () => openWizard();
  $('wizardClose').onclick = () => $('wizardOverlay').classList.add('hidden');
  $('wzParentPick').onclick = async () => {
    const dir = await window.api.pickParentDir();
    if (dir) $('wzParent').value = dir;
  };
  $('wzCreateBtn').onclick = wzCreate;
  $('makefunBtn').onclick = () => { openMakefun().catch((err) => addMessage('error', err.message || String(err))); };
  $('makefunClose').onclick = async () => {
    mfDisarm();
    await mfPersist();
    $('makefunOverlay').classList.add('hidden');
  };
  $('mfKitPick').onclick = async () => {
    const dir = await window.api.selectKitDir();
    if (dir) $('mfKitDir').value = dir;
  };
  $('mfSessionRefresh').onclick = () => refreshMfSessions();
  $('mfBundleBtn').onclick = mfBundle;
  $('mfCheckBtn').onclick = mfCheck;
  $('mfSubmitBtn').onclick = mfSubmit;
  $('settingsBtn').onclick = () => {
    renderSettingsForm();
    $('settingsOverlay').classList.remove('hidden');
  };
  $('settingsClose').onclick = () => $('settingsOverlay').classList.add('hidden');
  $('settingsSave').onclick = async () => {
    settings = await window.api.saveSettings(collectSettings());
    renderHeader();
    $('settingsOverlay').classList.add('hidden');
  };
}

init().catch((err) => {
  addMessage('error', 'Gagal memulai aplikasi: ' + (err && err.message ? err.message : String(err)));
});
