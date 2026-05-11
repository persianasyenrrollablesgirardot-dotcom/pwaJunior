/* ═══════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Popup UI
 * ════════════════════════════════════════════════════════ */

'use strict';

const LOCAL_KEY    = 'ws_captures_local';
const SETTINGS_KEY = 'ws_settings';

let currentTab = 'captures';
let captures   = [];
let selected   = new Set();
let results    = [];
let resultsSaved = null;
let settings   = { deepseekKey: '', supabaseKey: '', openaiKey: '' };

const content = document.getElementById('content');
const actions = document.getElementById('actions');

// ─── Init ────────────────────────────────────────────────────

(async function init() {
  const data = await chrome.storage.local.get([LOCAL_KEY, SETTINGS_KEY]);
  captures = data[LOCAL_KEY] || [];
  settings = data[SETTINGS_KEY] || settings;

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Seleccionar por defecto todas las no enviadas
  captures.filter(c => !c.sent).forEach(c => selected.add(c.id));

  render();

  // Auto-refresh cada 2s de las capturas locales
  setInterval(async () => {
    if (currentTab !== 'captures') return;
    const r = await chrome.storage.local.get([LOCAL_KEY]);
    captures = r[LOCAL_KEY] || [];
    render();
  }, 2000);
})();

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  render();
}

// ─── Render ──────────────────────────────────────────────────

function render() {
  if (currentTab === 'captures') renderCaptures();
  else if (currentTab === 'results') renderResults();
  else renderSettings();
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderCaptures() {
  const unsent = captures.filter(c => !c.sent);

  if (unsent.length === 0) {
    content.innerHTML = `
      <div class="empty">
        <div class="emoji">📱</div>
        <p>Abre WhatsApp Web y chatea normalmente.<br>Las conversaciones aparecen aquí en tiempo real.</p>
      </div>`;
    actions.innerHTML = `<button class="btn btn-secondary" id="scanBtn">↻ Escanear ahora</button>`;
    document.getElementById('scanBtn').addEventListener('click', scanNow);
    return;
  }

  content.innerHTML = unsent.map(c => {
    const preview = c.messages.slice(-2).map(m => `${m.role === 'yo' ? 'Tú' : 'Cliente'}: ${m.text}`).join('  ·  ');
    const on      = selected.has(c.id);
    const audios  = c.messages.filter(m => m.type === 'audio' || m.text.startsWith('🎤')).length;

    return `
      <div class="card">
        <div class="card-top">
          <div style="flex:1;min-width:0">
            <div class="card-name">${esc(c.contact)}${c.isGroup ? ' <span class="badge b-blue">👥</span>' : ''}</div>
            ${c.phone ? `<div class="card-phone">📞 ${esc(c.phone)}</div>` : ''}
            <div class="card-meta">
              ${c.date} · ${c.messages.length} mensajes
              ${audios > 0 ? ` · <span class="badge b-green">🎤 ${audios}</span>` : ''}
            </div>
          </div>
          <button class="check ${on ? 'on' : ''}" data-id="${c.id}">${on ? '✓' : ''}</button>
        </div>
        <div class="card-preview">${esc(preview)}</div>
      </div>`;
  }).join('');

  content.querySelectorAll('.check').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (selected.has(id)) selected.delete(id);
      else                  selected.add(id);
      render();
    });
  });

  const n = selected.size;
  actions.innerHTML = `
    <button class="btn btn-secondary" id="scanBtn">↻ Escanear</button>
    <button class="btn btn-primary" id="procBtn" ${n === 0 ? 'disabled' : ''}>
      Organizar ${n} →
    </button>`;

  document.getElementById('scanBtn').addEventListener('click', scanNow);
  if (n > 0) document.getElementById('procBtn').addEventListener('click', processSelected);
}

function renderResults() {
  if (results.length === 0) {
    content.innerHTML = `
      <div class="empty">
        <div class="emoji">📊</div>
        <p>Aquí aparecen los resultados después de organizar con IA.</p>
      </div>`;
    actions.innerHTML = '';
    return;
  }

  content.innerHTML = results.map(r => `
    <div class="result-card">
      <div class="result-name">${esc(r.contacto)}</div>
      ${r.telefono ? `<div style="font-size:10px;color:#7c3aed;margin-top:2px">📞 ${esc(r.telefono)}</div>` : ''}
      <div style="margin-top:6px">
        <span class="badge b-purple">${esc(r.estado)}</span>
        <span class="badge ${r.prioridad === 'alta' ? 'b-yellow' : r.prioridad === 'media' ? 'b-blue' : 'b-green'}">● ${esc(r.prioridad)}</span>
        ${(r.productos || []).map(p => `<span class="badge b-blue">📦 ${esc(p)}</span>`).join('')}
      </div>
      <div class="result-summary">${esc(r.resumen)}</div>
      <div class="result-action">→ ${esc(r.proxima_accion)}</div>
    </div>`).join('');

  actions.innerHTML = resultsSaved
    ? '<div class="status-ok" style="flex:1">✓ Guardado en Supabase</div>'
    : '<div class="status-err" style="flex:1">No se pudo guardar en Supabase</div>';
}

function renderSettings() {
  content.innerHTML = `
    <div class="setting">
      <label>API Key DeepSeek</label>
      <input type="password" id="dsKey" value="${esc(settings.deepseekKey)}" placeholder="sk-..."/>
    </div>
    <div class="setting">
      <label>Supabase Anon Key</label>
      <input type="password" id="sbKey" value="${esc(settings.supabaseKey)}" placeholder="eyJ..."/>
    </div>
    <div class="setting">
      <label>OpenAI API Key (Whisper)</label>
      <input type="password" id="oaKey" value="${esc(settings.openaiKey)}" placeholder="sk-proj-..."/>
    </div>
    <div id="saveMsg" style="text-align:center;margin-top:6px;font-size:11px"></div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #2d3148;font-size:10px;color:#475569;line-height:1.6">
      Las capturas se mantienen locales hasta que las organizas manualmente.<br>
      Nada se envía a la IA sin tu permiso.
    </div>`;

  actions.innerHTML = `
    <button class="btn btn-secondary" id="clearBtn">🗑 Limpiar capturas</button>
    <button class="btn btn-primary" id="saveBtn">✓ Guardar</button>`;

  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('clearBtn').addEventListener('click', clearAll);
}

// ─── Acciones ────────────────────────────────────────────────

async function scanNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('web.whatsapp.com')) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW' }).catch(() => {});
  setTimeout(async () => {
    const r = await chrome.storage.local.get([LOCAL_KEY]);
    captures = r[LOCAL_KEY] || [];
    render();
  }, 1000);
}

async function processSelected() {
  const toProcess = captures.filter(c => selected.has(c.id));
  if (toProcess.length === 0) return;

  content.innerHTML = `<div class="loading"><div class="spinner"></div>Organizando ${toProcess.length} con IA...</div>`;
  actions.innerHTML = '';

  chrome.runtime.sendMessage({ type: 'PROCESS_AND_SEND', captures: toProcess }, async resp => {
    if (!resp?.ok) {
      content.innerHTML = `<div class="status-err">Error: ${esc(resp?.error || 'desconocido')}</div>`;
      actions.innerHTML = '';
      return;
    }

    captures = captures.map(c => selected.has(c.id) ? { ...c, sent: true } : c);
    await chrome.storage.local.set({ [LOCAL_KEY]: captures });
    selected.clear();
    results = resp.records || [];
    resultsSaved = resp.saved;
    switchTab('results');
  });
}

async function saveSettings() {
  settings = {
    deepseekKey: document.getElementById('dsKey').value.trim(),
    supabaseKey: document.getElementById('sbKey').value.trim(),
    openaiKey:   document.getElementById('oaKey').value.trim(),
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const msg = document.getElementById('saveMsg');
  if (msg) msg.innerHTML = '<span style="color:#4ade80">✓ Guardado</span>';
  setTimeout(() => { if (msg) msg.innerHTML = ''; }, 2000);
}

async function clearAll() {
  if (!confirm('¿Borrar todas las capturas locales? (Las que ya fueron al CRM no se borran de Supabase)')) return;
  captures = [];
  selected.clear();
  await chrome.storage.local.set({ [LOCAL_KEY]: [] });
  render();
}

// Escuchar cambios de storage para refrescar automáticamente
chrome.storage.onChanged.addListener((changes) => {
  if (changes[LOCAL_KEY] && currentTab === 'captures') {
    captures = changes[LOCAL_KEY].newValue || [];
    render();
  }
});
