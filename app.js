import { compileFormula, validateFormula } from './js/formula.js';
import {
  decodeSupportedBitmask,
  extractPidPayload,
  hasObdError,
  inspectObdReply,
  parseDtcResponse,
  parseMode0101,
  parseVinResponse,
} from './js/obd-parser.js';
import {
  CALCULATED_PIDS,
  STANDARD_PIDS,
  formatDisplayValue,
  getAllPidsMap,
  loadCustomPids,
  saveCustomPids,
} from './js/pids.js';
import {
  CVT_SERVICE_CHECKLIST,
  DTC_DESCRIPTIONS,
  SCAN_PRESETS,
  VEHICLE_CATALOG,
  clearBaselineForVehicle,
  findMatchingPresetForDtcs,
  getAllProfiles,
  getBaselineForVehicle,
  getBaselineKey,
  getComboKey,
  getEngineMeta,
  loadComboLayout,
  loadCustomProfiles,
  loadGarage,
  saveBaselineForVehicle,
  saveComboLayout,
  saveCustomProfiles,
  saveGarage,
} from './js/profiles.js';
import {
  ERROR_CATEGORY,
  Elm327Connection,
  classifyElmError,
  formatOsErrorDetail,
  requestBleScannerDevice,
  requestSerialScannerPort,
} from './js/elm327.js';
import { SIM_SCENARIOS, VehicleSimulator } from './js/simulator.js';
import {
  buildAiDiagnosticPayload,
  buildAiPrompt,
  buildCsvContent,
  computeBaselineComparison,
  computeSessionStats,
  createPidHealthTracker,
  downsampleRecordsForAi,
} from './js/export.js';
import {
  AI_PROVIDERS,
  SYSTEM_PROMPT_BASE,
  buildCompactStatsTable,
  buildSessionContextObject,
  clearAiKey,
  clearAllAiStorage,
  getModelDisplayName,
  loadAiConfig,
  saveAiKey,
  saveAiProviderAndModel,
  setPrivacyAck,
  streamAiChat,
  testAiConnection,
} from './js/ai.js';
import { GUIDE_CHAPTERS, VIEW_LABELS } from './js/guide.js';

const SETTINGS_KEY = 'bayscope_settings_v1';
const PROFILE_KEY = 'bayscope_active_profile_v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHART_COLORS = ['#f59e0b', '#38bdf8', '#10b981', '#f472b6'];

const state = {
  mode: 'idle', // 'idle' | 'real' | 'sim'
  activeView: 'dashboard',
  previousView: 'dashboard',
  guideFilterText: '',
  customPids: loadCustomPids(),
  pidMap: new Map(),

  settings: {
    useImperial: false,
    wakeLockEnabled: true,
    txDelayMs: 150,
    sessionPurpose: 'own', // 'own' | 'buying'
    userNotes: '',
  },

  profile: {
    mfrId: 'toyota',
    engineId: '1GR-FE',
    transId: '5AT (A750)',
    showBank2: false,
  },

  garage: loadGarage(),
  customProfiles: loadCustomProfiles(),
  presetCategoryFilter: 'all',
  activePresetId: 'general',
  dashboardPids: [...SCAN_PRESETS[2].pids],
  chartPids: ['010C', '010D'],

  supportedPids: null, // null = unknown (not scanned), Set<string> = scanned
  supportedPidsComplete: false, // true once 0100/0120/0140 bitmask scan finishes
  pidCap: 10,
  slowAdapterTrimmed: false,
  lastTrimmedWarning: '',
  captureMode: false,
  captureIncludeCoolant: true,
  deferredScanPending: null, // { elm, has0120, supported } deferred until capture mode exits
  driveScriptCollapsed: true,
  driveScriptDone: new Set(),
  cvtChecklistVisible: false,
  cvtChecklistCollapsed: true,

  vehicleInfo: {
    vin: null,
    make: null,
    year: null,
    milOn: null,
    dtcCount: null,
    ignitionType: null,
    monitors: [],
    distanceWithMil: null,
    warmupsSinceClear: null,
    distanceSinceClear: null,
    timeWithMil: null,
    timeSinceClear: null,
    dtcs: { stored: [], pending: [], permanent: [] },
  },

  liveValues: {}, // pidHex -> number | null
  sessionMin: {},
  sessionMax: {},
  records: [], // { ts, simulated, values, event }
  pendingEvent: '',
  samplingRateHz: 0,
  isSimulatedSession: false,
  pidHealthTracker: createPidHealthTracker(),

  logs: [], // { ts, dir, text }
  varFilterText: '',
  varCategory: 'all',

  elm: null,
  connecting: false,
  pollActive: false,
  clearingDtcs: false,
  reconnecting: false,
  dongleReminderUntil: 0,
  disconnectedNotice: '',
  simTimer: null,
  simulator: null,
  wakeLock: null,
  chart: null,
  deferredInstallPrompt: null,

  aiConfig: loadAiConfig(),
  aiMessages: [], // in-memory session only (clears on reload)
  aiStreaming: false,
  aiAbortController: null,
  aiPendingAttachment: null, // { type: 'summary' | 'csv', label, text }
};

// Cache formatted unit display strings keyed by `${pidHex}:${useImperial ? 'imp' : 'met'}`
const pidUnitCache = new Map();

function getCachedPidUnit(meta, useImperial) {
  const key = `${meta.pidHex}:${useImperial ? 'imp' : 'met'}`;
  let unit = pidUnitCache.get(key);
  if (unit === undefined) {
    unit = formatDisplayValue(meta, 0, useImperial).unit;
    pidUnitCache.set(key, unit);
  }
  return unit;
}

function rebuildPidMap() {
  state.pidMap = getAllPidsMap(state.customPids);
  pidUnitCache.clear();
}

function loadSavedState() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof s.useImperial === 'boolean') state.settings.useImperial = s.useImperial;
    if (typeof s.wakeLockEnabled === 'boolean') state.settings.wakeLockEnabled = s.wakeLockEnabled;
    if (typeof s.txDelayMs === 'number' && Number.isFinite(s.txDelayMs)) {
      state.settings.txDelayMs = Math.max(100, Math.round(s.txDelayMs));
    }
    if (s.sessionPurpose === 'buying' || s.sessionPurpose === 'own') state.settings.sessionPurpose = s.sessionPurpose;
    if (typeof s.userNotes === 'string') state.settings.userNotes = s.userNotes;
  } catch {}

  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    if (p.mfrId) state.profile.mfrId = p.mfrId;
    if (p.engineId) state.profile.engineId = p.engineId;
    if (p.transId) state.profile.transId = p.transId;
    if (typeof p.showBank2 === 'boolean') state.profile.showBank2 = p.showBank2;
  } catch {}

  const combo = getComboKey(state.profile.mfrId, state.profile.engineId, state.profile.transId);
  const layout = loadComboLayout(combo);
  if (layout && Array.isArray(layout.pids) && layout.pids.length > 0) {
    state.dashboardPids = layout.pids.slice(0, state.pidCap);
    if (Array.isArray(layout.chartPids)) state.chartPids = layout.chartPids.slice(0, 4);
  }
}

function persistSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function persistProfileAndLayout() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
  const combo = getComboKey(state.profile.mfrId, state.profile.engineId, state.profile.transId);
  saveComboLayout(combo, state.dashboardPids, state.chartPids);
}

// DOM Helper
const $ = (id) => document.getElementById(id);

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createEmptyVehicleInfo() {
  return {
    vin: null,
    make: null,
    year: null,
    milOn: null,
    dtcCount: null,
    ignitionType: null,
    monitors: [],
    distanceWithMil: null,
    warmupsSinceClear: null,
    distanceSinceClear: null,
    timeWithMil: null,
    timeSinceClear: null,
    dtcs: { stored: [], pending: [], permanent: [] },
  };
}

function showToast(msg, variant = 'ok') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

function setStatus(text, level = 'info', meta = '') {
  const bar = $('status-bar');
  bar.className = `status-bar status-${level}`;
  $('status-text').textContent = text;
  $('status-meta').textContent = meta;
  const termState = $('term-state');
  if (termState) termState.textContent = text;
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  const box = $('terminal-log-box');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'log-line';
  const ts = entry.ts.toTimeString().slice(0, 8);
  row.innerHTML = `<span class="log-ts">${ts}</span><span class="log-dir log-dir-${entry.dir}">${entry.dir}</span><span class="log-msg"></span>`;
  row.querySelector('.log-msg').textContent = entry.text;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function openModal(title, htmlContent) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = htmlContent;
  $('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  $('modal-backdrop').classList.add('hidden');
}

async function copyText(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg, 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(successMsg, 'ok');
  }
}

// Partial CSV auto-save on unexpected disconnect / clean detach
function savePartialCsvSnapshot({ download = true, silent = false } = {}) {
  if (!state.records || state.records.length === 0) {
    return { saved: false, count: 0 };
  }
  const csv = buildCsvContent(getExportPayload());
  try {
    localStorage.setItem('bayscope_last_partial_csv_v1', csv);
  } catch {}

  if (download) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bayscope-partial-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {}
  }

  if (!silent) {
    const msg = `Partial CSV saved (${state.records.length} samples)`;
    appendLog({ ts: new Date(), dir: 'SYS', text: msg });
    showToast(msg, 'warn');
  }
  return { saved: true, count: state.records.length };
}

// Wake Lock + optional Android host bridge PARTIAL_WAKE_LOCK during logging
async function updateWakeLock(shouldLock) {
  try {
    const bridge = typeof window !== 'undefined' ? (window.BayScopeAndroid || window.Android) : null;
    if (shouldLock && state.settings.wakeLockEnabled) {
      bridge?.acquirePartialWakeLock?.();
    } else {
      bridge?.releasePartialWakeLock?.();
    }
  } catch {}

  if (!('wakeLock' in navigator)) return;
  if (shouldLock && state.settings.wakeLockEnabled) {
    try {
      if (!state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => {
          state.wakeLock = null;
        });
      }
    } catch {}
  } else if (!shouldLock && state.wakeLock) {
    try {
      await state.wakeLock.release();
    } catch {}
    state.wakeLock = null;
  }
}

// Bank-2 visibility rule (Requirement 16)
function isPidHiddenByBankRule(pid) {
  if (!pid || pid.bank !== 2) return false;
  const { eng } = getEngineMeta(state.profile.mfrId, state.profile.engineId);
  return eng.banks === 1 && !state.profile.showBank2;
}

function getEffectiveDashboardPids() {
  return state.dashboardPids.filter((id) => {
    const meta = state.pidMap.get(id);
    return meta && !isPidHiddenByBankRule(meta);
  }).slice(0, state.pidCap);
}

// Navigation & Drawer
function switchView(viewName) {
  if (state.activeView && state.activeView !== viewName && state.activeView !== 'guide') {
    state.previousView = state.activeView;
  }
  state.activeView = viewName;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const target = $(`view-${viewName}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  closeDrawer();

  if (viewName === 'dashboard') renderDashboard();
  if (viewName === 'variables') renderVariables();
  if (viewName === 'presets') renderPresets();
  if (viewName === 'vehicle') renderVehicleProfile();
  if (viewName === 'dtcs') renderDtcsView();
  if (viewName === 'custom-pids') renderCustomPids();
  if (viewName === 'export') renderExportView();
  if (viewName === 'ai') renderAiChatView();
  if (viewName === 'settings') renderAiSettings();
  if (viewName === 'guide') renderGuideView();

  const floatBtn = $('floating-ask-ai-btn');
  if (floatBtn) floatBtn.classList.toggle('hidden', viewName === 'ai');
}

function scrollToGuideChapter(chapterId) {
  const el = $(`guide-ch-${chapterId}`);
  if (!el) return;
  document.querySelectorAll('.guide-chapter-highlight').forEach((node) => {
    node.classList.remove('guide-chapter-highlight');
  });
  el.classList.add('guide-chapter-highlight');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    el.classList.remove('guide-chapter-highlight');
  }, 2200);
}

function openGuideChapter(chapterId) {
  state.guideFilterText = '';
  const searchEl = $('guide-search-input');
  if (searchEl) searchEl.value = '';
  switchView('guide');
  if (chapterId) {
    requestAnimationFrame(() => {
      scrollToGuideChapter(chapterId);
    });
  }
}

function renderGuideView() {
  const backBtn = $('guide-back-btn');
  if (backBtn) {
    const prev = state.previousView && state.previousView !== 'guide' ? state.previousView : 'dashboard';
    const prevLabel = VIEW_LABELS[prev] || 'Dashboard';
    backBtn.textContent = `← Back to ${prevLabel}`;
  }

  const q = state.guideFilterText.trim().toLowerCase();
  const clearBtn = $('guide-search-clear-btn');
  if (clearBtn) clearBtn.classList.toggle('hidden', q.length === 0);

  const filtered = GUIDE_CHAPTERS.filter((ch) => {
    if (!q) return true;
    const hay = [
      ch.number,
      ch.title,
      ch.shortLabel,
      ch.keywords,
      ch.whatItDoes,
      ch.whenToUse,
      ...ch.steps,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const countEl = $('guide-match-count');
  if (countEl) {
    countEl.textContent = q
      ? `${filtered.length} of ${GUIDE_CHAPTERS.length} chapters`
      : `${GUIDE_CHAPTERS.length} chapters`;
  }

  // Render Table of Contents jump chips
  const tocEl = $('guide-toc-links');
  if (tocEl) {
    tocEl.innerHTML = '';
    for (const ch of GUIDE_CHAPTERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'guide-toc-btn';
      btn.innerHTML = `<span class="guide-toc-num">${ch.number}</span><span class="guide-toc-label"></span>`;
      btn.querySelector('.guide-toc-label').textContent = ch.shortLabel;
      btn.addEventListener('click', () => {
        if (state.guideFilterText.trim()) {
          state.guideFilterText = '';
          const searchEl = $('guide-search-input');
          if (searchEl) searchEl.value = '';
          renderGuideView();
        }
        scrollToGuideChapter(ch.id);
      });
      tocEl.appendChild(btn);
    }
  }

  // Render chapters
  const listEl = $('guide-chapters-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel';
    empty.innerHTML = '<p class="subtext">No Field Guide chapters match that keyword. Try searching for <code>KOEO</code>, <code>CVT</code>, <code>VIN</code>, <code>CSV</code>, or <code>clone</code>.</p>';
    listEl.appendChild(empty);
    return;
  }

  for (const ch of filtered) {
    const article = document.createElement('article');
    article.id = `guide-ch-${ch.id}`;
    article.className = 'panel guide-chapter';

    const relatedLabel = VIEW_LABELS[ch.relatedView] || 'Dashboard';
    article.innerHTML = `
      <div class="guide-chapter-head">
        <div class="guide-chapter-title-wrap">
          <span class="guide-chapter-num">${ch.number}</span>
          <h2 class="guide-chapter-title"></h2>
        </div>
        <div class="guide-chapter-actions">
          <button class="btn btn-subtle btn-sm guide-open-view-btn" type="button"></button>
          <button class="btn btn-subtle btn-sm guide-top-btn" type="button">Top ↑</button>
        </div>
      </div>
      <div class="guide-meta-grid">
        <div class="guide-callout">
          <div class="guide-callout-label">What it does</div>
          <p class="guide-what-text"></p>
        </div>
        <div class="guide-callout">
          <div class="guide-callout-label">When to use it</div>
          <p class="guide-when-text"></p>
        </div>
      </div>
      <div class="guide-steps-block">
        <div class="guide-callout-label">Quick step-by-step &amp; pro tips</div>
        <ol class="guide-steps-list"></ol>
      </div>
    `;

    article.querySelector('.guide-chapter-title').textContent = ch.title;
    article.querySelector('.guide-what-text').textContent = ch.whatItDoes;
    article.querySelector('.guide-when-text').textContent = ch.whenToUse;

    const openBtn = article.querySelector('.guide-open-view-btn');
    openBtn.textContent = `Open ${relatedLabel}`;
    openBtn.addEventListener('click', () => switchView(ch.relatedView));

    article.querySelector('.guide-top-btn').addEventListener('click', () => {
      $('guide-toc-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const stepsList = article.querySelector('.guide-steps-list');
    for (const stepText of ch.steps) {
      const li = document.createElement('li');
      li.textContent = stepText;
      stepsList.appendChild(li);
    }

    listEl.appendChild(article);
  }
}

function openDrawer() {
  $('nav-drawer').classList.add('open');
  $('drawer-backdrop').classList.remove('hidden');
  $('menu-toggle-btn').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  $('nav-drawer').classList.remove('open');
  $('drawer-backdrop').classList.add('hidden');
  $('menu-toggle-btn').setAttribute('aria-expanded', 'false');
}

function getActiveProfile() {
  return getAllProfiles(state.customProfiles).find((p) => p.id === state.activePresetId) || null;
}

function getAdapterInfoSnapshot() {
  if (state.mode === 'sim') {
    return {
      identity: 'BayScope Simulator',
      protocol: 'Simulated CAN',
      txDelayMs: 0,
    };
  }
  return {
    identity: state.elm?.adapterIdentity || 'Unknown',
    protocol: state.elm?.protocolNumber || 'Auto',
    txDelayMs: state.elm?.interCommandDelayMs ?? state.settings.txDelayMs,
  };
}

function getCurrentVehicleBaseline() {
  const key = getBaselineKey(
    state.vehicleInfo.vin,
    state.profile.mfrId,
    state.profile.engineId,
    state.profile.transId
  );
  const baseline = getBaselineForVehicle(
    state.vehicleInfo.vin,
    state.profile.mfrId,
    state.profile.engineId,
    state.profile.transId
  );
  return { key, baseline };
}

function enforcePidCapWithWarning(pidList, contextLabel = 'Dashboard', sortByPriority = true) {
  if (pidList.length <= state.pidCap) {
    state.lastTrimmedWarning = '';
    return { kept: pidList, trimmed: [] };
  }
  const ordered = sortByPriority
    ? [...pidList].sort((a, b) => (state.pidMap.get(a)?.priority ?? 50) - (state.pidMap.get(b)?.priority ?? 50))
    : [...pidList];
  const kept = ordered.slice(0, state.pidCap);
  const trimmed = ordered.slice(state.pidCap);
  const trimmedNames = trimmed.map((id) => `${state.pidMap.get(id)?.shortName || id} (${id})`).join(', ');
  const msg = `${contextLabel}: adapter cap (${state.pidCap} PIDs max) exceeded — trimmed ${trimmed.length}: ${trimmedNames}`;
  state.lastTrimmedWarning = msg;
  state.slowAdapterTrimmed = state.pidCap <= 6;
  appendLog({ ts: new Date(), dir: 'SYS', text: `WARN: ${msg}` });
  showToast(msg, 'warn');
  return { kept, trimmed };
}

function markMomentLabel(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (state.records.length > 0 && !state.records[state.records.length - 1].event) {
    state.records[state.records.length - 1].event = clean;
  } else {
    state.pendingEvent = clean;
  }
  showToast(`Marked moment: "${clean}"`, 'ok');
}

function getCaptureModePids() {
  const pids = ['010C', '010D', 'CALC_RPM_SPEED'];
  if (state.captureIncludeCoolant) pids.push('0105');
  return pids;
}

function newSession() {
  state.records = [];
  state.sessionMin = {};
  state.sessionMax = {};
  state.liveValues = {};
  state.pendingEvent = '';
  state.samplingRateHz = 0;
  state.driveScriptDone = new Set();
  state.pidHealthTracker = createPidHealthTracker();
}

function applyCaptureModeLayout() {
  state.dashboardPids = getCaptureModePids().slice(0, state.pidCap);
  state.chartPids = ['010C', '010D', 'CALC_RPM_SPEED'].filter((id) => state.dashboardPids.includes(id));
  persistProfileAndLayout();
}

function syncScanTargetSelectors() {
  const selectors = [$('start-scan-target-select'), $('live-scan-target-select')];
  const allProfiles = getAllProfiles(state.customProfiles);
  const currentValue = state.captureMode ? '__capture__' : state.activePresetId;
  const includeCustom = state.activePresetId === 'custom' && !state.captureMode;
  const optionsKey = `${allProfiles.map((p) => `${p.id}:${p.name}:${p.pids.length}`).join('|')}|${includeCustom ? 'custom' : ''}`;

  for (const sel of selectors) {
    if (!sel) continue;
    if (sel.dataset.optionsKey !== optionsKey) {
      sel.innerHTML = '';

      for (const p of allProfiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.pids.length} PIDs)`;
        sel.appendChild(opt);
      }

      const capOpt = document.createElement('option');
      capOpt.value = '__capture__';
      capOpt.textContent = 'Cold start / creep capture (fast)';
      sel.appendChild(capOpt);

      if (includeCustom) {
        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = 'Custom layout';
        customOpt.disabled = true;
        sel.appendChild(customOpt);
      }

      sel.dataset.optionsKey = optionsKey;
    }

    if (sel.value !== currentValue) {
      sel.value = currentValue;
    }
  }
}

async function handleScanTargetSelectChange(selectedValue) {
  if (!selectedValue || selectedValue === 'custom') return;
  if (selectedValue === '__capture__') {
    await toggleCaptureMode(true);
    return;
  }
  const wasCapture = Boolean(state.captureMode);
  if (wasCapture) {
    state.captureMode = false;
  }
  applyPreset(selectedValue);
  if (wasCapture && state.mode === 'real' && state.deferredScanPending) {
    await runDeferredBackgroundScan();
  }
}

function syncCaptureControlsUi() {
  const active = Boolean(state.captureMode);
  const toggleBtns = [$('start-capture-toggle-btn'), $('dash-capture-toggle-btn')];
  for (const btn of toggleBtns) {
    if (!btn) continue;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('btn-capture-active', active);
    btn.textContent = active ? 'Capture mode: ON' : 'Cold start / creep capture';
  }
  const coolantChecks = [$('start-capture-coolant-toggle'), $('dash-capture-coolant-toggle')];
  for (const chk of coolantChecks) {
    if (chk) chk.checked = Boolean(state.captureIncludeCoolant);
  }
  const toolsSummary = $('live-tools-summary');
  if (toolsSummary) {
    toolsSummary.textContent = active ? 'Capture ON · Session tools' : 'Session tools';
  }
  syncScanTargetSelectors();
}

async function runDeferredBackgroundScan() {
  const pending = state.deferredScanPending;
  state.deferredScanPending = null;
  if (!pending || !pending.elm || state.elm !== pending.elm) return;
  if (!pending.elm.connected || pending.elm.portDead || pending.elm.detached) return;

  appendLog({
    ts: new Date(),
    dir: 'SYS',
    text: 'Running deferred background scan (0120/0140, 0902 VIN, 0101 readiness, clear distances, 03/07/0A DTCs)…',
  });
  await runInitialVehicleScan(pending.elm, pending.has0120, pending.supported);
  if (state.dashboardPids.length > state.pidCap) {
    const { kept } = enforcePidCapWithWarning(state.dashboardPids, 'Deferred scan profile', true);
    state.dashboardPids = kept;
    state.chartPids = state.chartPids.filter((id) => state.dashboardPids.includes(id));
    renderDashboard();
  }
}

async function toggleCaptureMode(forceState) {
  const next = typeof forceState === 'boolean' ? forceState : !state.captureMode;
  state.captureMode = next;

  // Toggling Capture mode never auto-clears existing session history;
  // users must explicitly click "Start new capture" to call newSession().
  if (next) {
    applyCaptureModeLayout();
    appendLog({
      ts: new Date(),
      dir: 'SYS',
      text: `Capture mode enabled: polling ${state.dashboardPids.join(', ')} with minCycleMs=0 (existing history kept).`,
    });
    showToast('Capture mode ON (RPM + Speed + RPM/speed)', 'ok');
    renderDashboard();
  } else {
    appendLog({ ts: new Date(), dir: 'SYS', text: 'Capture mode stopped.' });
    showToast('Capture mode OFF', 'ok');
    renderDashboard();
    if (state.mode === 'real' && state.deferredScanPending) {
      await runDeferredBackgroundScan();
    }
  }
}

function startNewCapture() {
  newSession();
  state.captureMode = true;
  applyCaptureModeLayout();
  appendLog({
    ts: new Date(),
    dir: 'SYS',
    text: `Started new cold-start/creep capture: ${state.dashboardPids.join(', ')} (session samples cleared).`,
  });
  showToast('New cold-start / creep capture started', 'ok');
  renderDashboard();
}

// Load a scan-target preset/profile onto dashboard (never silently drops PIDs)
function applyPreset(presetId, { silent = false } = {}) {
  const preset = getAllProfiles(state.customProfiles).find((p) => p.id === presetId);
  if (!preset) return;
  state.activePresetId = preset.id;
  state.driveScriptDone = new Set();
  state.driveScriptCollapsed = true;
  state.cvtChecklistVisible = Boolean(preset.isCvtProfile);
  if (preset.isCvtProfile) {
    state.cvtChecklistCollapsed = true;
  }

  const filtered = preset.pids.filter((id) => {
    const m = state.pidMap.get(id);
    return m && !isPidHiddenByBankRule(m);
  });

  const { kept, trimmed } = enforcePidCapWithWarning(filtered, `Profile "${preset.name}"`, false);
  state.dashboardPids = kept;
  state.chartPids = state.dashboardPids.slice(0, Math.min(2, state.dashboardPids.length));
  persistProfileAndLayout();
  renderDashboard();

  if (!silent && trimmed.length === 0) {
    showToast(`Loaded "${preset.name}" profile (${kept.length} PIDs)`, 'ok');
  }
  if (preset.optionalPids?.length) {
    const optNames = preset.optionalPids.map((id) => state.pidMap.get(id)?.shortName || id).join(', ');
    appendLog({
      ts: new Date(),
      dir: 'SYS',
      text: `Profile "${preset.name}" optional manufacturer PIDs (MX+ likely needed): ${optNames}`,
    });
  }
}

// Chart.js Live Trace (up to 4 variables scaled independently per variable)
function ensureChart() {
  const canvas = $('live-chart');
  if (!canvas || typeof window.Chart === 'undefined') return null;
  if (state.chart) return state.chart;

  state.chart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#cbd5e1', boxWidth: 12, font: { family: 'Plus Jakarta Sans', size: 11 } },
        },
        tooltip: {
          backgroundColor: '#131822',
          borderColor: 'rgba(255,255,255,0.16)',
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const ds = ctx.dataset;
              const val = ctx.parsed.y;
              return `${ds.label}: ${val !== null && val !== undefined ? val.toFixed(ds._decimals ?? 1) : '—'} ${ds._unit || ''}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#64748b', maxTicksLimit: 6, font: { family: 'JetBrains Mono', size: 10 } },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });
  return state.chart;
}

function updateChart() {
  const chartPanel = $('chart-panel');
  const activeCharts = state.chartPids.filter((id) => state.pidMap.has(id)).slice(0, 4);

  if (state.mode === 'idle' || activeCharts.length === 0) {
    chartPanel.classList.add('hidden');
    return;
  }
  chartPanel.classList.remove('hidden');

  const chart = ensureChart();
  if (!chart) return;

  const recent = state.records.slice(-90);
  const t0 = state.records.length > 0 ? state.records[0].ts : Date.now();
  chart.data.labels = recent.map((r) => `${((r.ts - t0) / 1000).toFixed(0)}s`);

  const scales = {
    x: chart.options.scales.x,
  };

  chart.data.datasets = activeCharts.map((pidId, idx) => {
    const meta = state.pidMap.get(pidId);
    const axisId = `y_${idx}`;
    const sampleDisp = formatDisplayValue(meta, meta.min, state.settings.useImperial);
    const maxDisp = formatDisplayValue(meta, meta.max, state.settings.useImperial);

    scales[axisId] = {
      type: 'linear',
      display: idx === 0,
      position: 'left',
      suggestedMin: sampleDisp.displayMin,
      suggestedMax: maxDisp.displayMax,
      ticks: {
        color: CHART_COLORS[idx],
        font: { family: 'JetBrains Mono', size: 10 },
      },
      grid: { color: idx === 0 ? 'rgba(255,255,255,0.06)' : 'transparent' },
    };

    return {
      label: `${meta.shortName} (${sampleDisp.unit})`,
      _unit: sampleDisp.unit,
      _decimals: meta.decimals,
      yAxisID: axisId,
      borderColor: CHART_COLORS[idx],
      backgroundColor: CHART_COLORS[idx],
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      spanGaps: true,
      data: recent.map((r) => {
        const raw = r.values[pidId];
        if (raw === null || raw === undefined) return null;
        return formatDisplayValue(meta, raw, state.settings.useImperial).displayVal;
      }),
    };
  });

  chart.options.scales = scales;
  chart.update('none');
}

function renderDriveScriptCard() {
  const card = $('drive-script-card');
  const list = $('drive-script-list');
  const extras = $('drive-script-extras');
  const toggleBtn = $('drive-script-toggle-btn');
  if (!card || !list) return;

  const activeProfile = getActiveProfile();
  const segments = activeProfile?.driveScriptSegments || null;
  const steps = activeProfile?.driveScript || [];
  const stepCount = Array.isArray(segments) && segments.length > 0 ? segments.length : steps.length;
  if (state.mode === 'idle' || stepCount === 0) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  card.classList.toggle('is-collapsed', state.driveScriptCollapsed);
  list.classList.toggle('hidden', state.driveScriptCollapsed);
  if (extras) extras.classList.toggle('hidden', state.driveScriptCollapsed);
  const subtitleEl = $('drive-script-subtitle');
  if (subtitleEl) {
    subtitleEl.classList.toggle('hidden', state.driveScriptCollapsed);
    subtitleEl.textContent = `${activeProfile.name} — tap any mark button below to log ground truth into the CSV.`;
  }
  toggleBtn.textContent = state.driveScriptCollapsed
    ? `Show Drive Script (${stepCount} step${stepCount === 1 ? '' : 's'})`
    : 'Hide';

  list.innerHTML = '';

  if (Array.isArray(segments) && segments.length > 0) {
    segments.forEach((seg, idx) => {
      const done = state.driveScriptDone.has(idx);
      const li = document.createElement('li');
      li.className = `drive-step-row ${done ? 'done' : ''}`;
      li.innerHTML = `
        <label class="drive-step-check">
          <input type="checkbox" ${done ? 'checked' : ''} />
          <div>
            <div><strong class="seg-title"></strong></div>
            <div class="seg-instr"></div>
            <div class="drive-step-why"></div>
          </div>
        </label>
        <div class="drive-step-marks"></div>
      `;
      li.querySelector('.seg-title').textContent = seg.title;
      li.querySelector('.seg-instr').textContent = seg.instruction;
      li.querySelector('.drive-step-why').textContent = seg.why || '';
      li.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.driveScriptDone.add(idx);
        else state.driveScriptDone.delete(idx);
        renderDriveScriptCard();
      });

      const marksWrap = li.querySelector('.drive-step-marks');
      for (const markText of seg.marks || []) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-subtle btn-sm';
        btn.type = 'button';
        btn.textContent = `Mark "${markText}"`;
        btn.addEventListener('click', () => {
          state.driveScriptDone.add(idx);
          markMomentLabel(markText);
          renderDriveScriptCard();
        });
        marksWrap.appendChild(btn);
      }
      list.appendChild(li);
    });
  } else {
    steps.forEach((stepText, idx) => {
      const done = state.driveScriptDone.has(idx);
      const li = document.createElement('li');
      li.className = `drive-step-row ${done ? 'done' : ''}`;
      li.innerHTML = `
        <label class="drive-step-check">
          <input type="checkbox" ${done ? 'checked' : ''} />
          <span><strong>${idx + 1}.</strong> <span class="step-label-text"></span></span>
        </label>
        <button class="btn btn-subtle btn-sm mark-step-btn" type="button">Mark step</button>
      `;
      li.querySelector('.step-label-text').textContent = stepText;
      li.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.driveScriptDone.add(idx);
        else state.driveScriptDone.delete(idx);
        renderDriveScriptCard();
      });
      li.querySelector('.mark-step-btn').addEventListener('click', () => {
        state.driveScriptDone.add(idx);
        markMomentLabel(`Step ${idx + 1}: ${stepText.slice(0, 72)}`);
        renderDriveScriptCard();
      });
      list.appendChild(li);
    });
  }

  if (extras) {
    const hasWarmSwap = Boolean(activeProfile?.warmSwapDropPid);
    const hasWatch = Array.isArray(activeProfile?.whatToWatch) && activeProfile.whatToWatch.length > 0;
    const hasExcl = Array.isArray(activeProfile?.excludedGuidance) && activeProfile.excludedGuidance.length > 0;
    const hasNext = Array.isArray(activeProfile?.nextStepGuidance) && activeProfile.nextStepGuidance.length > 0;

    if (!hasWarmSwap && !hasWatch && !hasExcl && !hasNext) {
      extras.classList.add('hidden');
      extras.innerHTML = '';
    } else if (!state.driveScriptCollapsed) {
      extras.classList.remove('hidden');
      extras.innerHTML = '';

      if (hasWarmSwap) {
        const dropPid = activeProfile.warmSwapDropPid;
        const dropMeta = state.pidMap.get(dropPid);
        const dropName = dropMeta ? `${dropMeta.shortName} (${dropPid})` : dropPid;
        const hasCoolantOnDash = state.dashboardPids.includes(dropPid);
        const coolantVal = state.liveValues['0105'];
        const isWarm = coolantVal !== null && coolantVal !== undefined && coolantVal >= 80;

        const swapRow = document.createElement('div');
        swapRow.className = 'drive-swap-row';
        swapRow.innerHTML = `
          <div>
            <strong>${isWarm && hasCoolantOnDash ? 'Engine warm (≥80 °C) — optional speed boost:' : 'Optional 4-PID speed swap:'}</strong>
            <div class="muted-meta">${activeProfile.expectedSampleRateNote || ''}</div>
          </div>
          <button id="cvt-warm-swap-btn" class="btn btn-sm ${hasCoolantOnDash ? (isWarm ? 'btn-primary' : 'btn-secondary') : 'btn-subtle'}" type="button">
            ${hasCoolantOnDash ? `Drop ${dropName} → 4 PIDs` : `Restore ${dropName}`}
          </button>
        `;
        swapRow.querySelector('#cvt-warm-swap-btn').addEventListener('click', () => {
          if (hasCoolantOnDash) {
            state.dashboardPids = state.dashboardPids.filter((id) => id !== dropPid);
            state.chartPids = state.chartPids.filter((id) => id !== dropPid);
            appendLog({ ts: new Date(), dir: 'SYS', text: `Warm swap: dropped ${dropName} to maximize sample rate (4 PIDs active).` });
            showToast(`Dropped ${dropName} — running 4-PID fast mode`, 'ok');
          } else {
            if (state.dashboardPids.length < state.pidCap && !state.dashboardPids.includes(dropPid)) {
              state.dashboardPids.push(dropPid);
            }
            showToast(`Restored ${dropName}`, 'ok');
          }
          persistProfileAndLayout();
          renderDashboard();
        });
        extras.appendChild(swapRow);
      }

      if (hasWatch || hasExcl || hasNext) {
        const grid = document.createElement('div');
        grid.className = 'drive-watch-grid';

        if (hasWatch) {
          const box = document.createElement('div');
          box.className = 'drive-watch-box';
          box.innerHTML = `<strong>What to watch in the data</strong><ul>${activeProfile.whatToWatch.map((w) => `<li>${w}</li>`).join('')}</ul>`;
          grid.appendChild(box);
        }
        if (hasNext || hasExcl) {
          const box = document.createElement('div');
          box.className = 'drive-watch-box';
          let html = '';
          if (hasExcl) {
            html += `<strong>Excluded to preserve sample rate</strong><ul>${activeProfile.excludedGuidance.map((x) => `<li>${x}</li>`).join('')}</ul>`;
          }
          if (hasNext) {
            html += `<strong style="display:block;margin-top:${hasExcl ? '8px' : '0'};">Next step after this log</strong><ul>${activeProfile.nextStepGuidance.map((n) => `<li>${n}</li>`).join('')}</ul>`;
          }
          box.innerHTML = html;
          grid.appendChild(box);
        }
        extras.appendChild(grid);
      }

      const saveHint = document.createElement('div');
      saveHint.className = 'muted-meta';
      saveHint.textContent = 'After the drive: Data & export → Download CSV immediately (session data is memory-only and lost on reload) → Copy AI Prompt.';
      extras.appendChild(saveHint);
    }
  }
}

function renderCvtChecklistCard(targetId) {
  const card = $(targetId);
  if (!card) return;
  const activeProfile = getActiveProfile();
  const isCvtActive = Boolean(activeProfile?.isCvtProfile || state.cvtChecklistVisible);
  const isExportCard = targetId === 'export-cvt-checklist-card';
  const shouldShow = isCvtActive && (state.mode !== 'idle' || state.records.length > 0 || isExportCard);

  if (!shouldShow) {
    card.classList.add('hidden');
    return;
  }

  const isCollapsed = !isExportCard && state.cvtChecklistCollapsed;
  card.classList.remove('hidden');
  card.classList.toggle('is-collapsed', isCollapsed);

  const renderKey = `${isExportCard ? 'export' : 'dash'}:${isCollapsed ? 'collapsed' : 'open'}`;
  if (card.dataset.renderKey === renderKey) {
    return;
  }
  card.dataset.renderKey = renderKey;

  const toggleBtnHtml = isExportCard
    ? ''
    : `<button id="cvt-checklist-toggle-btn" class="btn btn-subtle btn-sm" type="button" aria-expanded="${!isCollapsed}">${isCollapsed ? 'Show checklist' : 'Hide'}</button>`;

  card.innerHTML = `
    <div class="panel-row-head" style="margin-bottom:0;">
      <h2>${isExportCard ? CVT_SERVICE_CHECKLIST.title : 'CVT Service Checklist'}</h2>
      ${toggleBtnHtml}
    </div>
    <div class="cvt-checklist-body ${isCollapsed ? 'hidden' : ''}">
      <div class="cvt-caution-box">${CVT_SERVICE_CHECKLIST.caution}</div>
      <div>
        <strong>Required service verification checklist:</strong>
        <ul class="cvt-checklist-list">
          ${CVT_SERVICE_CHECKLIST.items.map((item) => `<li>${item}</li>`).join('')}
        </ul>
      </div>
      <div>
        <strong class="muted-meta">3 common non-dealer CVT fluid service mistakes to double-check:</strong>
        <ul class="cvt-mistakes-list">
          ${CVT_SERVICE_CHECKLIST.nonDealerMistakes.map((m) => `<li>${m}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;

  if (!isExportCard) {
    const btn = card.querySelector('#cvt-checklist-toggle-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        state.cvtChecklistCollapsed = !state.cvtChecklistCollapsed;
        renderCvtChecklistCard('cvt-checklist-card');
      });
    }
  }
}

// Dashboard Rendering
function renderDashboard() {
  const isLive = state.mode === 'real' || state.mode === 'sim';
  const isAdapterOnly = state.mode === 'adapter_only';
  $('start-here-panel').classList.toggle('hidden', isLive);
  $('live-toolbar').classList.toggle('hidden', !isLive);
  $('mark-moment-form').classList.toggle('hidden', !isLive);
  const disconnectBtn = $('topbar-disconnect-btn');
  if (disconnectBtn) {
    disconnectBtn.classList.toggle('hidden', !isLive && !isAdapterOnly && !state.connecting);
    disconnectBtn.textContent = !isLive && !isAdapterOnly && state.connecting ? 'Cancel' : 'Disconnect';
  }
  const adapterOnlyBar = $('terminal-adapter-only-bar');
  if (adapterOnlyBar) {
    adapterOnlyBar.classList.toggle('hidden', !isAdapterOnly);
  }
  if (state.elm) {
    if ($('term-ati')) $('term-ati').textContent = state.elm.adapterIdentity || 'Unknown';
    if ($('term-atrv')) $('term-atrv').textContent = state.elm.batteryVoltage || '—';
    if ($('term-atdpn')) $('term-atdpn').textContent = state.elm.protocolNumber || 'Auto';
  }

  syncCaptureControlsUi();

  const preset = getActiveProfile();
  $('active-preset-label').textContent = state.captureMode
    ? 'Cold start / creep capture'
    : (preset ? preset.name : 'Custom layout');
  $('sample-count-label').textContent = `${state.records.length} sample${state.records.length === 1 ? '' : 's'}`;

  const quickSymptomBtn = $('quick-mark-symptom-btn');
  if (quickSymptomBtn) {
    const showQuickSymptom = isLive && (
      state.captureMode ||
      preset?.category === 'symptom' ||
      Boolean(preset?.isCvtProfile)
    );
    quickSymptomBtn.classList.toggle('hidden', !showQuickSymptom);
  }

  let badgeText = '';
  if (state.mode === 'sim') {
    badgeText = 'SIM';
  } else if (state.mode === 'real' && state.elm) {
    const prof = state.elm.adapterProfile;
    if (prof?.isFastAdapter) {
      badgeText = 'STN fast';
    } else if (prof?.isCloneV13) {
      badgeText = 'Clone · 6 max';
    } else {
      badgeText = `Proto ${state.elm.protocolNumber || 'Auto'}`;
    }
  }
  $('adapter-badge-label').textContent = badgeText;

  const { baseline } = getCurrentVehicleBaseline();
  const baseLabelEl = $('baseline-status-label');
  if (baseLabelEl) {
    if (baseline) {
      baseLabelEl.textContent = '· Baseline saved';
      baseLabelEl.classList.remove('hidden');
    } else {
      baseLabelEl.classList.add('hidden');
    }
  }

  // Consolidated single notice slot: never stack #dashboard-banner and #capture-banner simultaneously
  const banner = $('dashboard-banner');
  const captureBanner = $('capture-banner');
  let showDashBanner = false;
  let showCaptureBanner = false;

  if (isAdapterOnly) {
    banner.className = 'notice-banner';
    const volt = state.elm?.batteryVoltage ? ` (${state.elm.batteryVoltage})` : '';
    banner.textContent = `Adapter connected${volt}, but car ECU did not answer. Open Terminal Log to run quick test commands or retry the ECU handshake.`;
    showDashBanner = true;
  } else if (state.mode === 'idle' && state.disconnectedNotice) {
    banner.className = 'notice-banner notice-danger';
    banner.textContent = state.disconnectedNotice;
    showDashBanner = true;
  } else if (state.lastTrimmedWarning) {
    banner.className = 'notice-banner';
    banner.textContent = state.lastTrimmedWarning;
    showDashBanner = true;
  } else if (state.mode === 'real' && Date.now() < state.dongleReminderUntil) {
    banner.className = 'notice-banner';
    banner.textContent = 'Secure your dongle — OBD-II ports are loose and road vibration causes disconnects.';
    showDashBanner = true;
  } else if (state.slowAdapterTrimmed) {
    banner.className = 'notice-banner';
    banner.textContent = state.elm?.adapterProfile?.isCloneV13
      ? `ELM327 v1.3a clone capped at 6 variables (${state.elm.interCommandDelayMs} ms gap).`
      : 'Slow adapter — trimmed to 6 variables for ~1 Hz.';
    showDashBanner = true;
  } else if (state.captureMode && isLive) {
    if (captureBanner) {
      captureBanner.textContent = state.mode === 'sim'
        ? `Capture mode (SIMULATED: ${state.simulator?.scenario?.name || 'Demo'}) — logging RPM + Speed + RPM/speed. Tap "Mark shudder / symptom" when felt.`
        : 'Capture mode: logging RPM + Speed + RPM/speed. Tap "Mark shudder / symptom" when you feel it.';
    }
    showCaptureBanner = true;
  } else if (state.mode === 'sim') {
    banner.className = 'notice-banner';
    banner.textContent = `SIMULATED DATA (${state.simulator?.scenario?.name || 'Demo'}) — generated values, not a real vehicle.`;
    showDashBanner = true;
  }

  banner.classList.toggle('hidden', !showDashBanner);
  if (captureBanner) {
    captureBanner.classList.toggle('hidden', !showCaptureBanner);
  }

  renderDriveScriptCard();
  renderCvtChecklistCard('cvt-checklist-card');

  // Gauge cards
  const grid = $('gauges-grid');
  grid.innerHTML = '';

  if (!isLive) {
    $('chart-panel').classList.add('hidden');
    return;
  }

  const pidsToShow = getEffectiveDashboardPids();
  for (const pidId of pidsToShow) {
    const meta = state.pidMap.get(pidId);
    if (!meta) continue;

    const rawVal = state.liveValues[pidId];
    const disp = formatDisplayValue(meta, rawVal, state.settings.useImperial);
    const cachedUnit = getCachedPidUnit(meta, state.settings.useImperial);
    const minVal = state.sessionMin[pidId];
    const maxVal = state.sessionMax[pidId];
    const minText = minVal !== undefined ? formatDisplayValue(meta, minVal, state.settings.useImperial).text : '—';
    const maxText = maxVal !== undefined ? formatDisplayValue(meta, maxVal, state.settings.useImperial).text : '—';

    let pct = 0;
    if (disp.displayVal !== null && disp.displayMax > disp.displayMin) {
      pct = Math.max(0, Math.min(100, ((disp.displayVal - disp.displayMin) / (disp.displayMax - disp.displayMin)) * 100));
    }

    const isPlotted = state.chartPids.includes(pidId);
    const card = document.createElement('article');
    card.className = 'gauge-card';

    let tagLine = '';
    if (meta.isCalculated) {
      tagLine = '<div class="gauge-tag-line">calculated</div>';
    } else if (meta.unverified) {
      tagLine = '<div class="gauge-tag-line gauge-tag-unverified">unverified — confirm on your car</div>';
    }

    card.innerHTML = `
      <div class="gauge-top">
        <div class="gauge-title-wrap">
          <div class="gauge-name"></div>
          ${tagLine}
        </div>
        <button class="gauge-help-btn" type="button" aria-label="What does this mean?">?</button>
      </div>
      <div class="gauge-value-row">
        <span class="gauge-value">${escapeHtml(disp.text)}</span>
        <span class="gauge-unit">${escapeHtml(cachedUnit)}</span>
      </div>
      <div class="gauge-bar-track"><div class="gauge-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="gauge-footer">
        <span class="gauge-minmax">min ${escapeHtml(minText)} / max ${escapeHtml(maxText)}</span>
        <button class="plot-toggle-btn ${isPlotted ? 'active' : ''}" type="button">${isPlotted ? 'Plotted' : 'Plot'}</button>
      </div>
    `;
    card.querySelector('.gauge-name').textContent = meta.shortName;

    card.querySelector('.gauge-help-btn').addEventListener('click', () => {
      openModal(
        `${meta.name} (${meta.pidHex})`,
        `<p>${escapeHtml(meta.tooltip || 'Standard OBD-II diagnostic parameter.')}</p>
         <p class="muted-meta">Unit: ${escapeHtml(cachedUnit)} · Normal range bar: ${disp.displayMin.toFixed(0)} to ${disp.displayMax.toFixed(0)} ${escapeHtml(cachedUnit)}</p>
         ${meta.dependencies ? `<p class="muted-meta">Calculated from: ${escapeHtml(meta.dependencies.join(' + '))}</p>` : ''}`
      );
    });

    card.querySelector('.plot-toggle-btn').addEventListener('click', () => {
      const idx = state.chartPids.indexOf(pidId);
      if (idx !== -1) {
        state.chartPids.splice(idx, 1);
      } else {
        if (state.chartPids.length >= 4) {
          showToast('Live chart supports up to 4 variables at once — unplot one first.', 'warn');
          return;
        }
        state.chartPids.push(pidId);
      }
      persistProfileAndLayout();
      renderDashboard();
    });

    grid.appendChild(card);
  }

  updateChart();
}

// Variables Catalog View
function getSupportTag(pid) {
  if (pid.isCalculated) return { text: 'calculated', cls: 'support-yes' };
  if (pid.isCustom) return { text: pid.unverified ? 'custom · unverified' : 'custom', cls: 'support-unknown' };
  if (state.supportedPids === null) return { text: 'unknown', cls: 'support-unknown' };
  return state.supportedPids.has(pid.pidHex)
    ? { text: 'your car ✓', cls: 'support-yes' }
    : { text: 'not reported', cls: 'support-no' };
}

function renderVariables() {
  $('pid-cap-label').textContent = String(state.pidCap);
  $('supported-count-label').textContent =
    state.supportedPids === null
      ? 'Supported-PID scan: not run yet.'
      : `Supported-PID scan: ${state.supportedPids.size} Mode 01 PIDs reported by your car.`;

  const list = $('variables-list');
  list.innerHTML = '';

  const allPids = [...STANDARD_PIDS, ...CALCULATED_PIDS, ...state.customPids];
  const q = state.varFilterText.trim().toLowerCase();

  const filtered = allPids.filter((pid) => {
    if (isPidHiddenByBankRule(pid)) return false;
    if (state.varCategory === 'dashboard' && !state.dashboardPids.includes(pid.pidHex)) return false;
    if (state.varCategory === 'supported' && (!state.supportedPids || !state.supportedPids.has(pid.pidHex))) return false;
    if (state.varCategory === 'calculated' && !pid.isCalculated) return false;
    if (state.varCategory === 'custom' && !pid.isCustom) return false;
    if (q) {
      const hay = `${pid.name} ${pid.shortName} ${pid.pidHex} ${pid.unit} ${pid.category || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<p class="subtext">No variables match this filter.</p>';
    return;
  }

  for (const pid of filtered) {
    const onDash = state.dashboardPids.includes(pid.pidHex);
    const sup = getSupportTag(pid);
    const row = document.createElement('div');
    row.className = 'var-row';
    row.innerHTML = `
      <div class="var-info">
        <div class="var-title"></div>
        <div class="var-meta">
          <span class="mono">${escapeHtml(pid.pidHex)}</span>
          <span>·</span>
          <span>${escapeHtml(pid.unit)}</span>
          <span>·</span>
          <span class="${sup.cls}">${escapeHtml(sup.text)}</span>
        </div>
      </div>
      <button class="btn btn-sm ${onDash ? 'btn-primary' : 'btn-secondary'}" type="button">
        ${onDash ? 'On dashboard' : 'Add'}
      </button>
    `;
    row.querySelector('.var-title').textContent = pid.name;
    row.querySelector('button').addEventListener('click', () => {
      if (onDash) {
        state.dashboardPids = state.dashboardPids.filter((id) => id !== pid.pidHex);
        state.chartPids = state.chartPids.filter((id) => id !== pid.pidHex);
      } else {
        if (state.dashboardPids.length >= state.pidCap) {
          showToast(`Dashboard limit is ${state.pidCap} variables. Remove one first.`, 'warn');
          return;
        }
        state.dashboardPids.push(pid.pidHex);
      }
      state.activePresetId = 'custom';
      persistProfileAndLayout();
      renderVariables();
    });
    list.appendChild(row);
  }
}

// Scan Targets & Custom Profile Builder
function updateCustomProfilePidCount() {
  const checked = document.querySelectorAll('#cprof-pid-picker input[type="checkbox"]:checked').length;
  const countEl = $('cprof-pid-count');
  const capEl = $('cprof-pid-cap');
  if (capEl) capEl.textContent = String(state.pidCap);
  if (countEl) {
    countEl.textContent = checked > state.pidCap
      ? `${checked} selected (exceeds ${state.pidCap} cap — extras will trigger warning!)`
      : `${checked} selected`;
    countEl.className = checked > state.pidCap ? 'hint-err' : '';
  }
}

function openCustomProfileEditor(existing = null) {
  $('custom-profile-panel').classList.remove('hidden');
  $('cprof-form-title').textContent = existing ? `Edit "${existing.name}"` : 'Create custom diagnostic profile';
  $('cprof-edit-id').value = existing?.id || '';
  $('cprof-name').value = existing?.name || '';
  $('cprof-category').value = existing?.category || 'symptom';
  $('cprof-blurb').value = existing?.blurb || '';
  $('cprof-script').value = Array.isArray(existing?.driveScript) ? existing.driveScript.join('\n') : '';
  $('cprof-prompt').value = existing?.analysisPrompt || '';
  $('cprof-is-cvt').checked = Boolean(existing?.isCvtProfile);

  const selectedSet = new Set(existing?.pids || state.dashboardPids);
  const allPids = [...STANDARD_PIDS, ...CALCULATED_PIDS, ...state.customPids];
  const picker = $('cprof-pid-picker');
  picker.innerHTML = '';

  for (const p of allPids) {
    if (isPidHiddenByBankRule(p)) continue;
    const lbl = document.createElement('label');
    lbl.className = 'pid-pick-item';
    lbl.innerHTML = `<input type="checkbox" value="${escapeHtml(p.pidHex)}" ${selectedSet.has(p.pidHex) ? 'checked' : ''} /><span></span>`;
    lbl.querySelector('span').textContent = `${p.shortName} (${p.pidHex})`;
    lbl.querySelector('input').addEventListener('change', updateCustomProfilePidCount);
    picker.appendChild(lbl);
  }
  updateCustomProfilePidCount();
  $('custom-profile-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPresets() {
  document.querySelectorAll('#preset-category-tabs .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.cat === state.presetCategoryFilter);
  });

  const grid = $('presets-grid');
  grid.innerHTML = '';

  const allProfiles = getAllProfiles(state.customProfiles).filter((p) => {
    if (state.presetCategoryFilter === 'all') return true;
    if (state.presetCategoryFilter === 'custom') return Boolean(p.isCustom);
    return (p.category || 'symptom') === state.presetCategoryFilter;
  });

  if (allProfiles.length === 0) {
    grid.innerHTML = '<p class="subtext">No diagnostic profiles in this category yet. Tap "+ New custom profile" above to create one.</p>';
    return;
  }

  for (const preset of allProfiles) {
    const card = document.createElement('div');
    card.className = `preset-card ${state.activePresetId === preset.id ? 'active' : ''}`;
    const names = preset.pids.map((id) => state.pidMap.get(id)?.shortName || id).join(' · ');
    const optNames = preset.optionalPids?.length
      ? preset.optionalPids.map((id) => state.pidMap.get(id)?.shortName || id).join(' · ')
      : '';
    const exceedsCap = preset.pids.length > state.pidCap;
    const catLabel = preset.isCustom ? `custom · ${preset.category || 'symptom'}` : (preset.category || 'diagnostic');

    card.innerHTML = `
      <div>
        <div class="preset-meta-line">${escapeHtml(catLabel)} · ${preset.pids.length} PIDs${preset.driveScript?.length ? ` · ${preset.driveScript.length} script steps` : ''}</div>
        <h2></h2>
        <p class="subtext preset-blurb"></p>
        <p class="muted-meta preset-pids" style="margin-top:8px;"></p>
        ${optNames ? `<p class="muted-meta" style="margin-top:4px;">Optional (MX+ likely needed): ${escapeHtml(optNames)}</p>` : ''}
        ${exceedsCap ? `<p class="hint-err" style="font-size:0.8rem;margin-top:6px;">Exceeds current adapter cap (${preset.pids.length} &gt; ${state.pidCap}) — loading will warn and list trimmed PIDs.</p>` : ''}
      </div>
      <div class="preset-card-actions">
        <button class="btn ${state.activePresetId === preset.id ? 'btn-primary' : 'btn-secondary'} load-prof-btn" type="button">
          ${state.activePresetId === preset.id ? 'Active profile' : 'Load on dashboard'}
        </button>
        ${preset.isCustom ? '<button class="btn btn-subtle btn-sm edit-prof-btn" type="button">Edit</button><button class="btn btn-danger btn-sm del-prof-btn" type="button">Delete</button>' : ''}
      </div>
    `;
    card.querySelector('h2').textContent = preset.name;
    card.querySelector('.preset-blurb').textContent = preset.blurb || preset.symptoms || '';
    card.querySelector('.preset-pids').textContent = names;

    card.querySelector('.load-prof-btn').addEventListener('click', () => {
      applyPreset(preset.id);
      switchView('dashboard');
    });

    if (preset.isCustom) {
      card.querySelector('.edit-prof-btn').addEventListener('click', () => {
        openCustomProfileEditor(preset);
      });
      card.querySelector('.del-prof-btn').addEventListener('click', () => {
        state.customProfiles = saveCustomProfiles(state.customProfiles.filter((x) => x.id !== preset.id));
        if (state.activePresetId === preset.id) {
          state.activePresetId = 'general';
        }
        renderPresets();
        syncScanTargetSelectors();
        showToast(`Deleted custom profile "${preset.name}"`, 'ok');
      });
    }

    grid.appendChild(card);
  }
}

// Vehicle Profile & Garage View
function renderVehicleProfile() {
  const mfrSel = $('profile-mfr');
  const engSel = $('profile-engine');
  const transSel = $('profile-trans');

  mfrSel.innerHTML = VEHICLE_CATALOG.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  mfrSel.value = state.profile.mfrId;

  const { mfr, eng } = getEngineMeta(state.profile.mfrId, state.profile.engineId);
  engSel.innerHTML = mfr.engines.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  engSel.value = eng.id;
  state.profile.engineId = eng.id;

  transSel.innerHTML = eng.transmissions.map((t) => `<option value="${t}">${t}</option>`).join('');
  if (!eng.transmissions.includes(state.profile.transId)) {
    state.profile.transId = eng.transmissions[0];
  }
  transSel.value = state.profile.transId;

  $('show-bank2-toggle').checked = state.profile.showBank2;
  $('drawer-vehicle-summary').textContent = `${mfr.name} · ${eng.id}`;

  if (state.vehicleInfo.vin && !$('garage-vin-input').value) {
    $('garage-vin-input').value = state.vehicleInfo.vin;
  }

  const gList = $('garage-list');
  gList.innerHTML = '';
  if (state.garage.length === 0) {
    gList.innerHTML = '<p class="subtext">No vehicles saved yet. Save your car above to auto-restore its profile when its VIN connects.</p>';
    return;
  }

  for (const car of state.garage) {
    const item = document.createElement('div');
    item.className = 'list-item-card';
    item.innerHTML = `
      <div>
        <strong></strong>
        <div class="muted-meta">${escapeHtml(car.mfrId)} · ${escapeHtml(car.engineId)} · ${escapeHtml(car.transId)}${car.vin ? ` · VIN ${escapeHtml(car.vin)}` : ''}</div>
      </div>
      <div class="inline-actions" style="margin-top:0;">
        <button class="btn btn-sm btn-secondary load-car-btn" type="button">Load</button>
        <button class="btn btn-sm btn-danger del-car-btn" type="button">Delete</button>
      </div>
    `;
    item.querySelector('strong').textContent = car.nickname;
    item.querySelector('.load-car-btn').addEventListener('click', () => {
      state.profile = {
        mfrId: car.mfrId,
        engineId: car.engineId,
        transId: car.transId,
        showBank2: Boolean(car.showBank2),
      };
      if (Array.isArray(car.layoutPids) && car.layoutPids.length) {
        state.dashboardPids = car.layoutPids.slice(0, state.pidCap);
      }
      persistProfileAndLayout();
      renderVehicleProfile();
      showToast(`Loaded "${car.nickname}"`, 'ok');
    });
    item.querySelector('.del-car-btn').addEventListener('click', () => {
      state.garage = state.garage.filter((c) => c.id !== car.id);
      saveGarage(state.garage);
      renderVehicleProfile();
    });
    gList.appendChild(item);
  }
}

// Trouble Codes & Readiness View
function renderDtcsView() {
  const info = state.vehicleInfo;
  const metaEl = $('dtc-vehicle-meta');
  const makeYear = [info.make, info.year].filter(Boolean).join(' ') || 'Unknown';
  metaEl.innerHTML = `
    <div class="kv-row"><dt>VIN</dt><dd class="mono">${escapeHtml(info.vin || 'Not returned')}</dd></div>
    <div class="kv-row"><dt>Decoded Make / Year</dt><dd>${escapeHtml(makeYear)}</dd></div>
    <div class="kv-row"><dt>Check Engine Light (MIL)</dt><dd>${info.milOn === null ? '—' : info.milOn ? 'ON (Active)' : 'OFF'}</dd></div>
    <div class="kv-row"><dt>ECU Reported DTC Count</dt><dd>${escapeHtml(info.dtcCount ?? '—')}</dd></div>
    <div class="kv-row"><dt>Distance With MIL On</dt><dd>${info.distanceWithMil !== null ? `${escapeHtml(info.distanceWithMil)} km` : '—'}</dd></div>
    <div class="kv-row"><dt>Distance Since Codes Cleared</dt><dd>${info.distanceSinceClear !== null ? `${escapeHtml(info.distanceSinceClear)} km` : '—'}</dd></div>
    <div class="kv-row"><dt>Warm-ups Since Cleared</dt><dd>${escapeHtml(info.warmupsSinceClear ?? '—')}</dd></div>
  `;

  // Recent clear alert (Requirement 13)
  const alertEl = $('recent-clear-alert');
  const distLow = info.distanceSinceClear !== null && info.distanceSinceClear < 80;
  const warmLow = info.warmupsSinceClear !== null && info.warmupsSinceClear < 5;
  if (distLow || warmLow) {
    alertEl.className = 'notice-banner notice-danger';
    alertEl.textContent = `Heads up: looks like codes were cleared ${info.distanceSinceClear ?? '?'} km / ${info.warmupsSinceClear ?? '?'} warm-ups ago. Check readiness monitors carefully before buying.`;
    alertEl.classList.remove('hidden');
  } else {
    alertEl.classList.add('hidden');
  }

  // Readiness monitors
  const readyEl = $('readiness-list');
  if (!info.monitors || info.monitors.length === 0) {
    readyEl.innerHTML = '<p class="subtext">No readiness data read yet.</p>';
  } else {
    readyEl.innerHTML = info.monitors
      .map(
        (m) => `
        <div class="list-item-card">
          <span>${escapeHtml(m.name)}</span>
          <span class="${m.ready ? 'support-yes' : 'gauge-tag-unverified'}">${m.ready ? 'Ready ✓' : 'Incomplete'}</span>
        </div>`
      )
      .join('');
  }

  // DTC lists
  const renderList = (elId, codes, emptyLabel) => {
    const el = $(elId);
    if (!codes || codes.length === 0) {
      el.innerHTML = `<p class="subtext">${escapeHtml(emptyLabel)}</p>`;
      return;
    }
    el.innerHTML = codes
      .map((code) => {
        const desc = DTC_DESCRIPTIONS[code] || 'Standard OBD-II trouble code (look up manufacturer details)';
        return `<div class="dtc-item"><div class="dtc-code">${escapeHtml(code)}</div><div class="dtc-desc">${escapeHtml(desc)}</div></div>`;
      })
      .join('');
  };

  renderList('dtc-stored-list', info.dtcs.stored, 'No stored codes');
  renderList('dtc-pending-list', info.dtcs.pending, 'No pending codes');
  renderList('dtc-permanent-list', info.dtcs.permanent, 'No permanent codes');
}

// Custom PIDs View
function renderCustomPids() {
  const list = $('custom-pids-list');
  list.innerHTML = '';
  if (state.customPids.length === 0) {
    list.innerHTML = '<p class="subtext">No custom PIDs defined.</p>';
    return;
  }

  for (const p of state.customPids) {
    const onDash = state.dashboardPids.includes(p.id);
    const item = document.createElement('div');
    item.className = 'list-item-card';
    item.innerHTML = `
      <div>
        <strong></strong>
        <div class="muted-meta">
          <span class="mono">${escapeHtml(p.header || '7DF')} → ${escapeHtml(p.request)}</span> · <code>${escapeHtml(p.formula)}</code> · ${escapeHtml(p.unit)} · tag: ${escapeHtml(p.tag)}
          ${p.unverified ? ' · <span class="gauge-tag-unverified">unverified — confirm on your car</span>' : ''}
        </div>
      </div>
      <div class="inline-actions" style="margin-top:0;">
        <button class="btn btn-sm ${onDash ? 'btn-primary' : 'btn-secondary'} toggle-cpid-btn" type="button">${onDash ? 'On dash' : 'Add to dash'}</button>
        <button class="btn btn-sm btn-subtle edit-cpid-btn" type="button">Edit</button>
        <button class="btn btn-sm btn-danger del-cpid-btn" type="button">Delete</button>
      </div>
    `;
    item.querySelector('strong').textContent = p.name;

    item.querySelector('.toggle-cpid-btn').addEventListener('click', () => {
      if (onDash) {
        state.dashboardPids = state.dashboardPids.filter((id) => id !== p.id);
      } else {
        if (state.dashboardPids.length >= state.pidCap) {
          showToast(`Dashboard limit is ${state.pidCap} variables.`, 'warn');
          return;
        }
        state.dashboardPids.push(p.id);
      }
      persistProfileAndLayout();
      renderCustomPids();
    });

    item.querySelector('.edit-cpid-btn').addEventListener('click', () => {
      $('cpid-edit-id').value = p.id;
      $('cpid-name').value = p.name;
      $('cpid-short').value = p.shortName;
      $('cpid-unit').value = p.unit;
      $('cpid-tag').value = p.tag;
      $('cpid-header').value = p.header;
      $('cpid-request').value = p.request;
      $('cpid-formula').value = p.formula;
      $('cpid-min').value = p.min;
      $('cpid-max').value = p.max;
      $('cpid-cancel-btn').classList.remove('hidden');
      validateCustomFormulaInput();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    item.querySelector('.del-cpid-btn').addEventListener('click', () => {
      state.customPids = saveCustomPids(state.customPids.filter((c) => c.id !== p.id));
      state.dashboardPids = state.dashboardPids.filter((id) => id !== p.id);
      state.chartPids = state.chartPids.filter((id) => id !== p.id);
      rebuildPidMap();
      persistProfileAndLayout();
      renderCustomPids();
      showToast('Custom PID deleted', 'ok');
    });

    list.appendChild(item);
  }
}

function validateCustomFormulaInput() {
  const val = $('cpid-formula').value;
  const hint = $('cpid-formula-status');
  if (!val.trim()) {
    hint.textContent = '';
    hint.className = 'field-hint';
    return true;
  }
  const res = validateFormula(val);
  if (res.valid) {
    try {
      const sample = compileFormula(val).evaluate([0x04, 0xd2, 0x10, 0x00]);
      hint.textContent = `Valid formula (test with bytes [04 D2 10 00] = ${sample !== null ? sample.toFixed(2) : 'null'})`;
      hint.className = 'field-hint hint-ok';
    } catch {
      hint.textContent = 'Valid syntax';
      hint.className = 'field-hint hint-ok';
    }
    return true;
  } else {
    hint.textContent = res.error;
    hint.className = 'field-hint hint-err';
    return false;
  }
}

// Export & AI Prompt View + Per-Vehicle Baseline Management
function getExportPayload() {
  const { mfr, eng } = getEngineMeta(state.profile.mfrId, state.profile.engineId);
  const profileLabel = `${mfr.name} · ${eng.name} · ${state.profile.transId}`;
  const recordedPidIds = Array.from(
    new Set([
      ...getEffectiveDashboardPids(),
      ...Object.keys(state.liveValues).filter((k) => state.pidMap.has(k)),
    ])
  );
  const { baseline } = getCurrentVehicleBaseline();
  return {
    records: state.records,
    recordedPidIds,
    pidMap: state.pidMap,
    vehicleInfo: state.vehicleInfo,
    profileLabel,
    activeProfile: getActiveProfile(),
    adapterInfo: getAdapterInfoSnapshot(),
    pidHealthTracker: state.pidHealthTracker,
    baseline,
    sessionPurpose: state.settings.sessionPurpose,
    userNotes: state.settings.userNotes,
    isSimulatedSession: state.isSimulatedSession || state.mode === 'sim',
    captureMode: Boolean(state.captureMode),
    samplingRateHz: state.samplingRateHz,
  };
}

function saveCurrentAsBaseline() {
  if (!state.records || state.records.length === 0) {
    showToast('Record some live samples before saving a vehicle baseline.', 'warn');
    return;
  }
  const payload = getExportPayload();
  const stats = computeSessionStats(payload.records, payload.recordedPidIds, state.pidMap);
  const { key } = getCurrentVehicleBaseline();
  const saved = saveBaselineForVehicle(key, {
    key,
    label: `${payload.profileLabel}${state.vehicleInfo.vin ? ` (${state.vehicleInfo.vin})` : ''}`,
    savedAt: new Date().toISOString(),
    sampleCount: payload.records.length,
    profileId: state.activePresetId,
    stats,
  });
  showToast(`Saved known-good baseline (${saved.sampleCount} samples)`, 'ok');
  renderDashboard();
  if (state.activeView === 'export') renderExportView();
}

function renderExportView() {
  document.querySelectorAll('#purpose-selector .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.purpose === state.settings.sessionPurpose);
  });
  $('session-notes-input').value = state.settings.userNotes;

  const payload = getExportPayload();
  const durationS = payload.records.length > 1
    ? ((payload.records[payload.records.length - 1].ts - payload.records[0].ts) / 1000).toFixed(1)
    : '0.0';
  const marks = payload.records.filter((r) => r.event && r.event.trim());
  const aiRows = downsampleRecordsForAi(payload.records, { targetHz: 1.5, maxRows: 600 });

  $('export-summary-kv').innerHTML = `
    <div class="kv-row"><dt>Data Source</dt><dd>${payload.isSimulatedSession ? 'SIMULATED' : 'Real Adapter'}</dd></div>
    <div class="kv-row"><dt>Diagnostic Profile</dt><dd>${escapeHtml(payload.activeProfile ? payload.activeProfile.name : 'Custom layout')}</dd></div>
    <div class="kv-row"><dt>Samples Recorded (AI CSV)</dt><dd>${payload.records.length} raw (${aiRows.length} AI-sized)</dd></div>
    <div class="kv-row"><dt>Duration</dt><dd>${durationS} s</dd></div>
    <div class="kv-row"><dt>Sampling Rate</dt><dd>${payload.samplingRateHz.toFixed(2)} Hz</dd></div>
    <div class="kv-row"><dt>Marked Moments</dt><dd>${marks.length}</dd></div>
  `;

  const t0 = payload.records[0]?.ts || Date.now();
  $('marked-moments-summary').innerHTML = marks.length
    ? '<strong>Marked moments:</strong>' +
      marks.map((m) => `<div>t+${((m.ts - t0) / 1000).toFixed(1)}s — ${escapeHtml(m.event)}</div>`).join('')
    : '<span class="muted-meta">No moments marked yet during this session.</span>';

  // Baseline status & comparisons
  const { baseline } = getCurrentVehicleBaseline();
  const deltaList = $('baseline-delta-list');
  if (baseline) {
    $('baseline-summary-text').textContent = `Active baseline: ${baseline.label} · saved ${baseline.savedAt.slice(0, 10)} (${baseline.sampleCount} samples). AI prompt switches to "Compare to baseline" mode.`;
    $('clear-baseline-btn').classList.remove('hidden');
    const curStats = computeSessionStats(payload.records, payload.recordedPidIds, state.pidMap);
    const comps = computeBaselineComparison(curStats, baseline);
    if (comps.length === 0) {
      deltaList.innerHTML = '<p class="subtext">Record live samples with matching PIDs to compare against this baseline.</p>';
    } else {
      deltaList.innerHTML = comps
        .map((c) => {
          const sign = c.deltaAvg >= 0 ? '+' : '';
          return `<div class="baseline-delta-row"><strong>${escapeHtml(c.name)} (${escapeHtml(c.pidHex)})</strong><span class="tabular">Now ${c.currentAvg.toFixed(c.decimals)} vs Base ${c.baselineAvg.toFixed(c.decimals)} ${escapeHtml(c.unit)} (${sign}${c.deltaAvg.toFixed(c.decimals)})</span></div>`;
        })
        .join('');
    }
  } else {
    $('baseline-summary-text').textContent = 'Save a healthy drive as your baseline for this VIN or vehicle profile. Future AI prompts switch to "Compare to baseline" automatically.';
    $('clear-baseline-btn').classList.add('hidden');
    deltaList.innerHTML = '';
  }

  renderCvtChecklistCard('export-cvt-checklist-card');
  $('ai-prompt-preview').textContent = buildAiPrompt(payload);
}

// Compute Calculated PIDs from current liveValues
function computeCalculatedValues(valuesObj) {
  for (const calc of CALCULATED_PIDS) {
    if (isPidHiddenByBankRule(calc)) continue;
    const val = calc.compute(valuesObj);
    if (val !== null && Number.isFinite(val)) {
      valuesObj[calc.pidHex] = val;
    }
  }
}

function recordCycleSample(valuesObj, simulated) {
  computeCalculatedValues(valuesObj);
  for (const [k, v] of Object.entries(valuesObj)) {
    state.liveValues[k] = v;
    if (v !== null && Number.isFinite(v)) {
      if (state.sessionMin[k] === undefined || v < state.sessionMin[k]) state.sessionMin[k] = v;
      if (state.sessionMax[k] === undefined || v > state.sessionMax[k]) state.sessionMax[k] = v;
    }
  }

  const eventText = state.pendingEvent;
  state.pendingEvent = '';

  state.records.push({
    ts: Date.now(),
    simulated,
    values: { ...valuesObj },
    event: eventText,
  });

  if (simulated && state.pidHealthTracker) {
    const elapsedSec = state.records.length > 0 ? (Date.now() - state.records[0].ts) / 1000 : 0;
    for (const [k, v] of Object.entries(valuesObj)) {
      if (v !== null && Number.isFinite(v)) {
        state.pidHealthTracker.record({ pid: k, status: 'ok', value: v, elapsedSec });
      }
    }
  }

  if (state.activeView === 'dashboard') {
    renderDashboard();
  }
}

// Handle DTCs found -> auto-load matching scan-target preset (Requirement 14)
function handleDiscoveredDtcs(dtcsObj) {
  state.vehicleInfo.dtcs = dtcsObj;
  const allCodes = [...dtcsObj.stored, ...dtcsObj.pending, ...dtcsObj.permanent];
  if (allCodes.length === 0) return;

  const matchedPresetId = findMatchingPresetForDtcs(allCodes, state.profile);
  if (matchedPresetId) {
    const preset = getAllProfiles(state.customProfiles).find((p) => p.id === matchedPresetId);
    if (preset) {
      applyPreset(matchedPresetId, { silent: true });
      const msg = `Codes found (${allCodes.join(', ')}) — loaded ${preset.name} dashboard`;
      appendLog({ ts: new Date(), dir: 'SYS', text: msg });
      showToast(msg, 'warn');
    }
  }
}

// VIN auto-recognition against My Vehicles Garage (Requirement 16)
function checkGarageVinMatch(vin) {
  if (!vin) return;
  const match = state.garage.find((c) => c.vin && c.vin.toUpperCase() === vin.toUpperCase());
  if (!match) return;
  state.profile = {
    mfrId: match.mfrId,
    engineId: match.engineId,
    transId: match.transId,
    showBank2: Boolean(match.showBank2),
  };
  if (Array.isArray(match.layoutPids) && match.layoutPids.length > 0) {
    state.dashboardPids = match.layoutPids.slice(0, state.pidCap);
  }
  persistProfileAndLayout();
  renderVehicleProfile();
  showToast(`Recognized saved vehicle: ${match.nickname}`, 'ok');
}

async function proveLiveRpm(elm) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rpmResp = await elm.sendCommand('010C', 3000);
      const reply = inspectObdReply(rpmResp, '010C');
      const rpmMeta = state.pidMap.get('010C');
      if (reply.status === 'ok' && rpmMeta) {
        const parsed = rpmMeta.decodeBytes(reply.bytes);
        if (parsed !== null && Number.isFinite(parsed)) {
          return parsed;
        }
      } else if (reply.status === 'desync' && attempt < 2) {
        await elm.resyncBuffer();
        continue;
      } else if (reply.status === 'no_data' && attempt < 2) {
        await sleep(200);
        continue;
      }
    } catch (err) {
      if (classifyElmError(err, elm._getTransportSnapshot?.()) === ERROR_CATEGORY.OS_SERIAL) {
        throw err;
      }
    }
    if (attempt < 2) await sleep(200);
  }
  return null;
}

function finishWithCleanDisconnect(elm, reasonText) {
  state.pollActive = false;
  state.reconnecting = false;
  state.deferredScanPending = null;
  state.dongleReminderUntil = 0;
  state.mode = 'idle';
  state.pidCap = 10;
  state.slowAdapterTrimmed = false;
  state.disconnectedNotice = reasonText || 'Adapter disconnected — reconnect to resume';
  savePartialCsvSnapshot({ download: true });
  updateWakeLock(false);
  setStatus(state.disconnectedNotice, 'error');
  showToast(state.disconnectedNotice, 'err');
  renderDashboard();
}

async function attemptAutoReconnect(elm) {
  if (state.reconnecting || elm.detached) return;
  if (state.elm !== elm) return;
  state.reconnecting = true;
  state.pollActive = false;

  // Save partial CSV snapshot in memory/storage right away before attempting reopen
  savePartialCsvSnapshot({ download: false, silent: true });

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (elm.detached || state.elm !== elm) break;
    setStatus(`Port lost — auto-reconnecting (attempt ${attempt}/${maxAttempts})…`, 'warn');
    appendLog({
      ts: new Date(),
      dir: 'SYS',
      text: `OS/SERIAL recovery attempt ${attempt}/${maxAttempts}: reopening port and running full init sequence…`,
    });

    try {
      await sleep(attempt === 1 ? 350 : 900);
      if (elm.detached || state.elm !== elm) break;

      const res = await elm.reconnect();
      if (res && !res.ok) {
        throw new Error('Port reopened but vehicle ECU did not reply');
      }
      const rpmVal = typeof res?.initialRpmValue === 'number'
        ? res.initialRpmValue
        : await proveLiveRpm(elm);
      if (rpmVal === null || rpmVal === undefined) {
        throw new Error('Port reopened but 010C RPM did not respond');
      }

      if ($('term-ati')) $('term-ati').textContent = elm.adapterIdentity || 'Unknown';
      if ($('term-atrv')) $('term-atrv').textContent = elm.batteryVoltage || '—';
      if ($('term-atdpn')) $('term-atdpn').textContent = elm.protocolNumber || 'Auto';
      state.mode = 'real';
      state.reconnecting = false;
      state.disconnectedNotice = '';
      state.liveValues['010C'] = rpmVal;
      state.dongleReminderUntil = Date.now() + 12000;
      await updateWakeLock(true);
      appendLog({ ts: new Date(), dir: 'SYS', text: 'Auto-reconnect succeeded — resuming live telemetry.' });
      showToast('Adapter reconnected — resuming live logging', 'ok');
      renderDashboard();
      runRealPollingLoop(elm);
      return;
    } catch (err) {
      const detail = formatOsErrorDetail(err, elm._getTransportSnapshot?.());
      appendLog({
        ts: new Date(),
        dir: 'SYS',
        text: `Auto-reconnect attempt ${attempt} failed: ${detail}`,
      });
      if (elm.detached) {
        break;
      }
    }
  }

  state.reconnecting = false;
  await elm.disconnect().catch(() => {});
  if (state.elm === elm) state.elm = null;
  finishWithCleanDisconnect(elm, 'Adapter disconnected — reconnect to resume');
}

function handleElmOsError(elm, { isDetachEvent, detail, consecutiveOsErrors }) {
  if (state.elm !== elm) return;
  state.pollActive = false;

  if (isDetachEvent) {
    appendLog({ ts: new Date(), dir: 'SYS', text: `Clean detach broadcast: ${detail}` });
    finishWithCleanDisconnect(elm, 'Adapter disconnected — reconnect to resume');
    return;
  }

  // After 2 consecutive OS-level errors, stop resync/retries entirely and enter manual reconnect state
  if (consecutiveOsErrors >= 2 && !state.reconnecting) {
    appendLog({
      ts: new Date(),
      dir: 'SYS',
      text: `2 consecutive OS/SERIAL errors (${detail}) — stopping resync & switching to reconnect mode.`,
    });
    finishWithCleanDisconnect(elm, 'Adapter disconnected — reconnect to resume');
    return;
  }

  if (!state.reconnecting) {
    attemptAutoReconnect(elm);
  }
}

function setConnectingUi(isConnecting) {
  state.connecting = Boolean(isConnecting);
  const btnIds = [
    'connect-ble-btn',
    'connect-serial-btn',
    'start-sim-btn',
    'retry-ecu-handshake-btn',
  ];
  for (const id of btnIds) {
    const el = $(id);
    if (el) el.disabled = state.connecting;
  }
  const disconnectBtn = $('topbar-disconnect-btn');
  if (disconnectBtn) {
    const hasSession = state.mode !== 'idle';
    disconnectBtn.classList.toggle('hidden', !hasSession && !state.connecting);
    disconnectBtn.textContent = !hasSession && state.connecting ? 'Cancel' : 'Disconnect';
  }
}

function enterAdapterOnlyTerminalMode(elm) {
  state.mode = 'adapter_only';
  state.isSimulatedSession = false;
  state.pollActive = false;
  setConnectingUi(false);

  if ($('term-ati')) $('term-ati').textContent = elm.adapterIdentity || 'Unknown';
  if ($('term-atrv')) $('term-atrv').textContent = elm.batteryVoltage || '—';
  if ($('term-atdpn')) $('term-atdpn').textContent = elm.protocolNumber || 'Auto';
  if ($('term-state')) $('term-state').textContent = 'Adapter ready (ECU silent)';

  renderDashboard();
  switchView('terminal');
  const volt = elm.batteryVoltage ? ` (${elm.batteryVoltage})` : '';
  showToast(`Adapter talking${volt}, but car ECU stayed silent. Test commands in Terminal Log or tap Retry ECU Handshake.`, 'warn');
}

async function enterLiveModeAfterNegotiation(elm, negotiationResult = {}) {
  if (state.elm !== elm || elm._closing) {
    await elm.disconnect();
    return;
  }

  setConnectingUi(false);

  // Update terminal identity metadata & apply Adapter Capability Layer
  if ($('term-ati')) $('term-ati').textContent = elm.adapterIdentity || 'Unknown';
  if ($('term-atrv')) $('term-atrv').textContent = elm.batteryVoltage || '—';
  if ($('term-atdpn')) $('term-atdpn').textContent = elm.protocolNumber || 'Auto';

  const prof = elm.adapterProfile;
  state.pidCap = prof.maxDashboardPids;
  if (prof.isFastAdapter) {
    showToast('Fast STN / OBDLink adapter detected — cap raised to 20 PIDs.', 'ok');
  } else if (prof.isCloneV13) {
    showToast(`Conservative ${elm.adapterIdentity || 'ELM327 v1.3a'} profile active: ${elm.interCommandDelayMs} ms TX delay, max ${prof.maxDashboardPids} PIDs at 1 Hz.`, 'warn');
  }

  // Seed 0100 bitmask (or universal core PIDs if unlocked directly via Stage B 01 0C RPM)
  const supported = new Set();
  let has0120 = false;
  if (elm.initial0100Bytes) {
    const block0 = decodeSupportedBitmask(elm.initial0100Bytes, 0x0100);
    block0.supported.forEach((p) => supported.add(p));
    has0120 = block0.hasNextBlock;
    state.supportedPidsComplete = !has0120;
  } else {
    ['0104', '0105', '0106', '0107', '010C', '010D', '010F', '0110', '0111', '0142'].forEach((p) => supported.add(p));
    state.supportedPidsComplete = false;
  }
  state.supportedPids = supported;

  // Prove live data with a single 010C (RPM) reading (or reuse verified direct RPM from Stage B)
  let rpmVal = typeof negotiationResult.initialRpmValue === 'number'
    ? negotiationResult.initialRpmValue
    : elm.initialRpmValue;

  if (rpmVal === null || rpmVal === undefined) {
    setStatus('✓ Connected, waiting for first RPM reading…', 'working');
    try {
      rpmVal = await proveLiveRpm(elm);
    } catch (err) {
      if (classifyElmError(err, elm._getTransportSnapshot?.()) === ERROR_CATEGORY.OS_SERIAL) {
        return;
      }
    }
  }

  if (rpmVal === null || rpmVal === undefined) {
    setStatus("Adapter is talking, but the car isn't returning RPM. Is the key ON and the engine running?", 'error');
    showToast('010C RPM did not return — check key ON / engine running.', 'warn');
    state.mode = 'real';
    state.isSimulatedSession = false;
    renderDashboard();
    return;
  }

  // Display first proven RPM value immediately & show "secure your dongle" vibration reminder!
  state.mode = 'real';
  state.isSimulatedSession = false;
  state.slowAdapterTrimmed = false;
  state.dongleReminderUntil = Date.now() + 15000;
  if (negotiationResult.usedMinimalInit) {
    showToast('Connected via minimal-init recovery mode (ATD/ATE0).', 'ok');
  } else {
    showToast('Secure your dongle — OBD ports are loose; vibration causes disconnects.', 'warn');
  }
  appendLog({ ts: new Date(), dir: 'SYS', text: 'Reminder: Secure your dongle — OBD-II ports are loose and vibration causes disconnects.' });

  // Enforce adapter capability cap upfront (e.g. max 6 PIDs on v1.3a clones) — warn explicitly, never silent
  if (state.captureMode) {
    applyCaptureModeLayout();
  } else if (state.dashboardPids.length > state.pidCap) {
    const { kept } = enforcePidCapWithWarning(state.dashboardPids, 'Adapter startup', true);
    state.dashboardPids = kept;
    state.chartPids = state.chartPids.filter((id) => state.dashboardPids.includes(id));
  }

  state.liveValues = { '010C': rpmVal };
  state.sessionMin = { '010C': rpmVal };
  state.sessionMax = { '010C': rpmVal };
  renderDashboard();
  if (state.activeView === 'terminal') {
    switchView('dashboard');
  }
  await updateWakeLock(true);

  // In Capture mode, defer heavy background scans (0120/0140, 0902 VIN, 0101, clear distances, 03/07/0A)
  // until Capture mode is exited so cold-start live RPM + Speed polling begins immediately at max rate.
  if (!elm.portDead && !elm.detached) {
    if (state.captureMode) {
      state.deferredScanPending = { elm, has0120, supported };
      appendLog({
        ts: new Date(),
        dir: 'SYS',
        text: 'Capture mode active — deferring 0120/0140, 0902 VIN, 0101 readiness & 03/07/0A DTC scan until capture stops.',
      });
    } else {
      state.deferredScanPending = null;
      await runInitialVehicleScan(elm, has0120, supported);
    }
  }

  // Re-enforce adapter cap if DTC auto-load selected a >6 PID preset on a v1.3a clone
  if (!state.captureMode && state.dashboardPids.length > state.pidCap) {
    const { kept } = enforcePidCapWithWarning(state.dashboardPids, 'Auto-loaded profile', true);
    state.dashboardPids = kept;
    state.chartPids = state.chartPids.filter((id) => state.dashboardPids.includes(id));
    renderDashboard();
  }

  // Start serial multi-PID polling loop with OS/PROTOCOL separation & adaptive pacing
  if (elm.connected && !elm.portDead && !elm.detached) {
    runRealPollingLoop(elm);
  }
}

async function retryEcuHandshake() {
  const elm = state.elm;
  if (!elm || state.mode !== 'adapter_only') {
    showToast('Connect an adapter first to retry ECU handshake.', 'warn');
    return;
  }
  if (state.connecting) return;

  setConnectingUi(true);
  appendLog({ ts: new Date(), dir: 'SYS', text: 'Retrying two-stage ECU handshake on active adapter…' });
  try {
    const res = await elm.negotiateVehicleProtocol({ skipStandardInit: false });
    if (state.elm !== elm || elm._closing) return;
    if (res && res.ok) {
      await enterLiveModeAfterNegotiation(elm, res);
    } else {
      enterAdapterOnlyTerminalMode(elm);
    }
  } catch (err) {
    if (state.elm !== elm || elm._closing) return;
    const detail = formatOsErrorDetail(err, elm._getTransportSnapshot?.());
    showToast(err.message, 'err');
    appendLog({ ts: new Date(), dir: 'SYS', text: `Retry handshake failed: ${detail}` });
    if (classifyElmError(err, elm._getTransportSnapshot?.()) === ERROR_CATEGORY.OS_SERIAL) {
      await disconnectSession();
    } else {
      setConnectingUi(false);
    }
  }
}

// Real OBD-II Connect + Two-Stage Handshake + Direct Terminal Fallback
async function startRealConnection(type) {
  if (state.connecting) {
    showToast('Connection already in progress — tap Cancel first to retry or switch ports.', 'warn');
    return;
  }

  // IMPORTANT: Trigger the browser device/port picker BEFORE any async disconnect/wakeLock awaits
  // so Chrome/Edge never drops transient user activation (SecurityError) on startup.
  let selectedHandle = null;
  try {
    setStatus('Step 1 of 3 — pick your adapter', 'info');
    selectedHandle =
      type === 'ble'
        ? await requestBleScannerDevice()
        : await requestSerialScannerPort();
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      const msg =
        type === 'ble'
          ? 'No BLE adapter selected. If your scanner is Bluetooth Classic (~$20 ELM327), pair it in OS Bluetooth settings and tap "Connect: Classic / USB".'
          : 'No serial port selected. Make sure your ELM327 is paired in OS Bluetooth settings (or plugged in via USB) and try again.';
      setStatus(msg, 'warn');
      showToast('No scanner selected in browser picker.', 'warn');
      appendLog({ ts: new Date(), dir: 'SYS', text: `Picker dismissed / no device chosen (${err.message})` });
    } else {
      setStatus(err?.message || 'Could not open scanner picker', 'error');
      showToast(err?.message || 'Could not open scanner picker', 'err');
      appendLog({ ts: new Date(), dir: 'SYS', text: `Picker error: ${err?.name || 'Error'}: ${err?.message || err}` });
    }
    return;
  }

  setConnectingUi(true);

  if (state.mode !== 'idle' || state.elm) {
    await disconnectSession();
    setConnectingUi(true);
  }
  if (state.isSimulatedSession) {
    newSession();
    state.isSimulatedSession = false;
  }
  state.vehicleInfo = createEmptyVehicleInfo();
  state.supportedPids = null;
  state.supportedPidsComplete = false;
  state.disconnectedNotice = '';
  state.dongleReminderUntil = 0;
  state.logs = [];
  $('terminal-log-box').innerHTML = '';

  const elm = new Elm327Connection({
    txDelayMs: state.settings.txDelayMs,
    onStatus: (msg, level) => {
      if (state.elm !== elm) return;
      setStatus(msg, level);
    },
    onLog: (entry) => {
      if (state.elm !== elm) return;
      appendLog(entry);
    },
    onOsError: (info) => {
      if (state.elm !== elm) return;
      handleElmOsError(elm, info);
    },
    onDisconnect: (reason) => {
      if (state.elm !== elm) return;
      finishWithCleanDisconnect(elm, reason || 'Adapter disconnected — reconnect to resume');
    },
  });

  state.elm = elm;

  let negotiationResult = null;
  try {
    negotiationResult =
      type === 'ble'
        ? await elm.connectBLE(selectedHandle)
        : await elm.connectSerial(selectedHandle);
  } catch (err) {
    const wasCancelled = state.elm !== elm || elm._closing;
    if (!wasCancelled) {
      const detail = formatOsErrorDetail(err, elm._getTransportSnapshot?.());
      showToast(err.message, 'err');
      appendLog({ ts: new Date(), dir: 'SYS', text: `Connect failed: ${detail}` });
    }
    await elm.disconnect();
    if (state.elm === elm) {
      state.elm = null;
      setConnectingUi(false);
    }
    return;
  }

  if (state.elm !== elm || elm._closing) {
    await elm.disconnect();
    return;
  }

  if (negotiationResult && !negotiationResult.ok && negotiationResult.adapterAlive) {
    enterAdapterOnlyTerminalMode(elm);
    return;
  }

  await enterLiveModeAfterNegotiation(elm, negotiationResult || {});
}

async function runInitialVehicleScan(elm, has0120, supported) {
  try {
    if (has0120) {
      const r20 = await elm.sendCommand('0120', 8000);
      const b20 = extractPidPayload(r20, '0120');
      if (b20) {
        const dec20 = decodeSupportedBitmask(b20, 0x0120);
        dec20.supported.forEach((p) => supported.add(p));
        if (dec20.hasNextBlock) {
          const r40 = await elm.sendCommand('0140', 8000);
          const b40 = extractPidPayload(r40, '0140');
          if (b40) {
            const dec40 = decodeSupportedBitmask(b40, 0x0140);
            dec40.supported.forEach((p) => supported.add(p));
          }
        }
      }
    }
    state.supportedPids = new Set(supported);
    state.supportedPidsComplete = Boolean(elm.initial0100Bytes);
    appendLog({ ts: new Date(), dir: 'SYS', text: `Supported-PID scan complete: ${supported.size} Mode 01 PIDs reported.` });
  } catch (err) {
    appendLog({ ts: new Date(), dir: 'SYS', text: `Supported-PID scan partial: ${err.message}` });
  }

  // VIN (Mode 09 02)
  try {
    const vinRaw = await elm.sendCommand('0902', 8000);
    const vinObj = parseVinResponse(vinRaw);
    if (vinObj) {
      state.vehicleInfo.vin = vinObj.vin;
      state.vehicleInfo.make = vinObj.make;
      state.vehicleInfo.year = vinObj.year;
      appendLog({ ts: new Date(), dir: 'SYS', text: `VIN: ${vinObj.vin} (${[vinObj.make, vinObj.year].filter(Boolean).join(' ') || 'Unknown make/year'})` });
      checkGarageVinMatch(vinObj.vin);
    } else {
      state.vehicleInfo.vin = null;
      appendLog({ ts: new Date(), dir: 'SYS', text: 'VIN (0902): NO DATA / not supported by adapter or ECU.' });
    }
  } catch {
    state.vehicleInfo.vin = null;
  }

  // Readiness & MIL (0101)
  try {
    const r01 = await elm.sendCommand('0101', 3000);
    const b01 = extractPidPayload(r01, '0101');
    const parsed01 = parseMode0101(b01);
    if (parsed01) {
      state.vehicleInfo.milOn = parsed01.milOn;
      state.vehicleInfo.dtcCount = parsed01.dtcCount;
      state.vehicleInfo.ignitionType = parsed01.ignitionType;
      state.vehicleInfo.monitors = parsed01.monitors;
    }
  } catch {}

  // Clear history PIDs (0121, 0130, 0131, 014D, 014E)
  const readSingleNum = async (pidHex) => {
    if (!supported.has(pidHex)) return null;
    try {
      const resp = await elm.sendCommand(pidHex, 3000);
      const bytes = extractPidPayload(resp, pidHex);
      const meta = state.pidMap.get(pidHex);
      return bytes && meta ? meta.decodeBytes(bytes) : null;
    } catch {
      return null;
    }
  };

  state.vehicleInfo.distanceWithMil = await readSingleNum('0121');
  state.vehicleInfo.warmupsSinceClear = await readSingleNum('0130');
  state.vehicleInfo.distanceSinceClear = await readSingleNum('0131');
  state.vehicleInfo.timeWithMil = await readSingleNum('014D');
  state.vehicleInfo.timeSinceClear = await readSingleNum('014E');

  await readAllDtcsOnElm(elm);
}

async function readAllDtcsOnElm(elm) {
  const dtcs = { stored: [], pending: [], permanent: [] };
  try {
    const r03 = await elm.sendCommand('03', 8000);
    dtcs.stored = parseDtcResponse(r03, '03');
  } catch {}
  try {
    const r07 = await elm.sendCommand('07', 8000);
    dtcs.pending = parseDtcResponse(r07, '07');
  } catch {}
  try {
    const r0A = await elm.sendCommand('0A', 8000);
    dtcs.permanent = parseDtcResponse(r0A, '0A');
  } catch {}

  handleDiscoveredDtcs(dtcs);
  if (state.activeView === 'dtcs') renderDtcsView();
}

function isMode04Success(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  if (hasObdError(text)) return false;
  const compact = text.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  // Reject ISO-15765 Negative Response to Service 04 (e.g. 7F 04 22 Conditions Not Correct while engine running)
  if (compact.includes('7F04')) return false;
  const upper = text.toUpperCase();
  if (upper.includes('?') || upper.includes('STOPPED')) return false;
  // Accept standard Mode 04 positive response (44) or OK / clean non-error reply
  return compact.includes('44') || upper.includes('OK') || compact.length > 0;
}

async function executeClearDtcs() {
  if (state.clearingDtcs) return;

  if (state.mode === 'sim') {
    if (state.simulator?.clearDtcs) {
      state.simulator.clearDtcs();
    }
    state.vehicleInfo.dtcs.stored = [];
    state.vehicleInfo.dtcs.pending = [];
    // Keep permanent (Mode 0A) codes intact
    state.vehicleInfo.milOn = false;
    state.vehicleInfo.dtcCount = 0;
    state.vehicleInfo.monitors = (state.vehicleInfo.monitors || []).map((m) => ({
      ...m,
      ready: false,
    }));
    state.vehicleInfo.distanceWithMil = 0;
    state.vehicleInfo.distanceSinceClear = 0;
    state.vehicleInfo.warmupsSinceClear = 0;
    state.vehicleInfo.timeWithMil = 0;
    state.vehicleInfo.timeSinceClear = 0;
    appendLog({ ts: new Date(), dir: 'SYS', text: 'Simulated Mode 04 DTC clear' });
    renderDtcsView();
    showToast('Simulated trouble codes cleared', 'ok');
    return;
  }

  if (state.mode !== 'real' || !state.elm?.connected) {
    showToast('Connect to a vehicle or start the simulator first.', 'warn');
    return;
  }

  const elm = state.elm;
  const clearBtn = $('clear-dtcs-btn');
  const wasPolling = state.pollActive;
  state.clearingDtcs = true;
  if (clearBtn) clearBtn.disabled = true;

  try {
    // Pause live PID polling loop and allow any in-flight poll command to finish
    state.pollActive = false;
    setStatus('Clearing trouble codes (Mode 04)…', 'working');
    await sleep(350);

    if (state.elm !== elm || !elm.connected || elm.portDead || elm.detached) {
      showToast('Adapter disconnected before clearing codes.', 'err');
      return;
    }

    await elm.ensureHeader('7DF');
    const resp = await elm.sendCommand('04', 8000);
    const cleanedResp = String(resp || '').replace(/[\r\n>]+/g, ' ').trim();

    if (!isMode04Success(resp)) {
      appendLog({
        ts: new Date(),
        dir: 'SYS',
        text: `Mode 04 clear rejected or failed (reply: "${cleanedResp || 'empty'}")`,
      });
      showToast('Could not clear codes — turn the engine OFF (Key ON, Engine OFF) and try again.', 'err');
      return;
    }

    appendLog({
      ts: new Date(),
      dir: 'SYS',
      text: `Mode 04 DTC clear sent successfully (reply: "${cleanedResp || 'OK'}")`,
    });

    // Re-read Mode 0101 (MIL & readiness)
    try {
      const r01 = await elm.sendCommand('0101', 3000);
      const b01 = extractPidPayload(r01, '0101');
      const parsed01 = parseMode0101(b01);
      if (parsed01) {
        state.vehicleInfo.milOn = parsed01.milOn;
        state.vehicleInfo.dtcCount = parsed01.dtcCount;
        state.vehicleInfo.ignitionType = parsed01.ignitionType;
        state.vehicleInfo.monitors = parsed01.monitors;
      }
    } catch {}

    // Re-read clear-history counters (0121, 0130, 0131)
    const readPostClearNum = async (pidHex) => {
      if (state.supportedPids && !state.supportedPids.has(pidHex)) return null;
      try {
        const r = await elm.sendCommand(pidHex, 3000);
        const bytes = extractPidPayload(r, pidHex);
        const meta = state.pidMap.get(pidHex);
        return bytes && meta ? meta.decodeBytes(bytes) : null;
      } catch {
        return null;
      }
    };

    const distMil = await readPostClearNum('0121');
    const warmClear = await readPostClearNum('0130');
    const distClear = await readPostClearNum('0131');
    if (distMil !== null) state.vehicleInfo.distanceWithMil = distMil;
    if (warmClear !== null) state.vehicleInfo.warmupsSinceClear = warmClear;
    if (distClear !== null) state.vehicleInfo.distanceSinceClear = distClear;

    // Re-read Stored (03), Pending (07), and Permanent (0A) DTCs
    await readAllDtcsOnElm(elm);
    renderDtcsView();
    showToast('Trouble codes cleared (Mode 04) — readiness monitors reset', 'ok');
  } catch (err) {
    appendLog({
      ts: new Date(),
      dir: 'SYS',
      text: `Mode 04 clear error: ${err?.message || err}`,
    });
    showToast('Could not clear codes — turn the engine OFF (Key ON, Engine OFF) and try again.', 'err');
  } finally {
    state.clearingDtcs = false;
    if (clearBtn) clearBtn.disabled = false;
    if (wasPolling && state.mode === 'real' && state.elm === elm && elm.connected && !elm.portDead && !elm.detached && !state.pollActive) {
      runRealPollingLoop(elm);
    }
  }
}

function openClearDtcsModal() {
  if (state.mode !== 'real' && state.mode !== 'sim') {
    showToast('Connect to a vehicle or start the simulator first.', 'warn');
    return;
  }
  openModal(
    'Clear Trouble Codes (Mode 04)?',
    `<ul style="margin:0;padding-left:18px;display:grid;gap:8px;">
       <li>Sending Mode <code>04</code> turns off the Check Engine Light (MIL) and erases <strong>Stored (Mode 03)</strong> and <strong>Pending (Mode 07)</strong> trouble codes, freeze-frame data, and learned fuel trims.</li>
       <li>It resets all <strong>Emissions Readiness Monitors</strong> to <em>Incomplete</em> (which will fail an emissions/smog check until driven through complete drive cycles).</li>
       <li>It does <strong>not</strong> clear <strong>Permanent (Mode 0A)</strong> codes — the ECU only clears those automatically after the repair is verified over completed drive cycles.</li>
       <li><strong>Safety note:</strong> Only clear codes with the <strong>Key ON, Engine OFF</strong> (parked safely).</li>
     </ul>
     <div class="inline-actions" style="margin-top:6px;">
       <button id="confirm-clear-dtcs-btn" class="btn btn-danger" type="button">Confirm: Clear Codes (Mode 04)</button>
       <button id="cancel-clear-dtcs-btn" class="btn btn-subtle" type="button">Cancel</button>
     </div>`
  );

  $('confirm-clear-dtcs-btn')?.addEventListener('click', () => {
    closeModal();
    executeClearDtcs();
  });
  $('cancel-clear-dtcs-btn')?.addEventListener('click', closeModal);
}

async function runRealPollingLoop(elm) {
  state.pollActive = true;
  const pidNoDataStreak = new Map();
  const unsupportedSkipped = new Set();
  let desyncCount = 0;
  let zeroResponseSince = null;
  let recoveryRetries = 0;
  let cycle = 0;
  let capabilityProbed = false;

  const resetZeroResponse = () => {
    zeroResponseSince = null;
    recoveryRetries = 0;
  };

  const handleFatalDisconnect = async () => {
    state.pollActive = false;
    setStatus('Adapter stopped responding — unplug and reconnect', 'error');
    showToast('Adapter stopped responding — unplug and reconnect.', 'err');
    await elm.disconnect();
    state.mode = 'idle';
    state.pidCap = 10;
    state.slowAdapterTrimmed = false;
    updateWakeLock(false);
    renderDashboard();
  };

  while (state.pollActive && elm.connected) {
    const cycleStart = performance.now();
    const dashPids = getEffectiveDashboardPids();

    // Expand dependencies for calculated PIDs
    const pollSet = new Set();
    for (const id of dashPids) {
      const meta = state.pidMap.get(id);
      if (!meta) continue;
      if (meta.isCalculated && Array.isArray(meta.dependencies)) {
        meta.dependencies.forEach((d) => pollSet.add(d));
      } else {
        pollSet.add(id);
      }
    }

    const cycleValues = {};
    for (const pidId of pollSet) {
      if (!state.pollActive || !elm.connected) break;

      // Skipped PIDs (3+ consecutive NO DATAs) are deferred to every 20th cycle so their
      // timeouts/late replies cannot stall the bus or get misattributed to the next polled PID.
      const noDataCount = pidNoDataStreak.get(pidId) || 0;
      if (noDataCount >= 3 && cycle % 20 !== 0) {
        continue;
      }

      const meta = state.pidMap.get(pidId);
      if (!meta) continue;

      // Once 0100/0120/0140 bitmask scan has completed, skip non-core standard Mode 01 PIDs
      // confirmed absent from state.supportedPids so they don't waste 3 NO DATA retry cycles.
      const isCorePid = pidId === '010C' || pidId === '010D' || pidId === '0105';
      if (
        !meta.isCustom &&
        !meta.isCalculated &&
        !isCorePid &&
        state.supportedPidsComplete &&
        state.supportedPids &&
        !state.supportedPids.has(pidId)
      ) {
        if (!unsupportedSkipped.has(pidId)) {
          unsupportedSkipped.add(pidId);
          appendLog({
            ts: new Date(),
            dir: 'SYS',
            text: `Skipping ${meta.shortName} (${pidId}) — not reported in ECU supported-PID bitmask.`,
          });
        }
        continue;
      }

      const reqHex = meta.isCustom ? meta.request : meta.pidHex;
      const targetHeader = meta.isCustom && meta.header ? meta.header : '7DF';
      let noDataRetried = false;

      // Guard against stale/partial rxBuffer bytes left behind when advancing from a skipped/timed-out PID
      if (elm.rxBuffer && elm.rxBuffer.trim().length > 0) {
        appendLog({
          ts: new Date(),
          dir: 'SYS',
          text: `WARN: Clearing leftover rxBuffer before ${reqHex}: "${elm.rxBuffer.trim()}"`,
        });
        elm.rxBuffer = '';
      }

      // Resend same PID on PID-echo mismatch (desync) or single 200ms NO DATA retry
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!state.pollActive || !elm.connected) break;
        const elapsedSec = state.records.length > 0 ? (Date.now() - state.records[0].ts) / 1000 : 0;

        try {
          await elm.ensureHeader(targetHeader);
          const resp = await elm.sendCommand(reqHex, 3000);
          resetZeroResponse();

          const reply = inspectObdReply(resp, reqHex);

          if (reply.status === 'ok') {
            const val = meta.decodeBytes(reply.bytes);
            if (val !== null && Number.isFinite(val)) {
              cycleValues[pidId] = val;
              pidNoDataStreak.set(pidId, 0);
            }
            state.pidHealthTracker.record({ pid: pidId, status: 'ok', value: val, elapsedSec });
            break;
          }

          if (reply.status === 'desync') {
            state.pidHealthTracker.record({ pid: pidId, status: 'desync', elapsedSec });
            // PID echo mismatch: flush CR x3 / drain, adapt rate (200ms -> 300ms), resend same PID, never count as failure
            desyncCount++;
            const newDelay = elm.slowDownPolling(desyncCount);
            appendLog({
              ts: new Date(),
              dir: 'SYS',
              text: `DESYNC #${desyncCount}: sent ${reqHex}, got ${reply.receivedReply} (expected ${reply.expectedReply}) — flushing buffer, delay ${newDelay} ms, resending ${reqHex}`,
            });
            setStatus(`PID echo mismatch — flushed buffer (${newDelay} ms gap), resending ${reqHex}…`, 'warn');

            const resynced = await elm.resyncBuffer();
            if (!resynced) {
              if (zeroResponseSince === null) zeroResponseSince = Date.now();
              recoveryRetries++;
              const silentForMs = Date.now() - Math.min(zeroResponseSince, elm.lastRxTime || zeroResponseSince);
              if (recoveryRetries >= 2 && Date.now() - zeroResponseSince >= 6000 && silentForMs >= 6000) {
                await handleFatalDisconnect();
                return;
              }
            } else {
              resetZeroResponse();
            }
            continue;
          }

          // NO DATA / invalid empty reply: wait 200 ms, retry same PID once; require 3 consecutive NO DATAs before reporting error
          if (!noDataRetried) {
            noDataRetried = true;
            appendLog({
              ts: new Date(),
              dir: 'SYS',
              text: `NO DATA on ${reqHex} — waiting 200 ms and retrying once…`,
            });
            await sleep(200);
            continue;
          }

          state.pidHealthTracker.record({ pid: pidId, status: 'no_data', elapsedSec });
          const nextStreak = (pidNoDataStreak.get(pidId) || 0) + 1;
          pidNoDataStreak.set(pidId, nextStreak);
          if (nextStreak === 3) {
            const msg = `${meta.shortName} (${reqHex}) returned NO DATA 3 consecutive times — backing off`;
            appendLog({ ts: new Date(), dir: 'SYS', text: `ERROR: ${msg}` });
            showToast(msg, 'warn');
          }
          break;
        } catch (err) {
          // Classify error strictly: OS_SERIAL is fatal to port (do NOT retry resync); PROTOCOL recovers via resync
          const category = classifyElmError(err, elm._getTransportSnapshot?.());
          if (category === ERROR_CATEGORY.OS_SERIAL || elm.portDead || elm.detached) {
            const detail = formatOsErrorDetail(err, elm._getTransportSnapshot?.());
            appendLog({
              ts: new Date(),
              dir: 'SYS',
              text: `OS/SERIAL error during ${reqHex}: ${detail} — aborting poll loop (no resync on dead port)`,
            });
            state.pollActive = false;
            if (!elm.portDead) {
              elm._handleFatalTransportFailure(err, { source: 'pollLoopCatch' });
            }
            return;
          }

          // PROTOCOL error (timeout): auto-recover unless 6 full seconds of zero response after retries
          state.pidHealthTracker.record({ pid: pidId, status: 'timeout', elapsedSec });
          if (zeroResponseSince === null) zeroResponseSince = Date.now();
          recoveryRetries++;
          appendLog({
            ts: new Date(),
            dir: 'SYS',
            text: `PROTOCOL timeout on ${reqHex} (${err.message}) — flushing buffer & auto-recovering (retry #${recoveryRetries})…`,
          });
          setStatus('Adapter lag — auto-recovering…', 'warn');

          if (elm.consecutiveOsErrors >= 2 || elm.portDead || elm.detached) {
            return;
          }

          const resynced = await elm.resyncBuffer();
          if (resynced) {
            resetZeroResponse();
            continue;
          }

          if (elm.portDead || elm.detached || elm.consecutiveOsErrors >= 2) {
            return;
          }

          const silentFromStart = Date.now() - zeroResponseSince;
          const silentFromLastRx = Date.now() - (elm.lastRxTime || zeroResponseSince);
          if (recoveryRetries >= 2 && silentFromStart >= 6000 && silentFromLastRx >= 6000) {
            await handleFatalDisconnect();
            return;
          }
          await sleep(250);
        }
      }
    }

    // Restore default functional header if a custom header was used
    if (elm.currentHeader !== '7DF') {
      try {
        await elm.ensureHeader('7DF');
      } catch {}
    }

    if (!state.pollActive) break;

    // Capture mode and lean <=5-PID profiles run with minCycleMs=0 for maximum capture rate;
    // 6-PID clone profiles pace to <=1 Hz unless Capture mode overrides.
    const minCycleMs = (state.captureMode || dashPids.length <= 5)
      ? 0
      : (elm.adapterProfile?.minCycleIntervalMs || 0);
    const elapsedSoFar = performance.now() - cycleStart;
    if (minCycleMs > elapsedSoFar) {
      await sleep(minCycleMs - elapsedSoFar);
    }

    if (!state.pollActive) break;

    cycle++;
    const cycleMs = Math.max(50, performance.now() - cycleStart);
    const hz = 1000 / cycleMs;
    state.samplingRateHz = hz;

    recordCycleSample(cycleValues, false);
    const gapTag = `${elm.interCommandDelayMs}ms gap`;
    setStatus(
      `✓ Live data flowing (${hz.toFixed(1)} Hz)`,
      'ok',
      elm.isFastAdapter ? `fast adapter · ${gapTag}` : gapTag
    );

    // Capability probe after first full poll cycle
    if (!capabilityProbed) {
      capabilityProbed = true;
      if (hz < 0.5 && dashPids.length > 6) {
        state.pidCap = 6;
        const { kept } = enforcePidCapWithWarning(dashPids, 'Slow adapter probe (<0.5 Hz)', true);
        state.dashboardPids = kept;
        state.chartPids = state.chartPids.filter((id) => state.dashboardPids.includes(id));
        persistProfileAndLayout();
        renderDashboard();
      }
    }
  }
}

// Simulator Mode (Requirement 22)
async function startSimulator() {
  await disconnectSession();
  newSession();
  const scenarioId = $('sim-scenario-select').value;
  const sim = new VehicleSimulator(scenarioId);
  state.simulator = sim;
  // Set state.mode = 'sim' BEFORE any UI render (applyPreset, renderDashboard, renderVehicleProfile)
  // so isLive=true and simulated banners/gauges render coherently on the very first pass.
  state.mode = 'sim';
  state.isSimulatedSession = true;
  state.slowAdapterTrimmed = false;
  state.lastTrimmedWarning = '';
  state.pidCap = 10;

  const info = sim.getInfo();
  state.vehicleInfo = info;
  state.supportedPids = new Set(sim.getSupportedPids());
  state.supportedPidsComplete = true;

  // Apply matching vehicle profile for scenario
  state.profile.mfrId = sim.scenario.mfrId;
  state.profile.engineId = sim.scenario.engineId;
  state.profile.transId = sim.scenario.transId;
  persistProfileAndLayout();

  appendLog({ ts: new Date(), dir: 'SYS', text: `Started Simulator: ${sim.scenario.name}` });
  setStatus('✓ Live data flowing (2.0 Hz)', 'ok', 'SIMULATED');

  if (state.captureMode) {
    applyCaptureModeLayout();
  } else if (sim.scenario.recommendedProfileId) {
    applyPreset(sim.scenario.recommendedProfileId, { silent: true });
    appendLog({ ts: new Date(), dir: 'SYS', text: `Scenario auto-loaded diagnostic profile: ${getActiveProfile()?.name || sim.scenario.recommendedProfileId}` });
  }
  handleDiscoveredDtcs(info.dtcs);

  const firstSample = sim.sample();
  recordCycleSample(firstSample, true);
  await updateWakeLock(true);

  state.samplingRateHz = 2.0;
  state.simTimer = setInterval(() => {
    if (state.mode !== 'sim') return;
    recordCycleSample(sim.sample(), true);
  }, 500);

  renderDashboard();
  renderVehicleProfile();
}

async function disconnectSession() {
  state.pollActive = false;
  state.reconnecting = false;
  state.deferredScanPending = null;
  state.dongleReminderUntil = 0;
  state.disconnectedNotice = '';
  state.supportedPidsComplete = false;
  if (state.simTimer) {
    clearInterval(state.simTimer);
    state.simTimer = null;
  }
  const activeElm = state.elm;
  state.elm = null;
  if (activeElm) {
    await activeElm.disconnect();
  }
  state.mode = 'idle';
  setConnectingUi(false);
  state.pidCap = 10;
  state.slowAdapterTrimmed = false;
  state.lastTrimmedWarning = '';
  if ($('term-ati')) $('term-ati').textContent = '—';
  if ($('term-atrv')) $('term-atrv').textContent = '—';
  if ($('term-atdpn')) $('term-atdpn').textContent = '—';
  if ($('term-state')) $('term-state').textContent = 'Disconnected';
  await updateWakeLock(false);
  setStatus('Key ON (KOEO) — pick Scan Target or arm cold-start capture, then connect', 'info');
  renderDashboard();
}

// Wire up UI events
function bindEvents() {
  // Navigation & Drawer
  $('menu-toggle-btn').addEventListener('click', openDrawer);
  $('drawer-close-btn').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.querySelectorAll('#drawer-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Contextual "Guide ?" buttons across all views + Field Guide back/filter controls
  document.querySelectorAll('.guide-help-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      openGuideChapter(btn.dataset.guideChapter);
    });
  });
  $('guide-back-btn')?.addEventListener('click', () => {
    const dest = state.previousView && state.previousView !== 'guide' ? state.previousView : 'dashboard';
    switchView(dest);
  });
  $('guide-search-input')?.addEventListener('input', (e) => {
    state.guideFilterText = e.target.value;
    renderGuideView();
  });
  $('guide-search-clear-btn')?.addEventListener('click', () => {
    state.guideFilterText = '';
    const inp = $('guide-search-input');
    if (inp) inp.value = '';
    renderGuideView();
  });

  // Connect & Disconnect
  $('connect-ble-btn').addEventListener('click', () => startRealConnection('ble'));
  $('connect-serial-btn').addEventListener('click', () => startRealConnection('serial'));
  $('retry-ecu-handshake-btn')?.addEventListener('click', retryEcuHandshake);
  $('start-sim-btn').addEventListener('click', startSimulator);
  $('topbar-disconnect-btn').addEventListener('click', disconnectSession);

  // Pre-start & Live Scan Target selectors
  $('start-scan-target-select')?.addEventListener('change', (e) => {
    handleScanTargetSelectChange(e.target.value);
  });
  $('live-scan-target-select')?.addEventListener('change', (e) => {
    handleScanTargetSelectChange(e.target.value);
  });

  // Cold-start / creep capture mode controls (accessible from Start Here & Live Toolbar)
  $('start-capture-toggle-btn')?.addEventListener('click', () => toggleCaptureMode());
  $('dash-capture-toggle-btn')?.addEventListener('click', () => toggleCaptureMode());
  $('start-new-capture-btn')?.addEventListener('click', startNewCapture);
  $('dash-new-capture-btn')?.addEventListener('click', startNewCapture);

  const handleCoolantToggle = (checked) => {
    state.captureIncludeCoolant = Boolean(checked);
    syncCaptureControlsUi();
    if (state.captureMode) {
      applyCaptureModeLayout();
      renderDashboard();
    }
  };
  $('start-capture-coolant-toggle')?.addEventListener('change', (e) => handleCoolantToggle(e.target.checked));
  $('dash-capture-coolant-toggle')?.addEventListener('change', (e) => handleCoolantToggle(e.target.checked));

  // Quick-tap symptom marker (capture / symptom modes) + Mark Moment form (Requirement 19)
  $('quick-mark-symptom-btn')?.addEventListener('click', () => {
    const activeProfile = getActiveProfile();
    const label = activeProfile?.isCvtProfile ? 'CVT shudder / symptom' : 'Shudder / symptom';
    markMomentLabel(label);
  });

  $('mark-moment-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('mark-moment-input');
    const text = input.value.trim() || (state.captureMode ? 'Shudder / marked moment' : '');
    if (!text) return;
    markMomentLabel(text);
    input.value = '';
  });

  $('drive-script-toggle-btn').addEventListener('click', () => {
    state.driveScriptCollapsed = !state.driveScriptCollapsed;
    renderDriveScriptCard();
  });

  $('clear-chart-btn').addEventListener('click', () => {
    state.chartPids = [];
    persistProfileAndLayout();
    renderDashboard();
  });

  // Quick Export & AI Prompt on Dashboard + Export View
  const doCsvDownload = (aiSized = false) => {
    const payload = getExportPayload();
    if (payload.records.length === 0) {
      showToast('No samples recorded yet.', 'warn');
      return;
    }
    const csv = buildCsvContent({ ...payload, aiSized });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const tag = aiSized ? 'ai-sized-' : '';
    a.download = `bayscope-${tag}${payload.isSimulatedSession ? 'SIMULATED-' : ''}${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(aiSized ? 'AI-sized CSV (1–2 Hz, capped) exported' : 'Full CSV exported', 'ok');
  };

  const doCopyAiPrompt = () => {
    const promptText = buildAiPrompt(getExportPayload());
    copyText(promptText, 'AI diagnostic prompt copied to clipboard');
  };

  $('dash-csv-btn').addEventListener('click', () => doCsvDownload(false));
  $('export-csv-btn').addEventListener('click', () => doCsvDownload(false));
  $('export-ai-csv-btn').addEventListener('click', () => doCsvDownload(true));
  $('dash-ai-prompt-btn').addEventListener('click', doCopyAiPrompt);
  $('copy-ai-prompt-btn').addEventListener('click', doCopyAiPrompt);
  $('refresh-prompt-preview-btn').addEventListener('click', renderExportView);

  // Baseline Save / Clear
  $('dash-save-baseline-btn').addEventListener('click', saveCurrentAsBaseline);
  $('save-baseline-btn').addEventListener('click', saveCurrentAsBaseline);
  $('clear-baseline-btn').addEventListener('click', () => {
    const { key } = getCurrentVehicleBaseline();
    clearBaselineForVehicle(key);
    showToast('Cleared saved vehicle baseline', 'ok');
    renderDashboard();
    renderExportView();
  });

  // Scan Targets Category Filter & Custom Profile Form
  $('preset-category-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.presetCategoryFilter = btn.dataset.cat;
    renderPresets();
  });
  $('new-custom-profile-btn').addEventListener('click', () => openCustomProfileEditor(null));
  $('cprof-close-btn').addEventListener('click', () => $('custom-profile-panel').classList.add('hidden'));
  $('cprof-cancel-btn').addEventListener('click', () => $('custom-profile-panel').classList.add('hidden'));
  $('custom-profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const editId = $('cprof-edit-id').value;
    const name = $('cprof-name').value.trim();
    if (!name) return;
    const picked = Array.from(document.querySelectorAll('#cprof-pid-picker input[type="checkbox"]:checked')).map((el) => el.value);
    if (picked.length === 0) {
      showToast('Select at least 1 PID for this profile.', 'warn');
      return;
    }
    const scriptSteps = $('cprof-script').value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const profObj = {
      id: editId || `custom_${Date.now()}`,
      name,
      category: $('cprof-category').value,
      blurb: $('cprof-blurb').value.trim(),
      pids: picked,
      driveScript: scriptSteps,
      analysisPrompt: $('cprof-prompt').value.trim(),
      isCvtProfile: $('cprof-is-cvt').checked,
      isCustom: true,
    };
    const next = editId
      ? state.customProfiles.map((x) => (x.id === editId ? profObj : x))
      : [...state.customProfiles, profObj];
    state.customProfiles = saveCustomProfiles(next);
    $('custom-profile-panel').classList.add('hidden');
    renderPresets();
    syncScanTargetSelectors();
    showToast(`Saved diagnostic profile "${name}"`, 'ok');
  });

  // Variables View Filters
  $('var-search-input').addEventListener('input', (e) => {
    state.varFilterText = e.target.value;
    renderVariables();
  });
  $('var-category-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    document.querySelectorAll('#var-category-tabs .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.varCategory = btn.dataset.cat;
    renderVariables();
  });
  $('rescan-supported-btn').addEventListener('click', async () => {
    if (state.mode !== 'real' || !state.elm?.connected) {
      showToast('Connect to a real adapter first (or use Simulator).', 'warn');
      return;
    }
    const r00 = await state.elm.sendCommand('0100', 8000);
    const b00 = extractPidPayload(r00, '0100');
    if (b00) {
      const dec00 = decodeSupportedBitmask(b00, 0x0100);
      const set = new Set(dec00.supported);
      await runInitialVehicleScan(state.elm, dec00.hasNextBlock, set);
      renderVariables();
      showToast(`Rescan complete: ${state.supportedPids.size} PIDs reported`, 'ok');
    }
  });

  // Vehicle Profile & Garage
  $('profile-mfr').addEventListener('change', (e) => {
    state.profile.mfrId = e.target.value;
    const { mfr } = getEngineMeta(state.profile.mfrId, '');
    state.profile.engineId = mfr.engines[0].id;
    state.profile.transId = mfr.engines[0].transmissions[0];
    const layout = loadComboLayout(getComboKey(state.profile.mfrId, state.profile.engineId, state.profile.transId));
    if (layout?.pids?.length) state.dashboardPids = layout.pids.slice(0, state.pidCap);
    persistProfileAndLayout();
    renderVehicleProfile();
  });
  $('profile-engine').addEventListener('change', (e) => {
    state.profile.engineId = e.target.value;
    const { eng } = getEngineMeta(state.profile.mfrId, state.profile.engineId);
    state.profile.transId = eng.transmissions[0];
    const layout = loadComboLayout(getComboKey(state.profile.mfrId, state.profile.engineId, state.profile.transId));
    if (layout?.pids?.length) state.dashboardPids = layout.pids.slice(0, state.pidCap);
    persistProfileAndLayout();
    renderVehicleProfile();
  });
  $('profile-trans').addEventListener('change', (e) => {
    state.profile.transId = e.target.value;
    const layout = loadComboLayout(getComboKey(state.profile.mfrId, state.profile.engineId, state.profile.transId));
    if (layout?.pids?.length) state.dashboardPids = layout.pids.slice(0, state.pidCap);
    persistProfileAndLayout();
    renderVehicleProfile();
  });
  $('show-bank2-toggle').addEventListener('change', (e) => {
    state.profile.showBank2 = e.target.checked;
    persistProfileAndLayout();
    renderDashboard();
  });

  $('garage-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = $('garage-name-input').value.trim();
    const vin = $('garage-vin-input').value.trim().toUpperCase();
    if (!nickname) return;
    if (vin && vin.length !== 17) {
      showToast('VIN should be 17 characters (or leave blank).', 'warn');
      return;
    }
    const entry = {
      id: `car_${Date.now()}`,
      nickname,
      vin,
      mfrId: state.profile.mfrId,
      engineId: state.profile.engineId,
      transId: state.profile.transId,
      showBank2: state.profile.showBank2,
      layoutPids: [...state.dashboardPids],
    };
    state.garage.push(entry);
    saveGarage(state.garage);
    $('garage-name-input').value = '';
    renderVehicleProfile();
    showToast(`Saved "${nickname}" to garage`, 'ok');
  });

  // Read & Clear DTCs buttons
  $('read-dtcs-btn').addEventListener('click', async () => {
    if (state.mode === 'sim' && state.simulator) {
      const simInfo = state.simulator.getInfo();
      state.vehicleInfo = simInfo;
      handleDiscoveredDtcs(simInfo.dtcs);
      renderDtcsView();
      showToast('Read simulator trouble codes', 'ok');
      return;
    }
    if (state.mode !== 'real' || !state.elm?.connected) {
      showToast('Connect to an adapter or start simulator first.', 'warn');
      return;
    }
    await readAllDtcsOnElm(state.elm);
    showToast('Trouble code & readiness scan complete', 'ok');
  });

  $('clear-dtcs-btn')?.addEventListener('click', openClearDtcsModal);

  // Custom PIDs Form
  $('cpid-formula').addEventListener('input', validateCustomFormulaInput);
  $('cpid-cancel-btn').addEventListener('click', () => {
    $('custom-pid-form').reset();
    $('cpid-edit-id').value = '';
    $('cpid-cancel-btn').classList.add('hidden');
    validateCustomFormulaInput();
  });

  $('custom-pid-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validateCustomFormulaInput()) {
      showToast('Fix formula syntax error before saving.', 'err');
      return;
    }
    const req = $('cpid-request').value.replace(/\s+/g, '').toUpperCase();
    const header = $('cpid-header').value.replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{4,8}$/.test(req)) {
      showToast('Hex request must be 4–8 hex characters (e.g. 2101 or 22F405).', 'err');
      return;
    }
    // Requirement 18: Non-standard requests (not 01xx) require a 3-hex-digit header
    if (!req.startsWith('01') && !/^[0-9A-F]{3}$/.test(header)) {
      showToast('Non-standard requests (not 01xx) require a 3-hex-digit CAN header (e.g. 7E0 or 7E1).', 'err');
      return;
    }

    const editId = $('cpid-edit-id').value;
    const rawList = state.customPids.map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      unit: c.unit,
      tag: c.tag,
      header: c.header,
      request: c.request,
      formula: c.formula,
      min: c.min,
      max: c.max,
      decimals: c.decimals,
      unverified: c.unverified,
      tooltip: c.tooltip,
    }));

    const item = {
      id: editId || `CUSTOM_${Date.now()}`,
      name: $('cpid-name').value.trim(),
      shortName: $('cpid-short').value.trim(),
      unit: $('cpid-unit').value.trim(),
      tag: $('cpid-tag').value,
      header: header || '7DF',
      request: req,
      formula: $('cpid-formula').value.trim(),
      min: Number($('cpid-min').value),
      max: Number($('cpid-max').value),
      decimals: 1,
      unverified: true,
      tooltip: 'Custom user-defined PID — confirm scaling and header on your vehicle.',
    };

    const next = editId ? rawList.map((x) => (x.id === editId ? item : x)) : [...rawList, item];
    state.customPids = saveCustomPids(next);
    rebuildPidMap();
    $('custom-pid-form').reset();
    $('cpid-edit-id').value = '';
    $('cpid-cancel-btn').classList.add('hidden');
    validateCustomFormulaInput();
    renderCustomPids();
    showToast('Custom PID saved', 'ok');
  });

  // Terminal Log & Raw Command (Requirement 23) — works in both live 'real' and 'adapter_only' modes
  const sendTerminalRawCommand = async (rawCmd) => {
    const cmd = String(rawCmd || '').trim();
    if (!cmd) return;
    const canSend = (state.mode === 'real' || state.mode === 'adapter_only') && state.elm;
    if (!canSend) {
      appendLog({ ts: new Date(), dir: 'SYS', text: `Cannot send "${cmd}" — connect a real ELM327 adapter first.` });
      showToast('Connect a real ELM327 adapter first.', 'warn');
      return;
    }
    try {
      const reply = await state.elm.sendCommand(cmd, 8000);
      const upper = cmd.replace(/\s+/g, '').toUpperCase();
      if (upper === 'ATRV' && reply) {
        const cleanV = reply.replace(/[\r\n>]/g, ' ').trim();
        state.elm.batteryVoltage = cleanV;
        if ($('term-atrv')) $('term-atrv').textContent = cleanV || '—';
      } else if ((upper === 'ATDPN' || upper === 'ATDP') && reply) {
        const cleanP = reply.replace(/[\r\n>]/g, ' ').trim();
        if (upper === 'ATDPN') state.elm.protocolNumber = cleanP;
        if ($('term-atdpn')) $('term-atdpn').textContent = cleanP || '—';
      }
    } catch (err) {
      appendLog({ ts: new Date(), dir: 'SYS', text: `Error: ${err.message}` });
    }
  };

  $('raw-cmd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('raw-cmd-input');
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    await sendTerminalRawCommand(cmd);
  });

  $('terminal-quick-cmds')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.quick-cmd-btn');
    if (!btn || !btn.dataset.cmd) return;
    await sendTerminalRawCommand(btn.dataset.cmd);
  });

  $('clear-log-btn').addEventListener('click', () => {
    state.logs = [];
    $('terminal-log-box').innerHTML = '';
  });

  $('copy-report-btn').addEventListener('click', () => {
    const header = [
      '=== BayScope Connection Report ===',
      `Timestamp: ${new Date().toISOString()}`,
      `State: ${$('status-text').textContent}`,
      `Adapter Identity (ATI): ${state.elm?.adapterIdentity || 'N/A'}`,
      `OBD-II Port Voltage (ATRV): ${state.elm?.batteryVoltage || 'N/A'}`,
      `Protocol Number (ATDPN): ${state.elm?.protocolNumber || 'N/A'}`,
      '=== Log ===',
    ].join('\n');
    const body = state.logs
      .map((l) => `${l.ts.toISOString()} [${l.dir}] ${l.text}`)
      .join('\n');
    copyText(`${header}\n${body}`, 'Terminal connection report copied');
  });

  // Export View Controls
  $('purpose-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.settings.sessionPurpose = btn.dataset.purpose;
    persistSettings();
    renderExportView();
  });
  $('session-notes-input').addEventListener('input', (e) => {
    state.settings.userNotes = e.target.value;
    persistSettings();
  });

  // Settings
  $('units-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.settings.useImperial = btn.dataset.units === 'imperial';
    persistSettings();
    document.querySelectorAll('#units-selector .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.units === (state.settings.useImperial ? 'imperial' : 'metric'));
    });
    renderDashboard();
  });
  $('wakelock-toggle').addEventListener('change', (e) => {
    state.settings.wakeLockEnabled = e.target.checked;
    persistSettings();
    updateWakeLock(state.mode !== 'idle' && state.settings.wakeLockEnabled);
  });
  $('tx-delay-input').addEventListener('change', (e) => {
    const val = Math.max(100, Math.min(1000, Math.round(Number(e.target.value) || 150)));
    e.target.value = String(val);
    state.settings.txDelayMs = val;
    persistSettings();
    if (state.elm && !state.elm.isFastAdapter) {
      state.elm.setInterCommandDelay(val);
      renderDashboard();
    }
    showToast(`ELM327 TX delay set to ${val} ms`, 'ok');
  });
  $('clear-session-btn').addEventListener('click', () => {
    newSession();
    renderDashboard();
    showToast('Session samples cleared', 'ok');
  });

  // Modal Close
  $('modal-close-btn').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });

  // Offline / Online Banner
  const syncOnline = () => {
    $('offline-banner').classList.toggle('hidden', navigator.onLine);
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  // Re-acquire browser Wake Lock when returning to foreground during live logging
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.mode !== 'idle' && state.settings.wakeLockEnabled) {
      updateWakeLock(true);
    }
  });

  // Optional Android WebView native bridge detach broadcasts (ACTION_USB_DEVICE_DETACHED / ACTION_ACL_DISCONNECTED)
  window.addEventListener('bayscope:usb-detached', () => {
    if (state.elm) {
      state.elm._handleFatalTransportFailure(
        new Error('Android UsbManager.ACTION_USB_DEVICE_DETACHED broadcast'),
        { isDetachEvent: true, source: 'android.usbDetached' }
      );
    }
  });
  window.addEventListener('bayscope:acl-disconnected', () => {
    if (state.elm) {
      state.elm._handleFatalTransportFailure(
        new Error('Android BluetoothDevice.ACTION_ACL_DISCONNECTED broadcast'),
        { isDetachEvent: true, source: 'android.aclDisconnected' }
      );
    }
  });

  // PWA Install Prompt
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (!isStandalone) $('pwa-install-btn').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    $('pwa-install-btn').classList.add('hidden');
    showToast('BayScope installed to home screen', 'ok');
  });

  const handleInstallClick = async () => {
    if (state.deferredInstallPrompt) {
      await state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      $('pwa-install-btn').classList.add('hidden');
      return;
    }
    if (isIOS) {
      openModal(
        'Install on iPhone / iPad',
        '<p>1. Tap the <strong>Share</strong> button in Safari.</p><p>2. Scroll down and tap <strong>Add to Home Screen</strong>.</p><p class="muted-meta">Note: iOS Safari does not support Web Bluetooth or Web Serial, so iPhone works in Simulator / log-viewing mode only.</p>'
      );
    } else {
      openModal(
        'Install BayScope PWA',
        '<p>Open this page over HTTPS in Chrome or Edge, then tap the browser menu (⋮) → <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>'
      );
    }
  };
  $('pwa-install-btn').addEventListener('click', handleInstallClick);
  $('settings-install-btn').addEventListener('click', handleInstallClick);

  // Floating Ask AI button & AI View Controls
  $('floating-ask-ai-btn').addEventListener('click', () => switchView('ai'));
  $('ai-go-settings-btn').addEventListener('click', () => {
    switchView('settings');
    setTimeout(() => {
      $('ai-settings-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  });

  $('ai-privacy-ack-btn').addEventListener('click', () => {
    setPrivacyAck();
    state.aiConfig.privacyAck = true;
    renderAiChatView();
  });

  $('ai-clear-chat-btn').addEventListener('click', () => {
    if (state.aiStreaming && state.aiAbortController) {
      state.aiAbortController.abort();
    }
    state.aiMessages = [];
    state.aiPendingAttachment = null;
    renderAiChatView();
  });

  $('ai-stop-btn').addEventListener('click', () => {
    if (state.aiAbortController) {
      state.aiAbortController.abort();
    }
  });

  $('ai-attach-summary-btn').addEventListener('click', () => {
    const payload = getExportPayload();
    const diag = buildAiDiagnosticPayload({
      records: payload.records,
      recordedPidIds: payload.recordedPidIds,
      pidMap: state.pidMap,
      headerLines: [state.pidHealthTracker.toCsvHeaderLine(state.pidMap)],
    });
    state.aiPendingAttachment = {
      type: 'summary',
      label: `Full log summary + ${diag.eventWindows.length} event window(s) attached`,
      text: `\n\n[Attached Diagnostic Summary & Event Windows]\n${diag.summaryText}`,
    };
    renderAiChatView();
    showToast('Log summary & marked event windows attached', 'ok');
  });

  $('ai-attach-csv-btn').addEventListener('click', () => {
    const payload = getExportPayload();
    if (payload.records.length === 0) {
      showToast('No recorded samples to attach yet.', 'warn');
      return;
    }
    const aiRows = downsampleRecordsForAi(payload.records, { targetHz: 1.5, maxRows: 600 });
    const csv = buildCsvContent({ ...payload, aiSized: true });
    const kb = (new Blob([csv]).size / 1024).toFixed(1);
    openModal(
      'Send AI-sized CSV to AI?',
      `<p>This will attach an AI-sized CSV recording (downsampled to <strong>${aiRows.length} rows</strong> from ${payload.records.length} raw rows @ ~1.5 Hz, preserving all marked moments, <strong>~${kb} KB</strong>) to your next AI message.</p>
       <p>Timestamped rows, diagnostic profile, VIN metadata, and session notes will be sent directly from this browser to <strong>${AI_PROVIDERS[state.aiConfig.provider].label}</strong>.</p>
       <div class="inline-actions">
         <button id="confirm-attach-csv-btn" class="btn btn-primary" type="button">Confirm &amp; attach CSV</button>
         <button id="cancel-attach-csv-btn" class="btn btn-subtle" type="button">Cancel</button>
       </div>`
    );
    $('confirm-attach-csv-btn').addEventListener('click', () => {
      state.aiPendingAttachment = {
        type: 'csv',
        label: `AI-sized CSV attached (${aiRows.length}/${payload.records.length} rows, ~${kb} KB)`,
        text: `\n\n[Attached AI-Sized CSV]\n${csv}`,
      };
      closeModal();
      renderAiChatView();
      showToast('AI-sized CSV attached to next message', 'warn');
    });
    $('cancel-attach-csv-btn').addEventListener('click', closeModal);
  });

  document.querySelectorAll('.ai-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presetPrompts = {
        analyze: 'Analyze this log: highlight any red flags, rank likely causes with supporting or contradicting data, give the cheapest-first next diagnostic steps, tell me what to log next, and say whether it looks safe to keep driving.',
        buying: 'Give me a used-car pre-purchase assessment: overall risk level, physical/test-drive inspection checklist, specific questions for the seller, price negotiation points, and clear walk-away triggers.',
        codes: 'Explain all stored, pending, and permanent trouble codes in plain English, list likely causes on this specific engine/transmission profile, and explain how to test each cause.',
        next: 'Based on what is currently logged and missing, what additional PIDs and driving conditions (cold soak, warm idle, steady cruise, wide-open pull) should I log next to narrow the diagnosis?',
      };
      const prompt = presetPrompts[btn.dataset.preset];
      if (prompt) sendAiChatMessage(prompt);
    });
  });

  $('ai-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('ai-chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (sendAiChatMessage(text)) {
      input.value = '';
    }
  });

  // Settings > AI Assistant BYOK Controls
  $('ai-provider-select').addEventListener('change', (e) => {
    const prov = e.target.value;
    const saved = saveAiProviderAndModel(prov, AI_PROVIDERS[prov].defaultModel);
    state.aiConfig.provider = saved.provider;
    state.aiConfig.model = saved.model;
    $('ai-test-result').textContent = '';
    renderAiSettings();
    renderAiChatView();
  });

  $('ai-model-select').addEventListener('change', (e) => {
    const saved = saveAiProviderAndModel(state.aiConfig.provider, e.target.value);
    state.aiConfig.model = saved.model;
    $('ai-test-result').textContent = '';
    renderAiChatView();
  });

  const persistActiveKeyFromInput = ({ showFeedback = false } = {}) => {
    const prov = state.aiConfig.provider;
    const val = $('ai-api-key-input').value.trim();
    saveAiKey(prov, val);
    state.aiConfig.keys[prov] = val;
    if (val && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }
    renderAiSettings();
    renderAiChatView();
    if (showFeedback) {
      if (val) {
        showToast(`Saved ${AI_PROVIDERS[prov].label} API key in this browser`, 'ok');
      } else {
        showToast(`Cleared empty ${AI_PROVIDERS[prov].label} API key`, 'warn');
      }
    }
  };

  $('ai-api-key-input').addEventListener('input', () => persistActiveKeyFromInput({ showFeedback: false }));
  $('ai-api-key-input').addEventListener('change', () => persistActiveKeyFromInput({ showFeedback: false }));
  $('ai-save-key-btn')?.addEventListener('click', () => persistActiveKeyFromInput({ showFeedback: true }));

  $('ai-toggle-key-btn').addEventListener('click', () => {
    const inp = $('ai-api-key-input');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('ai-toggle-key-btn').textContent = show ? 'Hide' : 'Show';
  });

  $('ai-clear-key-btn').addEventListener('click', () => {
    const prov = state.aiConfig.provider;
    clearAiKey(prov);
    state.aiConfig.keys[prov] = '';
    $('ai-api-key-input').value = '';
    $('ai-test-result').textContent = '';
    renderAiSettings();
    renderAiChatView();
    showToast(`Cleared ${AI_PROVIDERS[prov].label} API key`, 'ok');
  });

  $('ai-clear-all-btn').addEventListener('click', () => {
    if (state.aiStreaming && state.aiAbortController) {
      state.aiAbortController.abort();
    }
    clearAllAiStorage();
    state.aiConfig = loadAiConfig();
    state.aiMessages = [];
    state.aiPendingAttachment = null;
    $('ai-test-result').textContent = '';
    renderAiSettings();
    renderAiChatView();
    showToast('Cleared all AI settings, keys, and chat state', 'ok');
  });

  $('ai-test-conn-btn').addEventListener('click', async () => {
    const prov = state.aiConfig.provider;
    const model = state.aiConfig.model;
    const inputVal = $('ai-api-key-input').value.trim();
    if (inputVal && inputVal !== state.aiConfig.keys[prov]) {
      saveAiKey(prov, inputVal);
      state.aiConfig.keys[prov] = inputVal;
      renderAiSettings();
      renderAiChatView();
    }
    const key = state.aiConfig.keys[prov];
    const hint = $('ai-test-result');

    if (!key) {
      hint.textContent = `Paste a ${AI_PROVIDERS[prov].label} API key first.`;
      hint.className = 'field-hint hint-err';
      return;
    }

    hint.textContent = 'Testing connection…';
    hint.className = 'field-hint';
    $('ai-test-conn-btn').disabled = true;
    try {
      const msg = await testAiConnection({ provider: prov, model, apiKey: key });
      hint.textContent = msg;
      hint.className = 'field-hint hint-ok';
    } catch (err) {
      hint.textContent = err.message;
      hint.className = 'field-hint hint-err';
    } finally {
      $('ai-test-conn-btn').disabled = false;
    }
  });
}

// Render AI Settings Panel
function renderAiSettings() {
  const { provider, model, keys } = state.aiConfig;
  const provMeta = AI_PROVIDERS[provider] || AI_PROVIDERS.anthropic;
  $('ai-provider-select').value = provMeta.id;
  $('ai-model-select').innerHTML = provMeta.models
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join('');
  $('ai-model-select').value = model;
  const provLabel =
    provider === 'gemini'
      ? 'Google Gemini'
      : provider === 'openrouter'
        ? 'OpenRouter'
        : 'Anthropic';
  $('ai-key-provider-label').textContent = provLabel;
  $('ai-api-key-input').placeholder =
    provider === 'openrouter' ? 'Paste your OpenRouter API key (sk-or-…)' : 'Paste your API key';
  const savedKey = keys[provider] || '';
  if ($('ai-api-key-input').value !== savedKey) {
    $('ai-api-key-input').value = savedKey;
  }
  const statusEl = $('ai-key-saved-status');
  if (statusEl) {
    if (savedKey) {
      const tail = savedKey.length >= 4 ? `…${savedKey.slice(-4)}` : 'saved';
      statusEl.textContent = `Saved in this browser ✓ (${tail})`;
      statusEl.className = 'field-hint hint-ok';
    } else {
      statusEl.textContent = `No ${provLabel} key saved in this browser yet.`;
      statusEl.className = 'field-hint';
    }
  }
}

// Render AI Chat View
function renderAiChatView() {
  const { provider, model, keys, privacyAck } = state.aiConfig;
  const hasKey = Boolean(keys[provider]);

  $('ai-privacy-gate').classList.toggle('hidden', privacyAck);
  $('ai-no-key-notice').classList.toggle('hidden', hasKey);
  $('ai-preset-buying-btn').classList.toggle('hidden', state.settings.sessionPurpose !== 'buying');
  $('ai-answering-with').textContent = `Answering with ${getModelDisplayName(provider, model)}`;

  $('ai-attachment-status').textContent = state.aiPendingAttachment ? state.aiPendingAttachment.label : '';

  const canSend = privacyAck && hasKey && !state.aiStreaming;
  $('ai-send-btn').disabled = !canSend;
  $('ai-send-btn').classList.toggle('hidden', state.aiStreaming);
  $('ai-stop-btn').classList.toggle('hidden', !state.aiStreaming);
  document.querySelectorAll('.ai-preset-btn').forEach((b) => {
    b.disabled = !canSend;
  });

  const list = $('ai-chat-messages');
  list.innerHTML = '';
  if (state.aiMessages.length === 0) {
    list.innerHTML = '<div class="chat-empty">Ask a diagnostic question or tap a preset above. Your vehicle profile, DTCs, live PIDs, min/avg/max stats, and marked moments are automatically included.</div>';
    return;
  }

  for (const msg of state.aiMessages) {
    const el = document.createElement('div');
    if (msg.isError) {
      el.className = 'chat-msg chat-msg-error';
    } else if (msg.role === 'user') {
      el.className = 'chat-msg chat-msg-user';
    } else {
      el.className = 'chat-msg chat-msg-assistant';
    }
    el.textContent = msg.content || (msg.streaming ? '…' : '');
    list.appendChild(el);
  }
  list.scrollTop = list.scrollHeight;
}

function buildFullSystemPromptForChat() {
  const payload = getExportPayload();
  const { mfr, eng } = getEngineMeta(state.profile.mfrId, state.profile.engineId);
  const stats = computeSessionStats(payload.records, payload.recordedPidIds, state.pidMap);
  const contextObj = buildSessionContextObject({
    profile: state.profile,
    mfrName: mfr.name,
    engineName: eng.name,
    vehicleInfo: { ...state.vehicleInfo, dtcDescriptions: DTC_DESCRIPTIONS },
    activeProfile: payload.activeProfile,
    adapterInfo: payload.adapterInfo,
    pidHealthTracker: payload.pidHealthTracker,
    recordedPidIds: payload.recordedPidIds,
    baseline: payload.baseline,
    sessionPurpose: state.settings.sessionPurpose,
    userNotes: state.settings.userNotes,
    dashboardPids: getEffectiveDashboardPids(),
    liveValues: state.liveValues,
    pidMap: state.pidMap,
    records: state.records,
    stats,
    isSimulated: state.isSimulatedSession || state.mode === 'sim',
  });
  return `${SYSTEM_PROMPT_BASE}\n\nCurrent Session Context (JSON):\n${JSON.stringify(contextObj, null, 2)}`;
}

async function sendAiChatMessage(userQuestion) {
  const { provider, model, keys, privacyAck } = state.aiConfig;
  const apiKey = keys[provider];

  if (!privacyAck) {
    showToast('Please acknowledge the privacy notice first.', 'warn');
    return false;
  }
  if (!apiKey) {
    showToast('Add your API key in Settings > AI Assistant first.', 'warn');
    return false;
  }
  if (state.aiStreaming) return false;

  const attachmentText = state.aiPendingAttachment ? state.aiPendingAttachment.text : '';
  const attachmentLabel = state.aiPendingAttachment ? `\n\n[${state.aiPendingAttachment.label}]` : '';
  state.aiPendingAttachment = null;

  const userMsg = {
    role: 'user',
    content: `${userQuestion}${attachmentLabel}`,
    apiContent: `${userQuestion}${attachmentText}`,
  };
  const assistantMsg = {
    role: 'assistant',
    content: '',
    streaming: true,
    isError: false,
  };

  state.aiMessages.push(userMsg, assistantMsg);
  state.aiStreaming = true;
  const controller = new AbortController();
  state.aiAbortController = controller;
  renderAiChatView();

  const systemPrompt = buildFullSystemPromptForChat();
  const apiMessages = state.aiMessages
    .slice(0, -1)
    .filter((m) => !m.isError)
    .map((m) => ({
      role: m.role,
      content: m.apiContent || m.content,
    }));

  try {
    const result = await streamAiChat({
      provider,
      model,
      apiKey,
      systemPrompt,
      messages: apiMessages,
      signal: controller.signal,
      onDelta: (chunk) => {
        assistantMsg.content += chunk;
        const list = $('ai-chat-messages');
        const lastEl = list?.lastElementChild;
        if (lastEl && state.activeView === 'ai') {
          lastEl.textContent = assistantMsg.content;
          list.scrollTop = list.scrollHeight;
        }
      },
    });
    if (result?.aborted && assistantMsg.content) {
      assistantMsg.content += '\n\n(interrupted)';
    } else if (result?.aborted && !assistantMsg.content) {
      assistantMsg.content = '(interrupted)';
    }
  } catch (err) {
    if (assistantMsg.content && err.interrupted) {
      assistantMsg.content += `\n\n(interrupted — ${err.message})`;
    } else {
      assistantMsg.content = err.message || 'AI request failed.';
      assistantMsg.isError = true;
    }
  } finally {
    assistantMsg.streaming = false;
    state.aiStreaming = false;
    state.aiAbortController = null;
    renderAiChatView();
  }
  return true;
}

// Init App
function init() {
  rebuildPidMap();
  loadSavedState();

  // Populate simulator scenarios
  $('sim-scenario-select').innerHTML = SIM_SCENARIOS.map(
    (s) => `<option value="${s.id}">${s.name}</option>`
  ).join('');

  // Sync Settings UI
  document.querySelectorAll('#units-selector .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.units === (state.settings.useImperial ? 'imperial' : 'metric'));
  });
  $('wakelock-toggle').checked = state.settings.wakeLockEnabled;
  $('tx-delay-input').value = String(state.settings.txDelayMs);

  bindEvents();
  renderVehicleProfile();
  renderAiSettings();
  renderAiChatView();
  renderDashboard();

  // Clear any legacy cached protocol key from earlier builds so every connect starts fresh
  try {
    localStorage.removeItem('bayscope_last_protocol_v1');
  } catch {}

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
