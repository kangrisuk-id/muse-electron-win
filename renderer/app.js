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
    div.innerHTML =
      '<div class="s-preview">' + esc(s.preview || '(sesi kosong)') + '</div>' +
      '<div class="s-meta">' + esc(when) + ' · ' + esc(s.provider || '') + ' · ' + s.messages + ' pesan</div>';
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
