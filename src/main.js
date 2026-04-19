/**
 * Neon Equalizer - Main Application v2
 * Redesigned UI: 5-tab top navigation, fixed AutoEQ, Squiglink integration
 */

import { parseConfig, generateFilterColors } from './config/parser.js';
import { serializeConfig, createDefaultConfig } from './config/serializer.js';
import { FrequencyGraph } from './components/frequencyGraph.js';
import { ParametricEQ } from './components/parametricEQ.js';
import { GraphicEQ } from './components/graphicEQ.js';
import * as SquigDB from './components/squiglinkDB.js';
import { AudioPlayer } from './components/audioPlayer.js';
import { devicePeq } from './components/devicePeq/index.js';
import { runAutoEQ } from './components/autoEQEngine.js';
import {
  TARGET_ADJUSTMENT_DEFAULTS,
  applyTargetAdjustments,
  formatTargetAdjustmentLabel,
  isTargetAdjusted,
  normalizeTargetAdjustments,
} from './components/targetAdjustments.js';
import * as TargetLoader from './components/targetLoader.js';

// ─── App State ───────────────────────────────────────────────
let appState = {
  config: createDefaultConfig(),
  configPath: null,
  apoPath: null,
  dirty: false,
  undoStack: [],
  redoStack: []
};

// ─── Components ──────────────────────────────────────────────
let freqGraph, parametricEQ, graphicEQ, audioPlayer;
let graphSpectrumEnabled = false;
let isApplyingConfig = false;
let currentEQMode = 'parametric';
let lastTraceCaptureContext = null;
let selectedSquigSourceId = '';
let selectedSquigSource = null;
const AUTO_APPLY_DELAY_MS = 650;
let autoApplyTimer = null;
let autoApplyInFlight = false;
let autoApplyPending = false;
const AUTO_SAVE_APO_KEY = 'neon-equalizer:auto-save-apo';
const DEVICE_PRESETS_KEY = 'neon-equalizer:device-presets:v1';
const DEVICE_AUTO_SWITCH_KEY = 'neon-equalizer:device-auto-switch';

// ─── Target Customizer State ──────────────────────────────────
let tcState = { ...TARGET_ADJUSTMENT_DEFAULTS };
let tcBaseTargetData = null; // original target before customizer tweaks

function publishSquigSourceSelection(source, reason = 'browser') {
  selectedSquigSource = source || null;
  selectedSquigSourceId = source?.id || '';
  window.dispatchEvent(new CustomEvent('squig-source-selected', {
    detail: { sourceId: selectedSquigSourceId, source: selectedSquigSource, reason }
  }));
  syncGraphFeatureControls();
}

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initGraph();
  initNavigation();
  initTopBar();
  initWindowControls();
  initParametricEQ();
  initGraphicEQ();
  initEQModeSelector();
  initQuickPresets();
  initAutoEQPanel();
  initTargetPicker();
  initTargetCustomizer();
  initTracePanel();
  initToolsPanel();
  initHIDPanel();
  initAdvancedPanel();
  detectAPO();
  updateStatus('Ready');
});

// ═══════════════════════════════════════════════════════════
// GRAPH
// ═══════════════════════════════════════════════════════════
function initGraph() {
  const canvas  = document.getElementById('freq-graph');
  const overlay = document.getElementById('graph-overlay');
  const tooltip = document.getElementById('graph-tooltip');
  freqGraph = new FrequencyGraph(canvas, overlay, tooltip);

  freqGraph.onFilterChange = (filter) => {
    parametricEQ.updateFilterFromGraph(filter);
    freqGraph.setFilters(parametricEQ.getFilters());
    applyAutoPreamp();
    markDirty();
  };
  freqGraph.onFilterSelect = (filter) => {
    parametricEQ.selectFilter(filter.id);
  };
  freqGraph.onFilterDelete = (filter) => {
    if (!filter?.id || !parametricEQ) return;
    parametricEQ.removeFilter(filter.id);
    showToast('Band deleted', 'info');
  };

  // Graph controls
  document.getElementById('graph-show-combined').addEventListener('click', () => {
    freqGraph.showIndividual = false;
    document.getElementById('graph-show-combined').classList.add('active');
    document.getElementById('graph-show-individual').classList.remove('active');
    freqGraph.render();
  });
  document.getElementById('graph-show-individual').addEventListener('click', () => {
    freqGraph.showIndividual = true;
    document.getElementById('graph-show-individual').classList.add('active');
    document.getElementById('graph-show-combined').classList.remove('active');
    freqGraph.render();
  });
  document.getElementById('graph-zoom-in').addEventListener('click', () => {
    const r = freqGraph.dbRange;
    if (r.max - r.min > 10) { r.min += 5; r.max -= 5; freqGraph.render(); }
  });
  document.getElementById('graph-zoom-out').addEventListener('click', () => {
    freqGraph.dbRange.min = Math.max(-60, freqGraph.dbRange.min - 5);
    freqGraph.dbRange.max = Math.min(60, freqGraph.dbRange.max + 5);
    freqGraph.render();
  });
  document.getElementById('graph-reset').addEventListener('click', () => {
    resetGraphDisplayState();
  });

  document.getElementById('graph-pref-bounds').addEventListener('click', (e) => {
    const caps = getActiveGearCapabilities();
    if (!caps.preferenceBounds) {
      showToast(caps.preferenceReason, 'warning');
      return;
    }
    refreshPreferenceBounds();
    const on = freqGraph.togglePrefBounds();
    e.currentTarget.classList.toggle('active', on);
    updateGraphLegend();
  });

  // ── Delta band toggle: measurement − target ──────────────────
  document.getElementById('graph-delta').addEventListener('click', (e) => {
    const caps = getActiveGearCapabilities();
    if (!caps.delta) {
      showToast(caps.deltaReason, 'warning');
      return;
    }
    const wantOn = !freqGraph.showDelta;
    if (wantOn && freqGraph.measurementData && freqGraph.targetData) {
      const compatibility = freqGraph.getCurveCompatibility();
      if (!compatibility.ok) {
        showToast(`Delta blocked: ${compatibility.message}`, 'warning');
        e.currentTarget.classList.remove('active');
        updateGraphLegend();
        return;
      }
    }
    const on = freqGraph.setShowDelta(wantOn);
    e.currentTarget.classList.toggle('active', on);
    updateGraphLegend();
  });

  // Live FFT spectrum overlay from the EQ Preview analyser.
  const spectrumBtn = document.getElementById('graph-spectrum');
  spectrumBtn?.addEventListener('click', (e) => {
    graphSpectrumEnabled = !graphSpectrumEnabled;
    e.currentTarget.classList.toggle('active', graphSpectrumEnabled);
    syncGraphSpectrumOverlay();
    updateGraphLegend();
    if (graphSpectrumEnabled && !audioPlayer?.isPlaying) {
      showToast('Start EQ Preview playback to feed the FFT overlay', 'info');
    }
  });

  // ── Smoothing toggle (None → 1/24 → 1/12 → 1/6 → 1/3 → None) ─
  const smoothBtn = document.getElementById('graph-smoothing');
  const smoothCycle = ['none', '1/24', '1/12', '1/6', '1/3'];
  smoothBtn.addEventListener('click', () => {
    const idx = smoothCycle.indexOf(freqGraph.smoothing);
    const next = smoothCycle[(idx + 1) % smoothCycle.length];
    freqGraph.setSmoothing(next);
    smoothBtn.textContent = next === 'none' ? 'Smooth' : next;
    smoothBtn.title = `FR Smoothing: ${next === 'none' ? 'None' : next + ' octave'}`;
    smoothBtn.classList.toggle('active', next !== 'none');
  });

  // ── Y-axis scale cycle (±30 → ±20 → ±40 → ±15) ───────────────
  const yScaleBtn = document.getElementById('graph-yscale');
  yScaleBtn.addEventListener('click', () => {
    const label = freqGraph.cycleDbRange();
    yScaleBtn.title = `Y-axis: ${label}`;
  });

  // ── Normalization reference frequency ────────────────────────
  const normSel = document.getElementById('graph-normalize-freq');
  normSel.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    freqGraph.setNormalizeFreq(v);
    if (freqGraph.prefBoundsVisible) refreshPreferenceBounds();
    normSel.title = v === 0 ? 'No normalization' : `Normalized at ${v} Hz`;
  });

  // ── Screenshot ───────────────────────────────────────────────
  const baselineSel = document.getElementById('graph-baseline-mode');
  const curveSel = document.getElementById('graph-offset-curve');
  const hideBtn = document.getElementById('graph-curve-hide');
  const offsetDown = document.getElementById('graph-offset-down');
  const offsetUp = document.getElementById('graph-offset-up');
  const offsetReset = document.getElementById('graph-offset-reset');
  const curveLabels = {
    measurement: 'Measurement',
    target: 'Target',
    corrected: 'Corrected',
    eq: 'EQ curve',
  };
  const syncCurveDisplayControls = () => {
    if (!curveSel || !hideBtn) return;
    const curve = curveSel.value;
    const label = curveLabels[curve] || curve;
    const visible = freqGraph.curveVisibility[curve] !== false;
    const offset = freqGraph.curveOffsets[curve] || 0;
    hideBtn.textContent = visible ? 'Hide' : 'Show';
    hideBtn.classList.toggle('active', !visible);
    hideBtn.title = `${visible ? 'Hide' : 'Show'} ${label}`;
    if (offsetDown) offsetDown.title = `Move ${label} down 1 dB (current ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} dB)`;
    if (offsetUp) offsetUp.title = `Move ${label} up 1 dB (current ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} dB)`;
    if (offsetReset) offsetReset.title = `Reset ${label} offset`;
    baselineSel?.classList.toggle('active', freqGraph.baselineMode !== 'none');
  };
  baselineSel?.addEventListener('change', (e) => {
    freqGraph.setBaselineMode(e.target.value);
    syncCurveDisplayControls();
    updateGraphLegend();
  });
  curveSel?.addEventListener('change', syncCurveDisplayControls);
  hideBtn?.addEventListener('click', () => {
    freqGraph.toggleCurveVisible(curveSel.value);
    syncCurveDisplayControls();
    updateGraphLegend();
  });
  offsetDown?.addEventListener('click', () => {
    freqGraph.adjustCurveOffset(curveSel.value, -1);
    syncCurveDisplayControls();
    updateGraphLegend();
  });
  offsetUp?.addEventListener('click', () => {
    freqGraph.adjustCurveOffset(curveSel.value, 1);
    syncCurveDisplayControls();
    updateGraphLegend();
  });
  offsetReset?.addEventListener('click', () => {
    freqGraph.setCurveOffset(curveSel.value, 0);
    syncCurveDisplayControls();
    updateGraphLegend();
  });

  function resetGraphDisplayState() {
    freqGraph.resetDisplayState();
    document.getElementById('graph-show-combined')?.classList.add('active');
    document.getElementById('graph-show-individual')?.classList.remove('active');
    document.getElementById('graph-pref-bounds')?.classList.remove('active');
    document.getElementById('graph-delta')?.classList.remove('active');
    document.getElementById('graph-spectrum')?.classList.remove('active');
    graphSpectrumEnabled = false;
    freqGraph.setSpectrumAnalyser(null);
    smoothBtn.textContent = 'Smooth';
    smoothBtn.title = 'FR Smoothing: None';
    smoothBtn.classList.remove('active');
    yScaleBtn.title = 'Y-axis: +/-30 dB';
    if (normSel) {
      normSel.value = '1000';
      normSel.title = 'Normalized at 1000 Hz';
    }
    if (baselineSel) baselineSel.value = 'none';
    if (curveSel) curveSel.value = 'measurement';
    syncCurveDisplayControls();
    refreshPreferenceBounds();
    updateGraphLegend();
    showToast('Graph display reset', 'success');
  }
  syncCurveDisplayControls();

  document.getElementById('graph-screenshot').addEventListener('click', () => {
    const ok = freqGraph.saveScreenshot();
    showToast(ok ? 'Graph saved as PNG' : 'Screenshot failed', ok ? 'success' : 'error');
  });

  updateGraphLegend();
}

function getActiveGearCapabilities() {
  const measurement = freqGraph?.measurementMeta || null;
  const target = freqGraph?.targetMeta || null;
  const selected = selectedSquigSource || null;
  const type = measurement?.sourceType || selected?.type || target?.sourceType || 'generic';
  const normalizedType = String(type || 'generic').toLowerCase();
  const sourceName = measurement?.sourceName || selected?.name || target?.sourceName || 'this gear';
  const isExplicitNon711 = ['5128', 'headphones', 'earbuds'].includes(normalizedType);
  const is711Like = ['iems', '711', 'generic', 'unknown'].includes(normalizedType);
  const hasMeasurement = !!freqGraph?.measurementData;
  const hasTarget = !!freqGraph?.targetData;
  const unrestricted = !!target?.allowUnsafeMatch;
  const squigDeltaReady = measurement?.source === 'squig'
    ? measurement.deltaReady === true
    : selected?.id
      ? selected.deltaReady === true
      : true;

  return {
    type,
    preferenceBounds: is711Like && !isExplicitNon711,
    preferenceReason: `Preference bounds are currently limited to 711/IEM-style targets. ${sourceName} is ${type}.`,
    delta: hasMeasurement && hasTarget && (squigDeltaReady || unrestricted),
    deltaReason: !hasMeasurement || !hasTarget
      ? 'Load a measurement and target before showing delta.'
      : `${sourceName} does not declare delta support for this gear/source. Enable Free reviewer targets to compare anyway.`,
  };
}

function syncGraphFeatureControls() {
  if (!freqGraph) return;
  const caps = getActiveGearCapabilities();
  const prefBtn = document.getElementById('graph-pref-bounds');
  const deltaBtn = document.getElementById('graph-delta');

  if (prefBtn) {
    prefBtn.style.display = caps.preferenceBounds ? '' : 'none';
    prefBtn.title = caps.preferenceBounds ? 'Toggle 711/IEM preference bounds' : caps.preferenceReason;
    if (!caps.preferenceBounds && freqGraph.prefBoundsVisible) {
      freqGraph.prefBoundsVisible = false;
      prefBtn.classList.remove('active');
      freqGraph.render();
    }
  }

  if (deltaBtn) {
    deltaBtn.style.display = caps.delta ? '' : 'none';
    deltaBtn.title = caps.delta ? 'Show delta (measurement - target)' : caps.deltaReason;
    if (!caps.delta && freqGraph.showDelta) {
      freqGraph.setShowDelta(false);
      deltaBtn.classList.remove('active');
    }
  }
}

function updateGraphLegend() {
  syncGraphFeatureControls();
  const legend = document.getElementById('graph-legend');
  if (legend) {
    const items = [];
    const visible = freqGraph.curveVisibility || {};
    const offsets = freqGraph.curveOffsets || {};
    const offsetSuffix = (key) => {
      const db = offsets[key] || 0;
      return Math.abs(db) >= 0.05 ? ` (${db >= 0 ? '+' : ''}${db.toFixed(1)} dB)` : '';
    };
    const measurementMeta = freqGraph.measurementMeta || {};
    if (freqGraph.measurementData && visible.measurement !== false) {
      items.push({
        color: measurementMeta.color || '#8ab4ff',
        label: `${measurementMeta.label || 'Measurement'}${offsetSuffix('measurement')}`,
      });
    }
    if (freqGraph.targetData && visible.target !== false) {
      items.push({ color: '#34d399', label: `Target${offsetSuffix('target')}`, style: 'dashed' });
    }
    if (freqGraph.measurementData && visible.corrected !== false && appState?.config?.filters?.some(f => f.enabled && !f.isEffect)) {
      items.push({ color: '#fb923c', label: `Corrected${offsetSuffix('corrected')}`, style: 'dotdash' });
    }
    if (freqGraph.graphicEQ?.bands?.some(b => Math.abs(b.gain) > 0.001)) {
      items.push({ color: '#22d3ee', label: 'Graphic EQ', style: 'dashed' });
    }
    if (freqGraph.showDelta && freqGraph.measurementData && freqGraph.targetData) {
      const compatibility = freqGraph.getCurveCompatibility?.();
      if (compatibility?.ok) {
        items.push({ color: '#ef4444', label: 'Δ (meas − aligned target)', style: 'band' });
      } else {
        items.push({ color: '#f59e0b', label: 'Δ blocked: curve mismatch', style: 'dashed' });
      }
    }
    if (freqGraph.spectrumAnalyser) {
      items.push({ color: '#22d3ee', label: 'Live FFT', style: 'band' });
    }
    if (visible.eq !== false) items.push({ gradient: true, label: `EQ Curve${offsetSuffix('eq')}` });
    if (freqGraph.baselineMode && freqGraph.baselineMode !== 'none') {
      const label = freqGraph.baselineMode === 'target' ? 'Compensated to target' : 'Compensated to measurement';
      items.push({ color: '#a3e635', label, style: 'dashed' });
    }
    if (freqGraph.prefBoundsVisible) items.push({ color: '#fbbf24', label: 'Pref. Bounds', style: 'dashed' });
    legend.innerHTML = items.map(i => {
      let swatch;
      if (i.gradient) {
        swatch = '<div class="legend-line" style="background:linear-gradient(90deg,#00d4ff,#7c3aed,#ec4899);"></div>';
      } else if (i.style === 'dashed') {
        swatch = `<div class="legend-line" style="background:none;border-top:2px dashed ${i.color};"></div>`;
      } else if (i.style === 'dotdash') {
        swatch = `<div class="legend-line" style="background:none;border-top:2px dotted ${i.color};"></div>`;
      } else if (i.style === 'band') {
        swatch = `<div class="legend-line" style="background:${i.color}33;border-top:1px solid ${i.color};border-bottom:1px solid ${i.color};"></div>`;
      } else {
        swatch = `<div class="legend-line" style="background:${i.color};"></div>`;
      }
      return `<div class="graph-legend-item">${swatch}${i.label}</div>`;
    }).join('');
  }
  updateAutoEQButtonState();
}

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════
function initNavigation() {
  const tabs   = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(`panel-${target}`);
      if (panel) panel.classList.add('active');
    });
  });
}

// ═══════════════════════════════════════════════════════════
// TOP BAR
// ═══════════════════════════════════════════════════════════
function initEQModeSelector() {
  const select = document.getElementById('eq-type-select');
  if (!select) return;

  select.addEventListener('change', (e) => {
    showEQMode(e.target.value);
  });
  showEQMode(select.value || currentEQMode);
}

function showEQMode(mode = 'parametric') {
  currentEQMode = mode === 'graphic' ? 'graphic' : 'parametric';

  const select = document.getElementById('eq-type-select');
  if (select) select.value = currentEQMode;

  document.getElementById('eq-parametric-view')
    ?.classList.toggle('active', currentEQMode === 'parametric');
  document.getElementById('eq-graphic-view')
    ?.classList.toggle('active', currentEQMode === 'graphic');

  if (currentEQMode === 'graphic') syncGraphicEQControls();
}

function openEqualizer(mode = currentEQMode) {
  document.querySelector('[data-tab="eq"]')?.click();
  showEQMode(mode);
}

function initTopBar() {
  const preampSlider = document.getElementById('preamp-slider');
  const preampValue  = document.getElementById('preamp-value');
  const clipDot      = document.getElementById('clip-dot');

  preampSlider.addEventListener('input', (e) => {
    if (document.getElementById('auto-preamp-enabled').checked) {
      document.getElementById('auto-preamp-enabled').checked = false;
    }
    const val = parseFloat(e.target.value);
    appState.config.preamp = val;
    preampValue.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
    freqGraph.setPreamp(val);
    clipDot.className = 'clip-dot' + (val > 6 ? ' danger' : val > 0 ? ' warn' : '');
    markDirty();
  });

  document.getElementById('auto-preamp-enabled').addEventListener('change', (e) => {
    if (e.target.checked) applyAutoPreamp();
  });

  initDeviceSelector();
  initAutoSaveAPOToggle();
  document.getElementById('btn-save').addEventListener('click', saveConfig);
  document.getElementById('btn-import').addEventListener('click', importConfig);
  document.getElementById('btn-export').addEventListener('click', exportConfig);
  document.getElementById('config-path-btn').addEventListener('click', changeConfigPath);
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveConfig(); }
  });
}

function initAutoSaveAPOToggle() {
  const toggle = document.getElementById('auto-save-apo-enabled');
  if (!toggle) return;

  toggle.checked = getAutoSaveAPOEnabled();
  updateSaveModeLabel(toggle.checked);

  toggle.addEventListener('change', () => {
    setAutoSaveAPOEnabled(toggle.checked);
    updateSaveModeLabel(toggle.checked);

    if (toggle.checked) {
      showToast('Auto Save to APO enabled', 'info');
      if (appState.dirty) scheduleAutoApply();
    } else {
      if (autoApplyTimer) {
        clearTimeout(autoApplyTimer);
        autoApplyTimer = null;
      }
      autoApplyPending = false;
      updateStatus(appState.dirty ? 'Unsaved changes' : 'Manual save mode');
      showToast('Manual Save to APO enabled', 'info');
    }
  });
}

function getAutoSaveAPOEnabled() {
  try {
    const stored = localStorage.getItem(AUTO_SAVE_APO_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

function setAutoSaveAPOEnabled(enabled) {
  try {
    localStorage.setItem(AUTO_SAVE_APO_KEY, String(Boolean(enabled)));
  } catch {
    // Ignore storage failures; the visible toggle still controls this session.
  }
}

function updateSaveModeLabel(enabled) {
  const label = document.querySelector('.save-mode-text');
  if (label) label.textContent = enabled ? 'Auto Save' : 'Manual Save';
  const toggle = document.getElementById('auto-save-apo-enabled');
  if (toggle) {
    toggle.title = enabled
      ? 'Every change is saved to Equalizer APO automatically'
      : 'Changes wait until you press Save to APO';
  }
}

function initDeviceSelector() {
  const select = document.getElementById('device-select');
  if (!select) return;

  renderDeviceSelector(appState.config.device || 'all');

  select.addEventListener('change', () => {
    const deviceKey = select.value || 'all';
    const profile = getDevicePresets()[deviceKey];
    const deviceName = profile?.name || deviceKey;

    if (getDeviceAutoSwitchEnabled() && profile?.config) {
      pushUndo();
      const nextConfig = JSON.parse(JSON.stringify(profile.config));
      nextConfig.device = deviceKey === 'all' ? null : deviceName;
      applyConfigObject(nextConfig);
      renderDeviceSelector(deviceKey);
      markDirty();
      showToast(`Loaded device preset: ${deviceName}`, 'success');
      return;
    }

    appState.config.device = deviceKey === 'all' ? null : deviceName;
    updateRawConfigEditor();
    markDirty();
  });

  document.getElementById('btn-device-save-preset')?.addEventListener('click', saveCurrentDevicePreset);

  const autoToggle = document.getElementById('device-auto-switch-enabled');
  if (autoToggle) {
    autoToggle.checked = getDeviceAutoSwitchEnabled();
    autoToggle.addEventListener('change', () => {
      setDeviceAutoSwitchEnabled(autoToggle.checked);
      showToast(autoToggle.checked ? 'Device auto-switch enabled' : 'Device auto-switch disabled', 'info');
    });
  }

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    renderDeviceSelector(select.value || appState.config.device || 'all');
  });
}

function getDevicePresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEVICE_PRESETS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function setDevicePresets(presets) {
  localStorage.setItem(DEVICE_PRESETS_KEY, JSON.stringify(presets));
}

function getDeviceAutoSwitchEnabled() {
  try {
    return localStorage.getItem(DEVICE_AUTO_SWITCH_KEY) === 'true';
  } catch {
    return false;
  }
}

function setDeviceAutoSwitchEnabled(enabled) {
  try {
    localStorage.setItem(DEVICE_AUTO_SWITCH_KEY, String(Boolean(enabled)));
  } catch {
    // Keep the live toggle usable even if persistent storage is blocked.
  }
}

function renderDeviceSelector(preferred = null) {
  const select = document.getElementById('device-select');
  if (!select) return;

  const presets = getDevicePresets();
  const names = new Map();
  for (const [key, preset] of Object.entries(presets)) {
    if (key && key !== 'all') names.set(key, preset?.name || key);
  }
  if (appState.config.device && appState.config.device !== 'all') {
    const key = normalizeDevicePresetKey(appState.config.device);
    names.set(key, appState.config.device);
  }

  const target = normalizeDevicePresetKey(preferred || appState.config.device || select.value || 'all');
  select.innerHTML = '<option value="all">All Devices</option>';

  for (const [key, name] of [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = presets[key]?.config ? `${name} • preset` : name;
    select.appendChild(opt);
  }

  select.value = target === 'all' || names.has(target) ? target : 'all';
}

function saveCurrentDevicePreset() {
  const select = document.getElementById('device-select');
  const selected = select?.value || 'all';
  let name = selected !== 'all'
    ? (getDevicePresets()[selected]?.name || selected)
    : (appState.config.device || '');

  if (!name || name === 'all') {
    name = window.prompt('Device name for this EQ preset:', '')?.trim() || '';
  }
  if (!name) {
    showToast('Device preset needs a name', 'warning');
    return;
  }

  const key = normalizeDevicePresetKey(name);
  const config = snapshotCurrentConfig();
  config.device = name;

  const presets = getDevicePresets();
  presets[key] = {
    name,
    updatedAt: new Date().toISOString(),
    config
  };
  setDevicePresets(presets);

  appState.config.device = name;
  renderDeviceSelector(key);
  updateRawConfigEditor();
  markDirty();
  showToast(`Saved device preset: ${name}`, 'success');
}

function normalizeDevicePresetKey(value) {
  const text = String(value || '').trim();
  return !text || text.toLowerCase() === 'all' ? 'all' : text;
}

function initWindowControls() {
  document.getElementById('btn-minimize')?.addEventListener('click', () => window.windowAPI?.minimize());
  document.getElementById('btn-maximize')?.addEventListener('click', () => window.windowAPI?.maximize());
  document.getElementById('btn-close')?.addEventListener('click', () => window.windowAPI?.close());
}

// ═══════════════════════════════════════════════════════════
// PARAMETRIC EQ
// ═══════════════════════════════════════════════════════════
function initParametricEQ() {
  const filterList = document.getElementById('filter-list');
  parametricEQ = new ParametricEQ(filterList, (filters) => {
    appState.config.filters = filters;
    freqGraph.setFilters(filters);
    applyAutoPreamp();
    updateFilterCount();
    markDirty();
    audioPlayer?.refreshEQ();
  });

  document.getElementById('btn-add-filter').addEventListener('click', () => {
    parametricEQ.addFilter();
  });

  document.getElementById('filter-preset-select').addEventListener('change', (e) => {
    if (e.target.value) {
      parametricEQ.loadPreset(e.target.value);
      e.target.value = '';
    }
  });

  // Audio Preview Player
  const apContainer = document.getElementById('audio-player-container');
  if (apContainer) {
    audioPlayer = new AudioPlayer(
      apContainer,
      () => parametricEQ.getFilters(),
      () => appState.config.preamp || 0
    );
    audioPlayer.onAnalyserChange = syncGraphSpectrumOverlay;
  }
}

function buildMeasurementMetaForPhone(phone, overrides = {}) {
  return {
    source: overrides.source || 'squig',
    label: overrides.label || 'Measurement',
    color: overrides.color || '#8ab4ff',
    width: overrides.width || 1.5,
    sourceId: phone?.sourceId || null,
    sourceName: phone?.sourceName || null,
    sourceType: phone?.sourceType || null,
    dataKind: overrides.dataKind || 'raw',
    gearName: phone?.name || null,
    deltaReady: phone?.deltaReady,
    path: phone?.files?.[0] || null,
  };
}

function buildTargetMeta(target, displayName, overrides = {}) {
  return {
    source: target.source || target.category || 'target',
    label: displayName || target.name || 'Target',
    sourceId: target.sourceId || target.source || null,
    sourceName: target.sourceName || target.category || null,
    sourceType: target.sourceType || 'generic',
    category: target.category || null,
    dataKind: 'target',
    allowCrossSource: !!(overrides.allowCrossSource || target.allowCrossSource),
    allowUnsafeMatch: !!(overrides.allowUnsafeMatch || target.allowUnsafeMatch),
    deltaReady: target.deltaReady,
    customized: !!overrides.customized,
    adjustmentLabel: overrides.adjustmentLabel || null,
    path: target.path || target.url || null,
  };
}

function sourceFromPhone(phone) {
  if (!phone?.sourceId) return null;
  return {
    id: phone.sourceId,
    name: phone.sourceName || phone.sourceId,
    type: phone.sourceType || 'unknown',
    baseUrl: phone.sourceBase || '',
    folder: phone.folder || '/',
    dataPath: phone.dataPath || '',
    color: phone.sourceColor || '#8ab4ff',
    icon: phone.sourceIcon || '',
    deltaReady: !!phone.deltaReady,
  };
}

function syncGraphSpectrumOverlay() {
  const analyser = graphSpectrumEnabled ? audioPlayer?.getAnalyserNode?.() : null;
  freqGraph?.setSpectrumAnalyser(analyser || null);
  updateGraphLegend();
}

// ═══════════════════════════════════════════════════════════
// GRAPHIC EQ
// ═══════════════════════════════════════════════════════════
function initGraphicEQ() {
  const container = document.getElementById('graphic-eq-container');
  const enabledToggle = document.getElementById('graphic-enabled');
  const bandsSelect = document.getElementById('graphic-bands-select');
  const frequenciesInput = document.getElementById('graphic-frequencies-input');
  graphicEQ = new GraphicEQ(container, (geqConfig) => {
    if (isApplyingConfig) return;
    appState.config.graphicEQ = geqConfig;
    freqGraph.setGraphicEQ(geqConfig);
    applyAutoPreamp();
    markDirty();
    syncGraphicEQControls();
  });

  enabledToggle?.addEventListener('change', (e) => {
    graphicEQ.setEnabled(e.target.checked);
  });
  bandsSelect?.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      frequenciesInput?.focus();
      return;
    }
    graphicEQ.init(parseInt(e.target.value));
  });
  document.getElementById('btn-graphic-apply-frequencies')?.addEventListener('click', () => {
    const freqs = GraphicEQ.parseFrequencyList(frequenciesInput?.value || '');
    if (!freqs.length) {
      showToast('Type custom frequencies first, for example: 20, 60, 120, 1000', 'warning');
      return;
    }
    pushUndo();
    if (graphicEQ.setFrequencies(freqs, true)) {
      syncGraphicEQControls();
      showToast(`Applied ${graphicEQ.bands.length} custom Graphic EQ bands`, 'success');
    }
  });
  document.getElementById('btn-graphic-add-band')?.addEventListener('click', () => {
    const freqs = GraphicEQ.parseFrequencyList(frequenciesInput?.value || '');
    const fallback = graphicEQ.bands.length
      ? graphicEQ.bands[Math.floor(graphicEQ.bands.length / 2)].frequency
      : 1000;
    pushUndo();
    graphicEQ.addBand(freqs[freqs.length - 1] || fallback);
    syncGraphicEQControls();
    showToast('Graphic EQ band added', 'success');
  });
  document.getElementById('btn-graphic-smooth').addEventListener('click', () => {
    runGraphicEQAction(() => graphicEQ.smooth(), 'Graphic EQ smoothed');
  });
  document.getElementById('btn-graphic-invert')?.addEventListener('click', () => {
    runGraphicEQAction(() => graphicEQ.invert(), 'Graphic EQ inverted');
  });
  document.getElementById('btn-graphic-normalize')?.addEventListener('click', () => {
    runGraphicEQAction(() => graphicEQ.normalize(), 'Graphic EQ normalized');
  });
  document.getElementById('btn-graphic-reset').addEventListener('click', () => {
    runGraphicEQAction(() => graphicEQ.reset(), 'Graphic EQ reset');
  });
  document.getElementById('btn-graphic-import')?.addEventListener('click', importGraphicEQResponse);
  document.getElementById('btn-graphic-export')?.addEventListener('click', exportGraphicEQResponse);
}

function syncGraphicEQControls() {
  const enabledToggle = document.getElementById('graphic-enabled');
  if (enabledToggle && enabledToggle.checked !== graphicEQ.enabled) enabledToggle.checked = graphicEQ.enabled;
  const bandsSelect = document.getElementById('graphic-bands-select');
  if (bandsSelect) {
    const value = String(graphicEQ.bandCount);
    bandsSelect.value = [...bandsSelect.options].some(o => o.value === value) ? value : 'custom';
  }
  const frequenciesInput = document.getElementById('graphic-frequencies-input');
  if (frequenciesInput && document.activeElement !== frequenciesInput) {
    frequenciesInput.value = graphicEQ.getBands().map(b => b.frequency).join(', ');
  }
}

function runGraphicEQAction(action, message) {
  pushUndo();
  action();
  syncGraphicEQControls();
  showToast(message, 'success');
}

async function importGraphicEQResponse() {
  if (!window.apoAPI) {
    showToast('Graphic EQ import requires the desktop app', 'warning');
    return;
  }
  const file = await window.apoAPI.selectFile({
    filters: [
      { name: 'Frequency response', extensions: ['csv', 'txt', 'frd'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!file) return;

  const result = await window.apoAPI.readConfig(file);
  if (!result.content) {
    showToast(`Import failed: ${result.error || 'file could not be read'}`, 'error');
    return;
  }

  const bands = GraphicEQ.parseFrequencyResponse(result.content);
  if (!bands.length) {
    showToast('No frequency/gain pairs found in that file', 'warning');
    return;
  }

  pushUndo();
  graphicEQ.setBands(bands, true);
  syncGraphicEQControls();
  showToast(`Imported ${bands.length} Graphic EQ point${bands.length === 1 ? '' : 's'}`, 'success');
}

async function importAdvancedEQ(kind) {
  if (!window.apoAPI) {
    showToast('EQ import requires the desktop app', 'warning');
    return;
  }

  const file = await window.apoAPI.selectFile({
    filters: [
      { name: kind === 'wavelet' ? 'Wavelet / GraphicEQ' : 'Squig / APO EQ', extensions: ['txt', 'cfg', 'csv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!file) return;

  const result = await window.apoAPI.readConfig(file);
  if (!result.content) {
    showToast(`Import failed: ${result.error || 'file could not be read'}`, 'error');
    return;
  }

  if (kind === 'wavelet') {
    const bands = GraphicEQ.parseFrequencyResponse(result.content);
    if (!bands.length) {
      showToast('No Wavelet GraphicEQ frequency/gain pairs found', 'warning');
      return;
    }
    applyImportedGraphicEQ(bands);
    return;
  }

  const imported = parseSquigEQText(result.content);
  if (imported.graphicEQ?.bands?.length && !imported.filters.length) {
    applyImportedGraphicEQ(imported.graphicEQ.bands);
    return;
  }
  if (!imported.filters.length) {
    showToast('No Squig/PEQ filters found in that file', 'warning');
    return;
  }
  applyImportedParametricEQ(imported);
}

function parseSquigEQText(text) {
  const parsed = parseConfig(text);
  if (parsed.filters.length || parsed.graphicEQ?.bands?.length) return parsed;

  const lines = String(text || '').split(/\r?\n/);
  const colors = generateFilterColors(32);
  const filters = [];
  let preamp = parsed.preamp || 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

    const preampMatch = trimmed.match(/\bpreamp\b\D*([-+]?\d+(?:[.,]\d+)?)/i);
    if (preampMatch) {
      preamp = parseImportedNumber(preampMatch[1]);
      continue;
    }

    const type = normalizeImportedFilterType(trimmed);
    if (!type) continue;

    const frequency = extractImportedParam(trimmed, ['Fc', 'Freq', 'Frequency', 'Hz']);
    const gain = extractImportedParam(trimmed, ['Gain', 'dB']);
    const q = extractImportedParam(trimmed, ['Q']);
    const loose = trimmed.match(/[-+]?(?:\d+[\.,]?\d*|[\.,]\d+)(?:[eE][-+]?\d+)?/g)
      ?.map(parseImportedNumber)
      .filter(Number.isFinite) || [];

    const next = {
      id: `import_${Date.now()}_${filters.length}`,
      enabled: !/\bOFF\b/i.test(trimmed),
      type,
      frequency: frequency ?? loose[0],
      gain: gain ?? loose[1] ?? 0,
      q: q ?? loose[2] ?? 0.7,
      bw: null,
      color: colors[filters.length % colors.length],
      index: filters.length,
    };
    if (Number.isFinite(next.frequency) && next.frequency > 0) filters.push(next);
  }

  return { ...parsed, preamp, filters };
}

function normalizeImportedFilterType(line) {
  if (/\b(?:PK|PEQ|Peak|Peaking)\b/i.test(line)) return 'PK';
  if (/\b(?:LSQ|LS|Low\s*Shelf|Lowshelf)\b/i.test(line)) return 'LS';
  if (/\b(?:HSQ|HS|High\s*Shelf|Highshelf)\b/i.test(line)) return 'HS';
  return null;
}

function extractImportedParam(line, names) {
  for (const name of names) {
    const pattern = new RegExp(`\\b${name}\\b\\s*[:=]?\\s*([-+]?(?:\\d+[\\.,]?\\d*|[\\.,]\\d+)(?:[eE][-+]?\\d+)?)`, 'i');
    const match = line.match(pattern);
    if (match) return parseImportedNumber(match[1]);
  }
  return null;
}

function parseImportedNumber(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function applyImportedParametricEQ(imported) {
  pushUndo();
  appState.config.filters = imported.filters;
  appState.config.graphicEQ = null;
  appState.config.preamp = Number.isFinite(imported.preamp) ? imported.preamp : appState.config.preamp;
  parametricEQ.setFilters(appState.config.filters);
  freqGraph.setFilters(appState.config.filters);
  graphicEQ.reset();
  graphicEQ.setEnabled(true);
  freqGraph.setGraphicEQ(null);
  syncImportedPreamp();
  syncGraphicEQControls();
  updateFilterCount();
  updateGraphLegend();
  document.getElementById('raw-config-editor').value = serializeConfig(appState.config);
  openEqualizer('parametric');
  markDirty();
  audioPlayer?.refreshEQ();
  showToast(`Imported ${imported.filters.length} Squig PEQ filter${imported.filters.length === 1 ? '' : 's'}`, 'success');
}

function applyImportedGraphicEQ(bands) {
  pushUndo();
  graphicEQ.setBands(bands, true);
  appState.config.graphicEQ = graphicEQ.getConfig();
  freqGraph.setGraphicEQ(appState.config.graphicEQ);
  syncGraphicEQControls();
  updateGraphLegend();
  document.getElementById('raw-config-editor').value = serializeConfig(appState.config);
  openEqualizer('graphic');
  markDirty();
  audioPlayer?.refreshEQ();
  showToast(`Imported ${bands.length} Wavelet/GraphicEQ band${bands.length === 1 ? '' : 's'}`, 'success');
}

function syncImportedPreamp() {
  const preamp = appState.config.preamp || 0;
  const slider = document.getElementById('preamp-slider');
  if (slider) slider.value = preamp;
  const label = document.getElementById('preamp-value');
  if (label) label.textContent = `${preamp >= 0 ? '+' : ''}${preamp.toFixed(1)} dB`;
  freqGraph.setPreamp(preamp);
}

async function exportAdvancedEQ(kind) {
  const isWavelet = kind === 'wavelet';
  const text = isWavelet ? buildWaveletExportText() : buildSquigPeqExportText();
  if (!text) return;

  const defaultPath = isWavelet ? 'Wavelet-GraphicEQ.txt' : 'Squig-PEQ-Filters.txt';
  if (window.apoAPI?.saveFile) {
    const result = await window.apoAPI.saveFile(text, {
      title: isWavelet ? 'Export Wavelet GraphicEQ' : 'Export Squig PEQ',
      defaultPath,
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result?.success) {
      showToast(`${isWavelet ? 'Wavelet' : 'Squig PEQ'} export saved`, 'success');
      return;
    }
    if (result?.canceled) return;
    showToast(`Export failed: ${result?.error || 'unknown error'}`, 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast(`${isWavelet ? 'Wavelet' : 'Squig PEQ'} export copied`, 'success');
  } catch {
    const editor = document.getElementById('raw-config-editor');
    if (editor) editor.value = text;
    showToast('Export text placed in Raw Configuration', 'info');
  }
}

function buildSquigPeqExportText() {
  const filters = (parametricEQ?.getFilters?.() || appState.config.filters || [])
    .filter(f => f && !f.isEffect);
  if (!filters.length) {
    showToast('No parametric filters to export', 'warning');
    return '';
  }

  const lines = [
    'Preamp: ' + formatExportNumber(appState.config.preamp || 0, 1) + ' dB',
  ];
  filters.forEach((filter, index) => {
    lines.push(formatSquigFilterLine(filter, index + 1));
  });
  return lines.join('\n') + '\n';
}

function formatSquigFilterLine(filter, number) {
  const type = normalizeExportFilterType(filter.type);
  const freq = Number(filter.frequency || 0);
  const gain = Number(filter.gain || 0);
  const q = Number(filter.q || 0.707);
  const state = filter.enabled === false ? 'OFF' : 'ON';
  return `Filter ${number}: ${state} ${type} Fc ${formatExportNumber(freq, 1)} Hz Gain ${formatExportNumber(gain, 1)} dB Q ${formatExportNumber(q, 3)}`;
}

function normalizeExportFilterType(type) {
  if (['LS', 'LSC', 'LS 6dB', 'LS 12dB'].includes(type)) return 'LSQ';
  if (['HS', 'HSC', 'HS 6dB', 'HS 12dB'].includes(type)) return 'HSQ';
  return 'PK';
}

function buildWaveletExportText() {
  const config = graphicEQ?.getConfig?.() || appState.config.graphicEQ;
  const bands = (config?.bands || [])
    .filter(b => Number.isFinite(Number(b.frequency)) && Number.isFinite(Number(b.gain)))
    .sort((a, b) => Number(a.frequency) - Number(b.frequency));
  if (!bands.length) {
    showToast('No Graphic EQ bands to export for Wavelet', 'warning');
    return '';
  }
  return `GraphicEQ: ${bands
    .map(b => `${formatExportNumber(Number(b.frequency), 2)} ${formatExportNumber(Number(b.gain), 2)}`)
    .join('; ')}\n`;
}

function formatExportNumber(value, decimals) {
  const fixed = Number(value || 0).toFixed(decimals);
  return fixed.replace(/\.?0+$/, '');
}

async function exportGraphicEQResponse() {
  const csv = graphicEQ.toCSV();
  if (window.apoAPI?.saveFile) {
    const result = await window.apoAPI.saveFile(csv, {
      title: 'Export Graphic EQ response',
      defaultPath: 'GraphicEQ.csv',
      filters: [
        { name: 'Frequency response', extensions: ['csv'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result?.success) {
      showToast('Graphic EQ exported', 'success');
      return;
    }
    if (result?.canceled) return;
    showToast(`Export failed: ${result?.error || 'unknown error'}`, 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(csv);
    showToast('Graphic EQ CSV copied to clipboard', 'success');
  } catch {
    showToast('Could not export Graphic EQ', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// QUICK LOCAL EQ PRESETS
// ═══════════════════════════════════════════════════════════════
const QUICK_PRESETS_KEY = 'eqapoStudio.quickPresets.v1';

function initQuickPresets() {
  document.getElementById('btn-quick-save')?.addEventListener('click', saveQuickPreset);
  document.getElementById('btn-quick-delete')?.addEventListener('click', deleteQuickPreset);
  document.getElementById('quick-preset-select')?.addEventListener('change', (e) => {
    if (e.target.value) loadQuickPreset(e.target.value);
  });
  renderQuickPresetSelect();
}

function getQuickPresets() {
  try {
    const raw = localStorage.getItem(QUICK_PRESETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setQuickPresets(presets) {
  localStorage.setItem(QUICK_PRESETS_KEY, JSON.stringify(presets));
}

function snapshotCurrentConfig() {
  const graphicConfig = graphicEQ?.getConfig?.();
  return {
    ...JSON.parse(JSON.stringify(appState.config)),
    graphicEQ: graphicConfig && graphicConfig.bands?.some(b => Math.abs(b.gain) > 0.001)
      ? graphicConfig
      : appState.config.graphicEQ
  };
}

function renderQuickPresetSelect() {
  const select = document.getElementById('quick-preset-select');
  if (!select) return;
  const presets = getQuickPresets().sort((a, b) => a.name.localeCompare(b.name));
  const current = select.value;
  select.innerHTML = '<option value="">My EQ Presets...</option>';
  for (const preset of presets) {
    const opt = document.createElement('option');
    opt.value = preset.name;
    opt.textContent = preset.name;
    select.appendChild(opt);
  }
  select.value = presets.some(p => p.name === current) ? current : '';
}

function saveQuickPreset() {
  const input = document.getElementById('quick-preset-name');
  const select = document.getElementById('quick-preset-select');
  const name = (input?.value || select?.value || '').trim();
  if (!name) {
    showToast('Name your EQ preset first', 'warning');
    input?.focus();
    return;
  }

  const presets = getQuickPresets();
  const next = {
    name,
    updatedAt: new Date().toISOString(),
    config: snapshotCurrentConfig()
  };
  const idx = presets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) presets[idx] = next;
  else presets.push(next);

  setQuickPresets(presets);
  if (input) input.value = '';
  renderQuickPresetSelect();
  if (select) select.value = name;
  showToast(`Saved EQ preset: ${name}`, 'success');
}

function loadQuickPreset(name) {
  const preset = getQuickPresets().find(p => p.name === name);
  if (!preset?.config) return;
  pushUndo();
  applyConfigObject(preset.config);
  markDirty();
  showToast(`Loaded EQ preset: ${name}`, 'success');
}

function deleteQuickPreset() {
  const select = document.getElementById('quick-preset-select');
  const name = select?.value;
  if (!name) {
    showToast('Choose a preset to delete', 'warning');
    return;
  }
  setQuickPresets(getQuickPresets().filter(p => p.name !== name));
  renderQuickPresetSelect();
  showToast(`Deleted EQ preset: ${name}`, 'info');
}

// ═══════════════════════════════════════════════════════════
// AUTOEQ PANEL — modernGraphTool optimizer + Squiglink browser
// ═══════════════════════════════════════════════════════════
function initAutoEQPanel() {
  initAutoEQControls();
  initSquiglinkDBPanel();
}

function initAutoEQControls() {
  const btnRun = document.getElementById('btn-aeq-run');
  const statusEl = document.getElementById('aeq-status');
  if (!btnRun) return;

  const readOptions = () => {
    const num = (id, fb) => {
      const v = parseFloat(document.getElementById(id).value);
      return Number.isFinite(v) ? v : fb;
    };
    const normalizationMode = document.getElementById('aeq-normalization')?.value || 'auto';
    const freqMin = Math.max(20, Math.min(20000, num('aeq-freq-min', 20)));
    const freqMax = Math.max(freqMin + 1, Math.min(20000, num('aeq-freq-max', 16000)));
    const qMin = Math.max(0.1, Math.min(10, num('aeq-q-min', 0.4)));
    const qMax = Math.max(qMin, Math.min(10, num('aeq-q-max', 4.0)));
    const gainMin = Math.max(-40, Math.min(0, num('aeq-gain-min', -16)));
    const gainMax = Math.max(0, Math.min(40, num('aeq-gain-max', 16)));
    return {
      maxFilters: Math.max(1, Math.min(20, Math.round(num('aeq-max-filters', 10)))),
      freqRange: [freqMin, freqMax],
      qRange: [qMin, qMax],
      gainRange: [gainMin, gainMax],
      normalizationMode,
      smooth: document.getElementById('aeq-smooth-input')?.checked !== false,
      smoothingFraction: 12,
      useShelfFilter: document.getElementById('aeq-use-shelf-filter').checked,
    };
  };

  const gearFamilyFromMeta = (meta = {}) => {
    const type = String(meta.sourceType || '').trim().toLowerCase();
    if (!type) return '';
    if (type.includes('5128') || type.includes('b&k')) return '5128';
    if (type.includes('711') || type.includes('iem')) return '711';
    if (type.includes('headphone')) return 'headphones';
    if (type.includes('earbud')) return 'earbuds';
    if (type === 'generic' || type === 'unknown') return type;
    return type;
  };

  const resolveNormalization = (options) => {
    const requested = options.normalizationMode || 'auto';
    const measurementFamily = gearFamilyFromMeta(freqGraph.measurementMeta);
    const targetFamily = gearFamilyFromMeta(freqGraph.targetMeta);
    const mode = requested === 'auto'
      ? (measurementFamily === '5128' && targetFamily === '5128' ? 'midband' : 'ref')
      : requested;
    return {
      ...options,
      normalizationMode: mode,
      referenceFreq: 1000,
      alignmentRange: [300, 3000],
      measurementFamily,
      targetFamily,
    };
  };

  const alignmentLabel = (alignment) => {
    if (!alignment) return 'raw curves';
    if (alignment.mode === 'midband') {
      const [lo, hi] = alignment.range || [300, 3000];
      return `raw curves, midband aligned ${lo}-${hi} Hz`;
    }
    return 'raw curves, 1 kHz aligned';
  };

  const setStatus = (msg, type) => {
    if (!msg) { statusEl.style.display = 'none'; return; }
    statusEl.textContent = msg;
    statusEl.className = `aeq-status ${type || ''}`;
    statusEl.style.display = 'block';
  };

  const runOptimizer = async () => {
    if (!freqGraph.measurementData) {
      setStatus('Load a measurement from the Headphone Browser first.', 'error');
      showToast('Measurement not available for AutoEQ', 'warning');
      return;
    }
    const selectedTarget = freqGraph.targetData;
    if (!selectedTarget) {
      setStatus('Choose a target curve before running AutoEQ.', 'error');
      showToast('Target curve required for AutoEQ', 'warning');
      updateAutoEQButtonState();
      return;
    }
    const compatibility = freqGraph.getCurveCompatibility();
    if (!compatibility.ok) {
      setStatus(`Curve mismatch: ${compatibility.message}`, 'error');
      showToast(`AutoEQ blocked: ${compatibility.message}`, 'warning');
      updateAutoEQButtonState();
      return;
    }
    if (compatibility.warnings.length) {
      setStatus(`Warning: ${compatibility.warnings[0]}`, 'loading');
    }

    btnRun.disabled = true;
    if (!compatibility.warnings.length) setStatus('Optimizing raw curves...', 'loading');

    await new Promise(r => requestAnimationFrame(r));

    try {
      const autoEQOptions = resolveNormalization(readOptions());
      const measurementForAutoEQ = freqGraph.getRawMeasurementData();
      const baseTargetForAutoEQ = tcBaseTargetData?.freq?.length
        ? tcBaseTargetData
        : freqGraph.getRawTargetData();
      const targetForAutoEQ = applyTargetAdjustments(baseTargetForAutoEQ, tcState);
      const { filters, preamp, alignment } = runAutoEQ(
        measurementForAutoEQ,
        targetForAutoEQ,
        autoEQOptions
      );

      pushUndo();
      appState.config.filters = appState.config.filters.filter(f => f.isEffect);
      appState.config.filters = [...filters, ...appState.config.filters];
      if (document.getElementById('auto-preamp-enabled').checked) {
        appState.config.preamp = preamp;
      }

      parametricEQ.setFilters(appState.config.filters);
      freqGraph.setFilters(appState.config.filters);
      applyAutoPreamp();
      updateFilterCount();
      updateGraphLegend();
      markDirty();
      setStatus(`${filters.length} filter${filters.length === 1 ? '' : 's'} applied (${alignmentLabel(alignment)})`, 'success');
      showToast(`AutoEQ: ${filters.length} filters applied`, 'success');
      openEqualizer('parametric');
    } catch (err) {
      console.error('AutoEQ error:', err);
      setStatus(`Error: ${err.message}`, 'error');
      showToast(`AutoEQ failed: ${err.message}`, 'error');
    } finally {
      updateAutoEQButtonState();
    }
  };

  btnRun.addEventListener('click', runOptimizer);
}

// Enable/disable the main AutoEQ Run button whenever a measurement is loaded/cleared.
function updateAutoEQButtonState() {
  const btnRun = document.getElementById('btn-aeq-run');
  if (!btnRun) return;
  const hasMeasurement = !!freqGraph?.measurementData;
  const hasTarget = !!freqGraph?.targetData;
  const compatibility = hasMeasurement && hasTarget ? freqGraph.getCurveCompatibility() : null;
  btnRun.disabled = !hasMeasurement || !hasTarget || (compatibility && !compatibility.ok);
  btnRun.title = !hasMeasurement
    ? 'Load a headphone measurement first'
    : !hasTarget
      ? 'Choose a target curve first'
      : compatibility && !compatibility.ok
        ? `Curve mismatch: ${compatibility.message}`
        : compatibility?.warnings?.length
          ? `Warning: ${compatibility.warnings[0]}`
          : 'Generate parametric filters from measurement and target';
}

// ═══════════════════════════════════════════════════════════
// SQUIGLINK PANEL
// ═══════════════════════════════════════════════════════════
function initSquiglinkDBPanel() {
  const searchInput = document.getElementById('squig-search');
  const sigFilter   = document.getElementById('squig-sig-filter');
  const sourceFilter= document.getElementById('squig-source-filter');
  const resultsEl   = document.getElementById('squig-results');
  const dbBadge     = document.getElementById('squig-db-badge');
  const embedWrap   = document.getElementById('squig-embed-wrap');
  const iframe      = document.getElementById('squig-iframe');
  const selectedName= document.getElementById('squig-selected-name');
  const btnCloseEmbed= document.getElementById('btn-squig-close-embed');
  const btnCaptureTrace= document.getElementById('btn-squig-capture-trace');
  const measurementState = document.getElementById('squig-measurement-state');
  const browserDesc = document.querySelector('#panel-autoeq .border-left .col-desc');
  if (browserDesc) {
    browserDesc.textContent = 'Browse Squig databases from the live registry. Targets can be selected freely from reviewer sources in the target picker.';
  }
  
  let dbFull = [];
  let sourcesFull = [];
  let phoneMap = new Map(); // index → phone object for click handler
  let activePreviewPhone = null;
  
  // 1. Populate source filter after dynamic discovery from squig.link registry.
  const populateSourceFilter = (sources) => {
    // Preserve the blank "All sources" option already in the markup.
    const placeholder = sourceFilter.querySelector('option[value=""]');
    sourceFilter.innerHTML = '';
    if (placeholder) {
      placeholder.textContent = 'All reviewer sources';
      sourceFilter.appendChild(placeholder);
    }

    // Group DBs by rig type (5128 / IEMs / Headphones / Earbuds)
    const groups = new Map();
    for (const src of sources) {
      const key = src.type || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(src);
    }
    const order = ['5128', 'IEMs', 'Headphones', 'Earbuds'];
    const typeKeys = [...groups.keys()].sort(
      (a, b) => (order.indexOf(a) + 99) - (order.indexOf(b) + 99)
    );
    for (const typeKey of typeKeys) {
      const og = document.createElement('optgroup');
      og.label = typeKey;
      for (const src of groups.get(typeKey).sort((a, b) => a.name.localeCompare(b.name))) {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = `${src.icon} ${src.name}`;
        og.appendChild(opt);
      }
      sourceFilter.appendChild(og);
    }
  };

  // 2. Initial Load — discover all sources, then fetch every phone_book in parallel.
  resultsEl.innerHTML = '<div class="squig-db-loading">Discovering squiglink sites…</div>';
  dbBadge.textContent = 'Loading…';

  const onProgress = (done, total) => {
    resultsEl.innerHTML = `<div class="squig-db-loading">Loading databases… ${done}/${total}</div>`;
    dbBadge.textContent = `${done}/${total} sources`;
  };

  SquigDB.loadAllSources(null, onProgress).then(result => {
    dbFull = result.phones;
    sourcesFull = result.sources || [];
    populateSourceFilter(result.sources);
    const loaded = result.loadedSources;
    const total = result.totalSources;
    dbBadge.textContent = `${dbFull.length} items · ${loaded}/${total} sources`;
    renderResults();
    if (loaded < total) {
      showToast(`Loaded ${loaded}/${total} squiglink databases (${dbFull.length} items)`, 'warning');
    } else {
      showToast(`All ${total} squiglink databases loaded (${dbFull.length} items)`, 'success');
    }
  }).catch(err => {
    dbBadge.textContent = 'Error loading';
    resultsEl.innerHTML = `<div class="result-item"><span style="color:var(--red)">Failed to load DB: ${escapeHtml(err.message)}</span></div>`;
  });

  // 3. Render Results
  const renderResults = () => {
    const q = searchInput.value.toLowerCase().trim();
    const sig = sigFilter.value;
    const srcId = sourceFilter.value;
    
    let filtered = SquigDB.searchDB(dbFull, q, {
      sourceId: srcId || undefined,
      signature: sig || undefined,
    });
    
    if (filtered.length === 0) {
      resultsEl.innerHTML = '<div class="squig-db-loading">No matches</div>';
      phoneMap.clear();
      return;
    }

    phoneMap.clear();
    resultsEl.innerHTML = filtered.map((item, idx) => {
      phoneMap.set(idx, item);
      const sigColor = SquigDB.SIGNATURE_COLORS[item.signature] || '#888';
      let stars = '';
      if (item.reviewScore) {
        const full = Math.floor(item.reviewScore);
        for (let i = 0; i < 5; i++) stars += `<span class="squig-star ${i < full ? 'on' : ''}">★</span>`;
      }
      const variantsHint = item.files.length > 1 ? ` <span style="opacity:.5;font-size:11px">(${item.files.length} variants)</span>` : '';
      const sigBadge = item.signature
        ? `<span class="squig-sig-badge" style="color:${sigColor}">${escapeHtml(item.signature)}</span>`
        : '';
      return `
        <div class="squig-result-item" data-idx="${idx}">
          <div class="squig-sig-dot" style="background:${item.sourceColor}" title="${escapeHtml(item.sourceName)}"></div>
          <div class="squig-item-name">
            ${escapeHtml(item.name)}${variantsHint}
            <span class="squig-source-badge" style="background:${item.sourceColor}22;color:${item.sourceColor};border:1px solid ${item.sourceColor}44;font-size:10px;padding:1px 5px;border-radius:4px;margin-left:4px;">${item.sourceIcon} ${item.sourceName}</span>
            ${sigBadge}
          </div>
          <div class="squig-item-meta">
            <div class="squig-item-score">${stars}</div>
            <div class="squig-item-price">${escapeHtml(item.price || '')}</div>
          </div>
        </div>
      `;
    }).join('');
    
    // Add click listeners
    resultsEl.querySelectorAll('.squig-result-item').forEach(el => {
      el.addEventListener('click', () => {
        resultsEl.querySelectorAll('.squig-result-item').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        const phone = phoneMap.get(parseInt(el.dataset.idx));
        if (phone) openEmbed(phone);
      });
    });
  };

  searchInput.addEventListener('input', renderResults);
  sigFilter.addEventListener('change', renderResults);
  sourceFilter.addEventListener('change', () => {
    const src = sourcesFull.find(s => s.id === sourceFilter.value);
    if (src) publishSquigSourceSelection(src, 'browser-filter');
    renderResults();
  });

  // 4. Open Embed + Fetch Data
  const openEmbed = async (phone) => {
    activePreviewPhone = phone;
    resultsEl.style.display = 'none';
    embedWrap.style.display = 'flex';
    selectedName.textContent = `${phone.name} (${phone.sourceName})`;
    if (btnCaptureTrace) btnCaptureTrace.style.display = '';
    publishSquigSourceSelection(sourceFromPhone(phone), 'measurement');
    setMeasurementState('Loading measurement...', 'loading');
    
    // Load iframe from the correct source instance
    iframe.src = SquigDB.getEmbedUrl(phone);
    
    // Try to fetch raw measurement for AutoEQ
    try {
      const data = await SquigDB.fetchMeasurement(phone);
      if (data) {
        freqGraph.setMeasurementData(data, buildMeasurementMetaForPhone(phone));
        // Measurement is source-only; the target picker owns AutoEQ target state.
        setMeasurementState('Measurement loaded', 'ok');
        updateGraphLegend();
        updateAutoEQButtonState();
        if (freqGraph.targetData) {
          const compatibility = freqGraph.getCurveCompatibility();
          if (!compatibility.ok) setMeasurementState('Measurement loaded - target mismatch', 'warn');
        }
      } else {
        freqGraph.setMeasurementData(null);
        setMeasurementState('Data blocked - use Trace from Preview', 'error');
        updateGraphLegend();
        updateAutoEQButtonState();
      }
    } catch (e) {
      console.warn("Failed to fetch raw measurement data:", e);
      freqGraph.setMeasurementData(null);
      setMeasurementState('Data blocked - use Trace from Preview', 'error');
      updateAutoEQButtonState();
    }
  };

  btnCloseEmbed.addEventListener('click', () => {
    activePreviewPhone = null;
    embedWrap.style.display = 'none';
    resultsEl.style.display = 'flex';
    iframe.src = '';
    if (btnCaptureTrace) btnCaptureTrace.style.display = 'none';
    freqGraph.setMeasurementData(null);
    updateGraphLegend();
    updateAutoEQButtonState();
    resultsEl.querySelectorAll('.squig-result-item').forEach(x => x.classList.remove('selected'));
  });

  btnCaptureTrace?.addEventListener('click', async () => {
    if (!window.apoAPI?.captureRegionImage) {
      showToast('Preview capture requires the desktop app', 'warning');
      return;
    }
    const name = selectedName.textContent || 'squig-preview';
    btnCaptureTrace.disabled = true;
    try {
      if (!activePreviewPhone) throw new Error('no preview gear is selected');
      if (!iframe.src) throw new Error('preview is not loaded yet');
      iframe.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = iframe.getBoundingClientRect();
      if (rect.width < 64 || rect.height < 64) throw new Error('preview area is too small to capture');
      const result = await window.apoAPI.captureRegionImage({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      }, { name });
      if (!result?.success) throw new Error(result?.error || 'capture failed');
      lastTraceCaptureContext = buildMeasurementMetaForPhone(activePreviewPhone, {
        source: 'trace',
        label: 'Trace Measurement',
        color: '#38bdf8',
        width: 2.2,
      });
      showTraceCapture(result, name);
      document.querySelector('[data-tab="trace"]')?.click();
      showToast('Preview captured, copied to clipboard, and ready for FR Tracer', 'success');
    } catch (err) {
      showToast(`Preview capture failed: ${err.message}`, 'error');
    } finally {
      btnCaptureTrace.disabled = false;
    }
  });

  function setMeasurementState(text, type = '') {
    if (!measurementState) return;
    measurementState.textContent = text;
    measurementState.className = `data-ready-pill ${type}`;
  }
}

// ═══════════════════════════════════════════════════════════
// FR TRACER PANEL (UsyTrace)
// ═══════════════════════════════════════════════════════════
function showTraceCapture(result, label = 'Squig preview') {
  const box = document.getElementById('trace-capture-info');
  const meta = document.getElementById('trace-capture-meta');
  const preview = document.getElementById('trace-capture-preview');
  if (!box || !meta || !preview) return;

  box.style.display = 'block';
  preview.src = result.dataUrl || '';
  meta.textContent = `${label} saved to ${result.path}. The image is also copied to clipboard.`;
}

const USYTRACE_URL = 'https://usyless.uk/trace';

function describeTraceData(parsed) {
  const minF = Math.round(Math.min(...parsed.freq));
  const maxF = Math.round(Math.max(...parsed.freq));
  return {
    minF,
    maxF,
    html: `Points: <strong>${parsed.freq.length}</strong><br>Range: <strong>${minF}</strong>Hz - <strong>${maxF}</strong>Hz`
  };
}

function initTracePanel() {
  const btnImport = document.getElementById('btn-import-trace');
  const btnToEQ   = document.getElementById('btn-trace-to-eq');
  const btnClear  = document.getElementById('btn-trace-clear');
  const btnReload = document.getElementById('btn-trace-reload');
  const btnOpenExternal = document.getElementById('btn-trace-open-external');
  const statBox   = document.getElementById('trace-stat');
  const infoBox   = document.getElementById('trace-data-info');
  const traceKind = document.getElementById('trace-data-kind');
  const traceFrame = document.getElementById('usytrace-frame');
  const frameStatus = document.getElementById('trace-frame-status');
  
  let traceData = null;
  let traceLoadTimer = null;

  const setFrameStatus = (title, detail, type = '') => {
    if (!frameStatus) return;
    frameStatus.className = `trace-frame-status ${type}`.trim();
    frameStatus.innerHTML = `
      <div class="trace-frame-status-card">
        <strong>${title}</strong>
        <span>${detail}</span>
      </div>
    `;
  };

  const hideFrameStatus = () => {
    if (frameStatus) frameStatus.classList.add('hidden');
  };

  const loadUsyTrace = () => {
    if (!traceFrame) return;
    if (traceLoadTimer) clearTimeout(traceLoadTimer);
    frameStatus?.classList.remove('hidden');
    setFrameStatus('Loading UsyTrace...', 'If the embedded tracer stays blank, use Open UsyTrace in Browser.', 'loading');
    traceFrame.src = `${USYTRACE_URL}?t=${Date.now()}`;
    traceLoadTimer = setTimeout(() => {
      setFrameStatus('UsyTrace may be blocked inside the app', 'Click Reload UsyTrace, or open it in your browser and import the exported trace here.', 'error');
    }, 12000);
  };

  traceFrame?.addEventListener('load', () => {
    if (traceLoadTimer) clearTimeout(traceLoadTimer);
    setFrameStatus('UsyTrace loaded', 'Load or paste your captured graph image inside the tracer.', 'ok');
    setTimeout(hideFrameStatus, 1200);
  });

  traceFrame?.addEventListener('error', () => {
    if (traceLoadTimer) clearTimeout(traceLoadTimer);
    setFrameStatus('UsyTrace failed to load', 'Open it in your browser, export the trace, then import the .txt here.', 'error');
  });

  btnReload?.addEventListener('click', () => {
    loadUsyTrace();
    showToast('Reloading UsyTrace', 'info');
  });

  btnOpenExternal?.addEventListener('click', async () => {
    const result = await window.apoAPI?.openExternalUrl?.(USYTRACE_URL);
    if (result?.success) {
      showToast('UsyTrace opened in your browser', 'success');
    } else {
      showToast(`Could not open browser: ${result?.error || 'unknown error'}`, 'error');
    }
  });

  loadUsyTrace();

  const setTraceAsMeasurement = (parsed) => {
    const dataKind = traceKind?.value || 'raw';
    const context = lastTraceCaptureContext || {};
    freqGraph.setMeasurementData(parsed, {
      ...context,
      source: 'trace',
      label: dataKind === 'raw' ? 'Trace Measurement' : 'Trace (Compensated)',
      color: '#38bdf8',
      width: 2.2,
      dataKind,
    });
  };

  const applyTraceMeasurement = (parsed) => {
    traceData = parsed;
    setTraceAsMeasurement(traceData);
    updateGraphLegend();
    updateAutoEQButtonState();

    btnToEQ.disabled = false;
    btnClear.disabled = false;
    infoBox.style.display = 'block';
    statBox.innerHTML = describeTraceData(parsed).html;
  };

  traceKind?.addEventListener('change', () => {
    if (!traceData) return;
    setTraceAsMeasurement(traceData);
    updateGraphLegend();
    updateAutoEQButtonState();
  });

  btnImport.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.csv,.tsv,.frd,text/plain,text/csv';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (re) => {
        const parsed = SquigDB.parseMeasurementText(re.target.result);
        if (parsed && parsed.freq.length > 5) {
          applyTraceMeasurement(parsed);
          showToast('Trace imported successfully', 'success');
        } else {
          showToast('Invalid trace file format', 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });

  btnClear.addEventListener('click', () => {
    traceData = null;
    freqGraph.setMeasurementData(null);
    updateGraphLegend();
    updateAutoEQButtonState();
    btnToEQ.disabled = true;
    btnClear.disabled = true;
    infoBox.style.display = 'none';
  });

  btnToEQ.addEventListener('click', () => {
    if (!traceData) {
      showToast('Import a UsyTrace export first', 'warning');
      return;
    }
    setTraceAsMeasurement(traceData);
    updateGraphLegend();
    document.querySelector('[data-tab="autoeq"]')?.click();
    updateAutoEQButtonState();
    showToast(
      freqGraph.targetData
        ? 'Trace loaded as measurement. Press Run AutoEQ to generate filters.'
        : 'Trace loaded. Choose a target before running AutoEQ.',
      freqGraph.targetData ? 'info' : 'warning'
    );
  });
}

// ═══════════════════════════════════════════════════════════
// TOOLS PANEL
// ═══════════════════════════════════════════════════════════
function initToolsPanel() {
  initConvolution();
  initVSTPlugins();
  initLoudnessCorrection();
  initChannelRouting();
  initDelay();
  initEffects();
}

function initConvolution() {
  document.getElementById('btn-browse-ir')?.addEventListener('click', async () => {
    const file = await selectFile({ filters: [{ name: 'Audio', extensions: ['wav','flac','ogg'] }] });
    if (file) setConvolutionFile(file);
  });
  document.getElementById('ir-drop-zone')?.addEventListener('click', async () => {
    const file = await selectFile({ filters: [{ name: 'Audio', extensions: ['wav','flac','ogg'] }] });
    if (file) setConvolutionFile(file);
  });
  document.getElementById('btn-remove-ir')?.addEventListener('click', () => {
    appState.config.convolution = null;
    document.getElementById('ir-drop-zone').style.display = '';
    document.getElementById('ir-file-info').style.display = 'none';
    markDirty();
  });
  document.getElementById('ir-enabled')?.addEventListener('change', (e) => {
    if (appState.config.convolution) { appState.config.convolution.enabled = e.target.checked; markDirty(); }
  });
}

function setConvolutionFile(filePath) {
  const fileName = filePath.split(/[/\\]/).pop();
  appState.config.convolution = { file: filePath, enabled: true };
  document.getElementById('ir-drop-zone').style.display = 'none';
  document.getElementById('ir-file-info').style.display = '';
  document.getElementById('ir-filename').textContent = fileName;
  document.getElementById('ir-filepath').textContent  = filePath;
  document.getElementById('ir-enabled').checked = true;
  markDirty();
}

function initVSTPlugins() {
  document.getElementById('btn-add-vst')?.addEventListener('click', () => {
    if (!Array.isArray(appState.config.vstPlugins)) appState.config.vstPlugins = [];
    appState.config.vstPlugins.push({ library: '', parameters: '', enabled: true });
    renderVSTPlugins();
    markDirty();
  });
}

function renderVSTPlugins() {
  const container = document.getElementById('vst-plugin-list');
  if (!container) return;

  const plugins = Array.isArray(appState.config.vstPlugins) ? appState.config.vstPlugins : [];
  container.closest('.vst-tool-card')?.classList.toggle('has-vst-plugins', plugins.length > 0);
  container.innerHTML = '';

  if (plugins.length === 0) {
    container.innerHTML = '<div class="tool-empty">No VST plugins configured</div>';
    return;
  }

  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i];
    const row = document.createElement('div');
    row.className = 'vst-plugin-row';
    row.innerHTML = `
      <div class="vst-plugin-top">
        <div class="vst-plugin-name">Plugin ${i + 1}</div>
        <label class="toggle-label vst-enable">
          <input type="checkbox" ${plugin.enabled === false ? '' : 'checked'}>
          <span class="toggle-switch"></span>
          Active
        </label>
      </div>
      <label class="vst-field-label" for="vst-library-${i}">DLL path</label>
      <div class="vst-plugin-path-row">
        <input id="vst-library-${i}" type="text" class="filter-input vst-library" value="${escapeHtml(plugin.library || '')}" placeholder="C:\\VSTPlugins\\effect.dll">
        <button class="btn-ghost vst-browse" type="button">Browse</button>
      </div>
      <label class="vst-field-label" for="vst-parameters-${i}">Parameters</label>
      <textarea id="vst-parameters-${i}" class="filter-input vst-parameters" spellcheck="false" placeholder='Optional APO parameters, e.g. ChunkData "..."'>${escapeHtml(plugin.parameters || '')}</textarea>
      <button class="btn-ghost danger-soft vst-remove" type="button">Remove Plugin</button>
    `;

    row.querySelector('.vst-enable input').addEventListener('change', e => {
      plugin.enabled = e.target.checked;
      markDirty();
    });
    row.querySelector('.vst-library').addEventListener('input', e => {
      plugin.library = e.target.value;
      markDirty();
    });
    row.querySelector('.vst-parameters').addEventListener('input', e => {
      plugin.parameters = e.target.value;
      markDirty();
    });
    row.querySelector('.vst-browse').addEventListener('click', async () => {
      const file = await selectFile({
        filters: [
          { name: 'VST Plugins', extensions: ['dll'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (!file) return;
      plugin.library = file;
      renderVSTPlugins();
      markDirty();
    });
    row.querySelector('.vst-remove').addEventListener('click', () => {
      plugins.splice(i, 1);
      renderVSTPlugins();
      markDirty();
    });

    container.appendChild(row);
  }
}

function initLoudnessCorrection() {
  document.getElementById('loudness-enabled')?.addEventListener('change', e => {
    const loudness = ensureLoudnessCorrection(e.target.checked);
    loudness.enabled = e.target.checked;
    renderLoudnessCorrection();
    markDirty();
  });

  ['loud-ref-level', 'loud-ref-offset'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      updateLoudnessFromInputs();
    });
  });

  document.getElementById('loud-attenuation-range')?.addEventListener('input', e => {
    setLoudnessAttenuation(e.target.value);
  });
  document.getElementById('loud-attenuation')?.addEventListener('input', e => {
    setLoudnessAttenuation(e.target.value);
  });
  document.getElementById('btn-reset-loudness')?.addEventListener('click', () => {
    appState.config.loudnessCorrection = {
      enabled: true,
      referenceLevel: 75,
      referenceOffset: 0,
      attenuation: 1
    };
    renderLoudnessCorrection();
    markDirty();
  });
}

function ensureLoudnessCorrection(enabled = true) {
  if (!appState.config.loudnessCorrection) {
    appState.config.loudnessCorrection = {
      enabled,
      referenceLevel: parseInt(document.getElementById('loud-ref-level')?.value || '75', 10),
      referenceOffset: parseInt(document.getElementById('loud-ref-offset')?.value || '0', 10),
      attenuation: clamp(parseFloat(document.getElementById('loud-attenuation')?.value || '1'), 0, 1)
    };
  }
  return appState.config.loudnessCorrection;
}

function updateLoudnessFromInputs() {
  const enabled = document.getElementById('loudness-enabled')?.checked ?? true;
  const loudness = ensureLoudnessCorrection(enabled);
  loudness.enabled = enabled;
  loudness.referenceLevel = parseInt(document.getElementById('loud-ref-level')?.value || '75', 10) || 0;
  loudness.referenceOffset = parseInt(document.getElementById('loud-ref-offset')?.value || '0', 10) || 0;
  loudness.attenuation = clamp(parseFloat(document.getElementById('loud-attenuation')?.value || '1'), 0, 1);
  renderLoudnessCorrection();
  markDirty();
}

function setLoudnessAttenuation(value) {
  const enabled = document.getElementById('loudness-enabled')?.checked ?? true;
  const loudness = ensureLoudnessCorrection(enabled);
  loudness.enabled = enabled;
  loudness.attenuation = clamp(parseFloat(value), 0, 1);
  renderLoudnessCorrection();
  markDirty();
}

function renderLoudnessCorrection() {
  const loudness = appState.config.loudnessCorrection || {
    enabled: false,
    referenceLevel: 75,
    referenceOffset: 0,
    attenuation: 1
  };
  const attenuation = clamp(Number(loudness.attenuation), 0, 1);

  const enabledEl = document.getElementById('loudness-enabled');
  const refLevelEl = document.getElementById('loud-ref-level');
  const refOffsetEl = document.getElementById('loud-ref-offset');
  const attenRangeEl = document.getElementById('loud-attenuation-range');
  const attenEl = document.getElementById('loud-attenuation');
  const attenValueEl = document.getElementById('loud-attenuation-value');

  if (enabledEl) enabledEl.checked = loudness.enabled === true;
  if (refLevelEl) refLevelEl.value = Number.isFinite(Number(loudness.referenceLevel)) ? loudness.referenceLevel : 75;
  if (refOffsetEl) refOffsetEl.value = Number.isFinite(Number(loudness.referenceOffset)) ? loudness.referenceOffset : 0;
  if (attenRangeEl) attenRangeEl.value = attenuation;
  if (attenEl) attenEl.value = attenuation;
  if (attenValueEl) attenValueEl.textContent = attenuation.toFixed(2);
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return max;
  return Math.min(max, Math.max(min, num));
}

function initChannelRouting() {
  document.querySelectorAll('#channel-buttons .ch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = btn.dataset.channel;
      if (ch === 'all') {
        document.querySelectorAll('#channel-buttons .ch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        appState.config.channels = 'all';
      } else {
        document.querySelector('#channel-buttons .ch-btn[data-channel="all"]').classList.remove('active');
        btn.classList.toggle('active');
        const active = [...document.querySelectorAll('#channel-buttons .ch-btn.active:not([data-channel="all"])')].map(b => b.dataset.channel);
        appState.config.channels = active.length > 0 ? active.join(' ') : 'all';
        if (active.length === 0) document.querySelector('#channel-buttons .ch-btn[data-channel="all"]').classList.add('active');
      }
      markDirty();
    });
  });

  document.getElementById('btn-add-copy')?.addEventListener('click', () => {
    appState.config.copies.push({ target: 'L', expression: 'R', enabled: true });
    renderCopyRoutes();
    markDirty();
  });
}

function renderCopyRoutes() {
  const container = document.getElementById('copy-routes-list');
  container.innerHTML = '';
  if (appState.config.copies.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">No routes defined</div>';
    return;
  }
  for (let i = 0; i < appState.config.copies.length; i++) {
    const copy = appState.config.copies[i];
    const row = document.createElement('div');
    row.className = 'copy-route-row';
    row.innerHTML = `
      <input type="text" class="filter-input" style="width:55px;" value="${copy.target}" placeholder="Target">
      <span class="copy-eq">=</span>
      <input type="text" class="filter-input" style="flex:1;" value="${copy.expression}" placeholder="Expression (e.g. L+0.5*R)">
      <button class="filter-delete" title="Remove">✕</button>
    `;
    row.querySelectorAll('.filter-input')[0].addEventListener('input', e => { copy.target = e.target.value; markDirty(); });
    row.querySelectorAll('.filter-input')[1].addEventListener('input', e => { copy.expression = e.target.value; markDirty(); });
    row.querySelector('.filter-delete').addEventListener('click', () => {
      appState.config.copies.splice(i, 1); renderCopyRoutes(); markDirty();
    });
    container.appendChild(row);
  }
}

function initDelay() {
  document.getElementById('btn-add-delay')?.addEventListener('click', () => {
    appState.config.delays.push({ value: 0, unit: 'ms', enabled: true });
    renderDelays();
    markDirty();
  });
}

function renderDelays() {
  const container = document.getElementById('delay-list');
  container.innerHTML = '';
  if (appState.config.delays.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">No delays configured</div>';
    return;
  }
  for (let i = 0; i < appState.config.delays.length; i++) {
    const delay = appState.config.delays[i];
    const row = document.createElement('div');
    row.className = 'delay-row';
    row.innerHTML = `
      <input type="number" class="filter-input" style="flex:1;" value="${delay.value}" min="0" step="0.1" placeholder="Value">
      <select class="select-sm" style="width:85px;">
        <option value="ms" ${delay.unit === 'ms' ? 'selected' : ''}>ms</option>
        <option value="samples" ${delay.unit === 'samples' ? 'selected' : ''}>samples</option>
      </select>
      <button class="filter-delete" title="Remove">✕</button>
    `;
    row.querySelector('input').addEventListener('input', e => { delay.value = parseFloat(e.target.value)||0; markDirty(); });
    row.querySelector('select').addEventListener('change', e => { delay.unit = e.target.value; markDirty(); });
    row.querySelector('.filter-delete').addEventListener('click', () => {
      appState.config.delays.splice(i, 1); renderDelays(); markDirty();
    });
    container.appendChild(row);
  }
}

function initEffects() {
  const update = () => {
    const bass    = parseFloat(document.getElementById('effect-bass').value);
    const treble  = parseFloat(document.getElementById('effect-treble').value);
    const balance = parseInt(document.getElementById('effect-balance').value);
    const xfeed   = document.getElementById('effect-crossfeed-enabled').checked;

    document.getElementById('effect-bass-val').textContent    = `${bass >= 0 ? '+' : ''}${bass.toFixed(1)} dB`;
    document.getElementById('effect-treble-val').textContent  = `${treble >= 0 ? '+' : ''}${treble.toFixed(1)} dB`;
    document.getElementById('effect-balance-val').textContent = balance === 0 ? 'Center' : balance < 0 ? `L${Math.abs(balance)}` : `R${balance}`;

    appState.config.filters = appState.config.filters.filter(f => !f.isEffect);
    if (bass   !== 0) appState.config.filters.push({ isEffect:true, enabled:true, type:'LSC', frequency:105, gain:bass, q:0.71 });
    if (treble !== 0) appState.config.filters.push({ isEffect:true, enabled:true, type:'HSC', frequency:10000, gain:treble, q:0.71 });

    appState.config.copies = appState.config.copies.filter(c => !c.isEffect);
    if (xfeed) {
      appState.config.copies.push({ isEffect:true, enabled:true, target:'L', expression:'L+0.2*R' });
      appState.config.copies.push({ isEffect:true, enabled:true, target:'R', expression:'R+0.2*L' });
    }
    if (balance !== 0) {
      const lG = balance > 0 ? (100-balance)/100 : 1;
      const rG = balance < 0 ? (100+balance)/100 : 1;
      appState.config.copies.push({ isEffect:true, enabled:true, target:'L', expression:`${lG}*L` });
      appState.config.copies.push({ isEffect:true, enabled:true, target:'R', expression:`${rG}*R` });
    }

    refreshUI();
    markDirty();
  };

  ['effect-bass','effect-treble','effect-balance'].forEach(id => {
    document.getElementById(id).addEventListener('input', update);
  });
  document.getElementById('effect-crossfeed-enabled').addEventListener('change', update);
}

// ═══════════════════════════════════════════════════════════
// ADVANCED PANEL
// ═══════════════════════════════════════════════════════════
function initAdvancedPanel() {
  // Stage
  document.querySelectorAll('.stage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stage-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      appState.config.stage = btn.dataset.stage;
      markDirty();
    });
  });

  // Presets
  document.getElementById('btn-save-new-preset').addEventListener('click', async () => {
    const name = document.getElementById('preset-name-input').value.trim();
    if (!name) return;
    if (window.apoAPI) {
      await window.apoAPI.savePreset(name, serializeConfig(appState.config));
      loadPresetsList();
      document.getElementById('preset-name-input').value = '';
      showToast('Preset saved', 'success');
    } else {
      showToast('Presets require APO connection', 'warning');
    }
  });
  if (window.apoAPI) loadPresetsList();

  document.getElementById('btn-import-squig-eq')?.addEventListener('click', () => importAdvancedEQ('squig'));
  document.getElementById('btn-import-wavelet-eq')?.addEventListener('click', () => importAdvancedEQ('wavelet'));
  document.getElementById('btn-export-squig-eq')?.addEventListener('click', () => exportAdvancedEQ('squig'));
  document.getElementById('btn-export-wavelet-eq')?.addEventListener('click', () => exportAdvancedEQ('wavelet'));

  // Include
  document.getElementById('btn-add-include')?.addEventListener('click', async () => {
    const file = await selectFile({ filters: [{ name: 'Config', extensions: ['txt','cfg'] }] });
    if (file) { appState.config.includes.push({ file, enabled: true }); renderIncludes(); markDirty(); }
  });

  // Raw editor
  document.getElementById('btn-parse-raw')?.addEventListener('click', () => {
    const raw = document.getElementById('raw-config-editor').value;
    if (raw.trim()) { loadConfigFromText(raw); showToast('Parsed to GUI', 'success'); }
  });
  document.getElementById('btn-apply-raw')?.addEventListener('click', () => {
    writeConfig(document.getElementById('raw-config-editor').value);
  });
}

async function loadPresetsList() {
  const container = document.getElementById('preset-list');
  if (!window.apoAPI) { container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">Requires APO</div>'; return; }
  const presets = await window.apoAPI.getPresets();
  if (presets.length === 0) { container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">No presets saved</div>'; return; }
  container.innerHTML = presets.map(p => `
    <div class="preset-row">
      <span>${escapeHtml(p.name.replace('.txt',''))}</span>
      <div style="display:flex;gap:4px;">
        <button class="btn-ghost" style="padding:3px 8px;font-size:11px;" onclick="window.applyPreset('${p.name}')">Load</button>
        <button class="btn-ghost" style="padding:3px 8px;font-size:11px;" onclick="window.deletePreset('${p.name}')">Del</button>
      </div>
    </div>
  `).join('');
}

window.applyPreset = async (filename) => {
  if (!window.apoAPI) return;
  const content = await window.apoAPI.readPreset(filename);
  if (content) { loadConfigFromText(content); showToast('Preset loaded', 'success'); }
};
window.deletePreset = async (filename) => {
  if (!window.apoAPI) return;
  await window.apoAPI.deletePreset(filename);
  loadPresetsList();
};

function renderIncludes() {
  const container = document.getElementById('include-list');
  container.innerHTML = '';
  for (let i = 0; i < appState.config.includes.length; i++) {
    const inc = appState.config.includes[i];
    const row = document.createElement('div');
    row.className = 'include-row';
    row.innerHTML = `
      <label class="toggle-label">
        <input type="checkbox" ${inc.enabled ? 'checked' : ''}>
        <span class="toggle-switch"></span>
      </label>
      <span class="include-path" title="${inc.file}">${inc.file}</span>
      <button class="filter-delete" title="Remove">✕</button>
    `;
    row.querySelector('input').addEventListener('change', e => { inc.enabled = e.target.checked; markDirty(); });
    row.querySelector('.filter-delete').addEventListener('click', () => {
      appState.config.includes.splice(i, 1); renderIncludes(); markDirty();
    });
    container.appendChild(row);
  }
}

// ═══════════════════════════════════════════════════════════
// APO DETECTION
// ═══════════════════════════════════════════════════════════
async function detectAPO() {
  try {
    if (window.apoAPI) {
      const apoPath = await window.apoAPI.getAPOPath();
      if (apoPath) {
        appState.apoPath = apoPath;
        document.getElementById('config-path-text').textContent = apoPath;
        updateStatus('APO detected');
        const result = await window.apoAPI.readConfig();
        if (result.content) {
          appState.configPath = result.path;
          loadConfigFromText(result.content);
          showToast('Config loaded from APO', 'success');
        }
      } else {
        document.getElementById('config-path-text').textContent = 'APO not found — click to set';
        updateStatus('APO not found', true);
      }
    } else {
      document.getElementById('config-path-text').textContent = 'Browser mode';
      updateStatus('Dev mode');
      loadDemoConfig();
    }
  } catch (e) {
    console.error('Failed to detect APO:', e);
    updateStatus('Error', true);
  }
}

async function changeConfigPath() {
  if (!window.apoAPI) return;
  const dir = await window.apoAPI.selectConfigDir();
  if (dir) {
    appState.apoPath = dir;
    document.getElementById('config-path-text').textContent = dir;
    const result = await window.apoAPI.readConfig(dir + '\\config.txt');
    if (result.content) { appState.configPath = result.path; loadConfigFromText(result.content); }
  }
}

// ═══════════════════════════════════════════════════════════
// CONFIG LOADING
// ═══════════════════════════════════════════════════════════
function loadConfigFromText(text) {
  const config = parseConfig(text);
  applyConfigObject(config, text);
}

function applyConfigObject(config, rawText = null) {
  isApplyingConfig = true;
  appState.config = {
    ...createDefaultConfig(),
    ...config,
    filters: Array.isArray(config.filters) ? config.filters : [],
    graphicEQ: config.graphicEQ || null,
    vstPlugins: Array.isArray(config.vstPlugins) ? config.vstPlugins : [],
    loudnessCorrection: config.loudnessCorrection || null
  };

  try {
    parametricEQ.setFilters(appState.config.filters);
    freqGraph.setFilters(appState.config.filters);
    freqGraph.setPreamp(appState.config.preamp || 0);

    const slider = document.getElementById('preamp-slider');
    slider.value = appState.config.preamp || 0;
    document.getElementById('preamp-value').textContent =
      `${(appState.config.preamp||0) >= 0 ? '+' : ''}${(appState.config.preamp||0).toFixed(1)} dB`;

    if (appState.config.graphicEQ) {
      graphicEQ.setBands(appState.config.graphicEQ.bands, appState.config.graphicEQ.enabled);
      freqGraph.setGraphicEQ(graphicEQ.getConfig());
    } else {
      graphicEQ.reset();
      graphicEQ.setEnabled(true);
      freqGraph.setGraphicEQ(null);
    }
    syncGraphicEQControls();
  } finally {
    isApplyingConfig = false;
  }

  if (appState.config.convolution) setConvolutionFile(appState.config.convolution.file);

  // Channel selection
  if (appState.config.channels && appState.config.channels !== 'all') {
    const chs = appState.config.channels.split(/\s+/);
    document.querySelectorAll('#channel-buttons .ch-btn').forEach(btn => {
      btn.classList.toggle('active', chs.includes(btn.dataset.channel));
    });
  }

  // Stage
  document.querySelectorAll('.stage-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.stage === appState.config.stage);
  });

  renderIncludes();
  renderCopyRoutes();
  renderDelays();
  renderVSTPlugins();
  renderLoudnessCorrection();
  renderDeviceSelector(appState.config.device || 'all');

  document.getElementById('raw-config-editor').value = rawText || serializeConfig(appState.config);

  // Expression editor
  const exprParts = [];
  for (const c of appState.config.conditionals || []) {
    if (c.type === 'if') exprParts.push(`If: ${c.expr}`);
    else if (c.type === 'elseif') exprParts.push(`ElseIf: ${c.expr}`);
    else if (c.type === 'else') exprParts.push('Else:');
    else if (c.type === 'endif') exprParts.push('EndIf:');
  }
  for (const ev of appState.config.evals || []) exprParts.push(`Eval: ${ev.expr}`);
  if (exprParts.length) document.getElementById('expr-editor').value = exprParts.join('\n');

  updateGraphLegend();
  updateFilterCount();
  appState.dirty = false;
}

function loadDemoConfig() {
  loadConfigFromText([
    '# Neon Equalizer Demo',
    'Preamp: -3.0 dB',
    'Filter 1: ON PK Fc 60 Hz Gain 4.0 dB Q 1.200',
    'Filter 2: ON PK Fc 250 Hz Gain -2.5 dB Q 1.800',
    'Filter 3: ON PK Fc 1000 Hz Gain 1.5 dB Q 2.000',
    'Filter 4: ON PK Fc 4000 Hz Gain -1.0 dB Q 1.500',
    'Filter 5: ON HS Fc 8000 Hz Gain 3.0 dB Q 0.707',
    'Filter 6: ON HP Fc 30 Hz',
  ].join('\n'));
}

// ═══════════════════════════════════════════════════════════
// CONFIG I/O
// ═══════════════════════════════════════════════════════════
async function saveConfig(options = {}) {
  const { silent = false, skipUndo = false } = options;
  if (!skipUndo) pushUndo();
  const text = serializeConfig(appState.config);
  const rawEditor = document.getElementById('raw-config-editor');
  if (rawEditor) rawEditor.value = text;
  if (window.apoAPI) {
    const result = await window.apoAPI.writeConfig(appState.configPath, text);
    if (result.success) {
      if (result.path) appState.configPath = result.path;
      appState.dirty = false;
      updateStatus(silent ? 'Auto-applied to APO' : 'Saved');
      if (!silent) showToast('Saved to APO', 'success');
    } else {
      updateStatus(silent ? 'Auto-apply failed' : 'Save failed', true);
      if (!silent) showToast(`Save failed: ${result.error}`, 'error');
    }
  } else {
    if (!silent) showToast('Config generated (browser mode)', 'info');
  }
}

async function writeConfig(text) {
  if (window.apoAPI) {
    const r = await window.apoAPI.writeConfig(appState.configPath, text);
    r.success ? showToast('Applied', 'success') : showToast(`Failed: ${r.error}`, 'error');
  } else {
    showToast('Cannot write in browser mode', 'warning');
  }
}

async function importConfig() {
  if (!window.apoAPI) return;
  const file = await window.apoAPI.selectFile({ filters: [{ name: 'Config', extensions: ['txt','cfg'] }] });
  if (file) {
    const r = await window.apoAPI.readConfig(file);
    if (r.content) { pushUndo(); loadConfigFromText(r.content); showToast('Imported', 'success'); }
  }
}

async function exportConfig() {
  const text = serializeConfig(appState.config);
  try {
    await navigator.clipboard.writeText(text);
    showToast('Config copied to clipboard', 'success');
  } catch {
    document.getElementById('raw-config-editor').value = text;
    document.querySelector('[data-tab="advanced"]').click();
    showToast('Config in Raw Editor', 'info');
  }
}

async function selectFile(options) {
  return window.apoAPI ? await window.apoAPI.selectFile(options) : null;
}

// ═══════════════════════════════════════════════════════════
// UNDO / REDO
// ═══════════════════════════════════════════════════════════
function pushUndo() {
  appState.undoStack.push(JSON.stringify(appState.config));
  if (appState.undoStack.length > 50) appState.undoStack.shift();
  appState.redoStack = [];
}
function undo() {
  if (!appState.undoStack.length) return;
  appState.redoStack.push(JSON.stringify(appState.config));
  appState.config = JSON.parse(appState.undoStack.pop());
  refreshUI();
  showToast('Undo', 'info');
}
function redo() {
  if (!appState.redoStack.length) return;
  appState.undoStack.push(JSON.stringify(appState.config));
  appState.config = JSON.parse(appState.redoStack.pop());
  refreshUI();
  showToast('Redo', 'info');
}

// ═══════════════════════════════════════════════════════════
// AUTO PREAMP
// ═══════════════════════════════════════════════════════════
function applyAutoPreamp() {
  if (!document.getElementById('auto-preamp-enabled').checked) return;
  const peak = freqGraph.getPeakGain ? freqGraph.getPeakGain() : 0;
  const preamp = peak > 0 ? parseFloat((-peak).toFixed(1)) : 0;
  appState.config.preamp = preamp;
  document.getElementById('preamp-slider').value = preamp;
  document.getElementById('preamp-value').textContent =
    `${preamp >= 0 ? '+' : ''}${preamp.toFixed(1)} dB`;
  freqGraph.setPreamp(preamp);
}

// ═══════════════════════════════════════════════════════════
// REFRESH UI
// ═══════════════════════════════════════════════════════════
function refreshUI() {
  parametricEQ.setFilters(appState.config.filters);
  freqGraph.setFilters(appState.config.filters);
  freqGraph.setPreamp(appState.config.preamp || 0);
  updateGraphLegend();
  renderDeviceSelector(appState.config.device || 'all');

  document.getElementById('preamp-slider').value = appState.config.preamp || 0;
  document.getElementById('preamp-value').textContent =
    `${(appState.config.preamp||0) >= 0 ? '+' : ''}${(appState.config.preamp||0).toFixed(1)} dB`;

  if (appState.config.graphicEQ) {
    graphicEQ.setBands(appState.config.graphicEQ.bands, appState.config.graphicEQ.enabled);
    freqGraph.setGraphicEQ(graphicEQ.getConfig());
  } else {
    freqGraph.setGraphicEQ(null);
  }
  syncGraphicEQControls();
  renderCopyRoutes();
  renderDelays();
  renderVSTPlugins();
  renderLoudnessCorrection();
  renderIncludes();
  updateFilterCount();
  updateRawConfigEditor();
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════
function markDirty() {
  appState.dirty = true;
  if (getAutoSaveAPOEnabled()) {
    scheduleAutoApply();
  } else {
    if (autoApplyTimer) {
      clearTimeout(autoApplyTimer);
      autoApplyTimer = null;
    }
    updateStatus('Unsaved changes');
  }
}

function updateRawConfigEditor() {
  const editor = document.getElementById('raw-config-editor');
  if (editor) editor.value = serializeConfig(appState.config);
}

function scheduleAutoApply() {
  if (isApplyingConfig) return;
  if (!getAutoSaveAPOEnabled()) return;
  if (autoApplyTimer) clearTimeout(autoApplyTimer);
  autoApplyTimer = setTimeout(() => {
    autoApplyTimer = null;
    autoApplyConfig();
  }, AUTO_APPLY_DELAY_MS);
}

async function autoApplyConfig() {
  if (!getAutoSaveAPOEnabled()) return;
  if (!appState.dirty || isApplyingConfig) return;
  if (autoApplyInFlight) {
    autoApplyPending = true;
    return;
  }

  autoApplyInFlight = true;
  try {
    await saveConfig({ silent: true, skipUndo: true });
  } catch (err) {
    console.error('Auto-apply failed:', err);
    updateStatus('Auto-apply failed', true);
  } finally {
    autoApplyInFlight = false;
    if (autoApplyPending) {
      autoApplyPending = false;
      scheduleAutoApply();
    }
  }
}

function updateFilterCount() {
  const n = appState.config.filters.filter(f => !f.isEffect).length;
  const txt = `${n} filter${n !== 1 ? 's' : ''}`;
  const badge = document.getElementById('filter-count-badge');
  if (badge) badge.textContent = txt;
  const sfb = document.getElementById('status-filter-count');
  if (sfb) sfb.textContent = txt;
}

function updateStatus(text, isError = false) {
  const dot  = document.querySelector('.status-dot');
  const span = document.getElementById('status-text');
  if (dot)  dot.className  = `status-dot${isError ? ' error' : ''}`;
  if (span) span.textContent = text;
}

function showToast(message, type = 'success') {
  const icons = {
    success: '<svg class="toast-icon" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#10b981"/></svg>',
    error:   '<svg class="toast-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="#ef4444"/></svg>',
    warning: '<svg class="toast-icon" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" fill="#f59e0b"/></svg>',
    info:    '<svg class="toast-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="#00d4ff"/></svg>',
  };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icons[type] || icons.success}<span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 260); }, 3200);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════
// TARGET PICKER — Bundled / Squig / Upload / Custom
// ═══════════════════════════════════════════════════════════
function initTargetPicker() {
  const sourceSel   = document.getElementById('target-source');
  const nameSel     = document.getElementById('target-name');
  const upload      = document.getElementById('target-upload');
  const uploadWrap  = document.getElementById('target-upload-wrap');
  const customBar   = document.getElementById('target-customizer-bar');
  const allowCrossSource = document.getElementById('target-allow-cross-source');
  const clearBtn    = document.getElementById('target-clear');
  const targetHint  = document.getElementById('tp-hint');
  if (!sourceSel || !nameSel) return;

  // Squig DB source list is cached after first discovery.
  let squigSources = null;
  let activeSquigSourceId = selectedSquigSourceId;
  let activeSquigSource = selectedSquigSource;
  // Parsed reviewer config per source — keyed by source.id.
  const reviewerCfgCache = new Map();   // sourceId → {dir, groups}
  let reviewerLoadSeq = 0;
  let targetLoadSeq = 0;

  const defaultTargetHint = targetHint?.innerHTML || '';

  const setTargetHint = (message, type = '') => {
    if (!targetHint) return;
    targetHint.textContent = message;
    targetHint.className = `tp-hint${type ? ` ${type}` : ''}`;
  };

  const restoreTargetHint = () => {
    if (!targetHint) return;
    targetHint.innerHTML = defaultTargetHint;
    targetHint.className = 'tp-hint';
  };

  const ensureSquigSources = async () => {
    if (!squigSources) squigSources = await SquigDB.getSources().catch(() => []);
    return squigSources || [];
  };

  const getBrowserSourceId = () => {
    const browserFilter = document.getElementById('squig-source-filter');
    return browserFilter?.value || selectedSquigSourceId || freqGraph?.measurementMeta?.sourceId || '';
  };

  const setSquigTargetUnavailable = (message, type = 'warn') => {
    clearTarget();
    nameSel.innerHTML = `<option value="">${escapeHtml(message)}</option>`;
    nameSel.disabled = true;
    setTargetHint(message, type);
  };

  const setActiveSquigSource = async (sourceOrId, reason = 'picker') => {
    const sources = await ensureSquigSources();
    const id = typeof sourceOrId === 'string' ? sourceOrId : sourceOrId?.id;
    activeSquigSource = sourceOrId && typeof sourceOrId === 'object'
      ? sourceOrId
      : sources.find(s => s.id === id) || null;
    activeSquigSourceId = activeSquigSource?.id || '';
    if (activeSquigSource) {
      selectedSquigSource = activeSquigSource;
      selectedSquigSourceId = activeSquigSourceId;
    }
    if (sourceSel.value === 'squig') {
      if (allowCrossSource?.checked) await populateAllReviewerTargets(reason);
      else if (activeSquigSource) await populateReviewerTargets(activeSquigSource, reason);
      else setSquigTargetUnavailable('Choose a reviewer source in the Headphone Browser first.');
    }
  };

  const describeTarget = (target, displayName) => {
    const points = target.points || target.freq?.length || 0;
    const first = target.freq?.[0];
    const last = target.freq?.[target.freq.length - 1];
    const range = Number.isFinite(first) && Number.isFinite(last)
      ? `${Math.round(first)}-${Math.round(last)} Hz`
      : 'unknown range';
    const source = target.sourceName || target.category || 'target';
    return `${displayName} loaded from ${source}: ${points} points, ${range}. Graph is normalized at the selected reference frequency.`;
  };

  const applyTarget = (target, displayName) => {
    if (!target || !target.freq || !target.spl) return;
    // Pass through freqGraph so it is shown (NOT applied as EQ) — filters are
    // only created when the user presses "Run AutoEQ".
    const freeTargets = !!allowCrossSource?.checked;
    const targetMeta = buildTargetMeta(target, displayName, {
      allowCrossSource: freeTargets,
      allowUnsafeMatch: freeTargets,
    });
    tcBaseTargetData = { freq: target.freq.slice(), spl: target.spl.slice(), meta: targetMeta };
    freqGraph.setTargetData({ freq: target.freq, spl: target.spl }, targetMeta);
    rebuildCustomTarget();
    if (freqGraph.prefBoundsVisible) refreshPreferenceBounds();
    updateGraphLegend();
    updateAutoEQButtonState();
    setTargetHint(describeTarget(target, displayName), 'ok');
    if (freqGraph.measurementData) {
      const compatibility = freqGraph.getCurveCompatibility();
      if (!compatibility.ok) setTargetHint(`Curve mismatch: ${compatibility.message}`, 'error');
      else if (compatibility.warnings.length) setTargetHint(`${describeTarget(target, displayName)} Warning: ${compatibility.warnings[0]}`, 'warn');
    }
    showToast(`Target: ${displayName}`, 'info');
  };

  const clearTarget = () => {
    tcBaseTargetData = null;
    freqGraph.setTargetData(null);
    restoreTargetHint();
    updateGraphLegend();
    updateAutoEQButtonState();
  };

  // ── Populate the name dropdown based on the selected source ────
  const populateBundled = async () => {
    const list = await TargetLoader.loadBundledIndex();
    nameSel.innerHTML = '';
    if (!list.length) {
      nameSel.innerHTML = '<option value="">(no bundled targets)</option>';
      return;
    }
    const groups = {};
    for (const t of list) {
      const cat = t.category || 'other';
      (groups[cat] = groups[cat] || []).push(t);
    }
    const order = ['harman', 'neutral', 'diffuse-field', 'reviewer', 'custom', 'other'];
    for (const cat of order) {
      if (!groups[cat]) continue;
      const og = document.createElement('optgroup');
      og.label = ({
        harman: 'Harman', neutral: 'Neutral', 'diffuse-field': 'Diffuse Field',
        reviewer: 'Reviewer', custom: 'Custom', other: 'Other'
      })[cat] || cat;
      for (const t of groups[cat]) {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.name;
        og.appendChild(opt);
      }
      nameSel.appendChild(og);
    }
    // Default to Harman IE 2019v2 when available
    const preferred = list.find(t => t.name === 'Harman IE 2019v2') || list[0];
    if (preferred) nameSel.value = preferred.name;
  };

  // Squig flow is two-step: first pick a reviewer, then pick ONE of the
  // targets *that reviewer themselves ships* in their config.js. Never
  // mix targets across reviewers — each list is siloed.
  const populateSquigReviewers = async (seq) => {
    if (reviewerSel) reviewerSel.innerHTML = '<option value="">Loading sites…</option>';
    nameSel.innerHTML = '<option value="">Select a reviewer first…</option>';
    nameSel.disabled = true;
    if (!squigSources) {
      squigSources = await SquigDB.getSources().catch(() => []);
    }
    if (seq !== reviewerLoadSeq || sourceSel.value !== 'squig') return false;
    if (!reviewerSel) return;
    reviewerSel.innerHTML = '';
    if (!squigSources.length) {
      reviewerSel.innerHTML = '<option value="">(no squig sites reachable)</option>';
      return false;
    }
    // Sort A→Z for easier scanning.
    const sorted = squigSources.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const src of sorted) {
      const opt = document.createElement('option');
      opt.value = src.id;
      opt.textContent = `${src.icon || '🎧'} ${src.name} (${src.type})`;
      reviewerSel.appendChild(opt);
    }
    reviewerSel.value = '';
    return true;
  };

  const reviewerTargetValue = (sourceId, file) => `reviewer::${sourceId}::${encodeURIComponent(file)}`;

  const parseReviewerTargetValue = (value) => {
    if (!value?.startsWith('reviewer::')) return null;
    const parts = value.split('::');
    if (parts.length < 3) return null;
    return {
      sourceId: parts[1],
      file: decodeURIComponent(parts.slice(2).join('::')),
    };
  };

  const appendReviewerTargetOptions = (source, cfg, includeSourceName = false) => {
    if (!source || !cfg?.groups?.length) return 0;
    let count = 0;
    for (const g of cfg.groups) {
      const og = document.createElement('optgroup');
      og.label = includeSourceName
        ? `${source.icon || ''} ${source.name} (${source.type || 'source'}) - ${g.type || 'Targets'}`
        : (g.type || 'Targets');
      for (const f of g.files) {
        const opt = document.createElement('option');
        opt.value = includeSourceName ? reviewerTargetValue(source.id, f.file) : f.file;
        opt.textContent = f.name || f.file;
        opt.dataset.sourceId = source.id;
        opt.dataset.group = g.type || 'Targets';
        og.appendChild(opt);
        count++;
      }
      nameSel.appendChild(og);
    }
    return count;
  };

  const loadReviewerConfigCached = async (source) => {
    let cfg = reviewerCfgCache.get(source.id);
    if (!cfg) {
      cfg = await TargetLoader.fetchReviewerConfig(source).catch((err) => {
        console.warn(`[targetPicker] ${source.name} config load failed:`, err.message);
        return null;
      });
      if (cfg) reviewerCfgCache.set(source.id, cfg);
    }
    return cfg;
  };

  const populateAllReviewerTargets = async (reason = 'free-targets') => {
    const seq = ++reviewerLoadSeq;
    clearTarget();
    delete nameSel.dataset.autoTarget;
    nameSel.disabled = true;
    nameSel.innerHTML = '<option value="">Loading all reviewer targets...</option>';
    setTargetHint('Loading targets from all reviewer sources. This may take a moment...');

    const sources = (await ensureSquigSources()).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!sources.length) {
      setSquigTargetUnavailable('No squig reviewer sources are reachable.');
      return false;
    }

    const activeId = activeSquigSourceId || getBrowserSourceId();
    const orderedSources = [
      ...sources.filter(s => s.id === activeId),
      ...sources.filter(s => s.id !== activeId),
    ];

    const loaded = await Promise.allSettled(orderedSources.map(async source => {
      const cfg = await loadReviewerConfigCached(source);
      return { source, cfg };
    }));
    if (seq !== reviewerLoadSeq || sourceSel.value !== 'squig' || !allowCrossSource?.checked) return false;

    nameSel.innerHTML = '';
    let count = 0;
    let reviewerCount = 0;
    for (const result of loaded) {
      if (result.status !== 'fulfilled') continue;
      const { source, cfg } = result.value || {};
      if (!cfg?.groups?.length) continue;
      const added = appendReviewerTargetOptions(source, cfg, true);
      if (added) {
        count += added;
        reviewerCount++;
      }
    }

    if (!count) {
      setSquigTargetUnavailable('No reviewer target lists were reachable from the browser.', 'warn');
      return false;
    }

    nameSel.disabled = false;
    nameSel.selectedIndex = 0;
    setTargetHint(`Free reviewer targets enabled: ${count} targets from ${reviewerCount} reviewers are available for any gear.`, 'ok');
    onNameChange();
    return true;
  };

  // Populate #target-name from THIS reviewer's config.js only.
  const populateReviewerTargets = async (source) => {
    const seq = ++reviewerLoadSeq;
    activeSquigSource = source;
    activeSquigSourceId = source.id;
    clearTarget();
    nameSel.disabled = true;
    nameSel.innerHTML = '<option value="">Loading reviewer targets…</option>';
    setTargetHint(`Loading targets declared by ${source.name} only...`);
    const cfg = await loadReviewerConfigCached(source);
    if (seq !== reviewerLoadSeq || sourceSel.value !== 'squig' || activeSquigSourceId !== source.id) {
      return false;
    }
    nameSel.innerHTML = '';

    if (!cfg || !cfg.groups.length) {
      // Fallback 1: probe well-known target paths on this exact source.
      const guess = await TargetLoader.autoDiscoverSquigTarget(source).catch(() => null);
      if (seq !== reviewerLoadSeq || sourceSel.value !== 'squig' || activeSquigSourceId !== source.id) {
        return false;
      }
      if (guess) {
        const opt = document.createElement('option');
        opt.value = `__auto__::${guess.name}`;
        opt.textContent = guess.name.replace(/^.*·\s*/, '');
        nameSel.appendChild(opt);
        nameSel.dataset.autoTarget = JSON.stringify(guess);
        nameSel.disabled = false;
        setTargetHint(`${source.name} did not declare targets in config.js; using an isolated fallback target.`, 'warn');
        return true;
      }

      // Fallback 2: look for a sibling source (same baseUrl + same gear type, folder "/")
      // that DOES have a config.js. Handles e.g. reviewers whose headphone measurements
      // live under /headphones/ but whose targets are declared in the root source.
      if (source.folder && source.folder !== '/') {
        const allSources = await ensureSquigSources();
        const sibling = allSources.find(s =>
          s.id !== source.id &&
          s.baseUrl === source.baseUrl &&
          s.type === source.type &&
          (s.folder === '/' || s.folder === '')
        );
        if (sibling) {
          const sibCfg = await loadReviewerConfigCached(sibling);
          if (seq !== reviewerLoadSeq || sourceSel.value !== 'squig' || activeSquigSourceId !== source.id) {
            return false;
          }
          if (sibCfg?.groups?.length) {
            delete nameSel.dataset.autoTarget;
            appendReviewerTargetOptions(sibling, sibCfg, false);
            nameSel.disabled = false;
            if (nameSel.options.length) nameSel.selectedIndex = 0;
            const count = [...nameSel.options].filter(o => o.value).length;
            setTargetHint(`${source.name} has no own targets — showing ${sibling.name} targets (same site, same rig).`, 'warn');
            onNameChange();
            return true;
          }
        }
      }

      nameSel.innerHTML = '<option value="">(no targets declared by this reviewer)</option>';
      setTargetHint(`${source.name} has no parseable reviewer-specific targets.`, 'warn');
      return true;
    }

    delete nameSel.dataset.autoTarget;
    // Group by the reviewer's own `type` labels (e.g. Δ / Preference / Neutral).
    appendReviewerTargetOptions(source, cfg, false);
    nameSel.disabled = false;
    // Auto-select first option in first group so onNameChange can fire.
    if (nameSel.options.length) nameSel.selectedIndex = 0;
    const count = [...nameSel.options].filter(o => o.value).length;
    setTargetHint(`${source.name} targets loaded from its own config.js only (${count} targets).`, 'ok');
    return true;
  };

  const populateUpload = () => {
    nameSel.innerHTML = '<option value="">Pick a .txt file on the right ➤</option>';
    nameSel.disabled = true;
  };

  const populateCustom = () => {
    // Synthetic target: start from a flat baseline, customizer sliders shape it.
    nameSel.innerHTML = '<option value="flat">Flat (shape with sliders)</option>';
    nameSel.disabled = true;
  };

  // ── Reactively swap out the name dropdown when the source changes ─
  const createSyntheticTarget = () => {
    const freqs = [];
    for (let i = 0; i < 512; i++) freqs.push(20 * Math.pow(1000, i / 511));
    return {
      name: 'Synthetic Custom Target',
      category: 'custom',
      source: 'synthetic',
      sourceName: 'Synthetic',
      sourceType: freqGraph?.measurementMeta?.sourceType || 'generic',
      freq: freqs,
      spl: freqs.map(() => 0),
    };
  };

  const onSourceChange = async () => {
    const seq = ++reviewerLoadSeq;
    ++targetLoadSeq;
    nameSel.disabled = false;
    uploadWrap.style.display = 'none';
    // Advanced target shaping is available for every target source.
    // ships reviewer-tuned targets) — users can tilt/bass/treble any target.
    customBar.style.display = '';
    const src = sourceSel.value;
    if (src !== 'bundled') clearTarget();
    if (src === 'bundled') {
      await populateBundled();
      if (seq !== reviewerLoadSeq || sourceSel.value !== src) return;
      onNameChange();
    } else if (src === 'squig') {
      await ensureSquigSources();
      if (seq !== reviewerLoadSeq || sourceSel.value !== src) return;
      if (allowCrossSource?.checked) {
        await populateAllReviewerTargets('target-source');
      } else {
        const srcId = activeSquigSourceId || getBrowserSourceId();
        if (!srcId) {
          setSquigTargetUnavailable('Choose a reviewer source in the Headphone Browser first.');
          return;
        }
        await setActiveSquigSource(srcId, 'target-source');
      }
    } else if (src === 'upload') {
      populateUpload();
      uploadWrap.style.display = '';
    } else if (src === 'custom') {
      populateCustom();
      // Build a flat baseline across the audio band
      const freqs = [];
      for (let i = 0; i < 512; i++) {
        freqs.push(20 * Math.pow(1000, i / 511));   // 20 … 20000 Hz log-spaced
      }
      applyTarget(createSyntheticTarget(), 'Synthetic Custom Target');
    }
  };

  const onNameChange = async () => {
    const seq = ++targetLoadSeq;
    const src = sourceSel.value;
    const value = nameSel.value;
    if (!value) return;

    if (src === 'bundled') {
      try {
        const t = await TargetLoader.loadBundledTarget(value);
        if (seq !== targetLoadSeq || sourceSel.value !== src || nameSel.value !== value) return;
        applyTarget(t, t.name);
      } catch (err) {
        showToast(`Target load failed: ${err.message}`, 'error');
      }
    } else if (src === 'squig') {
      const parsedReviewerTarget = parseReviewerTargetValue(value);
      const targetSourceId = parsedReviewerTarget?.sourceId || activeSquigSourceId;
      const site = (squigSources || []).find(s => s.id === targetSourceId) || activeSquigSource;
      if (!site) return;
      // Fallback target (autoDiscover) is serialised into a data-attr.
      if (value.startsWith('__auto__::') && nameSel.dataset.autoTarget) {
        try {
          const t = JSON.parse(nameSel.dataset.autoTarget);
          applyTarget(t, t.name);
        } catch { /* ignore */ }
        return;
      }
      try {
        const targetFile = parsedReviewerTarget?.file || value;
        const t = await TargetLoader.loadReviewerTarget(site, targetFile);
        if (
          seq !== targetLoadSeq ||
          sourceSel.value !== src ||
          nameSel.value !== value
        ) return;
        applyTarget(t, t.shortName ? `${site.name} · ${t.shortName}` : t.name);
      } catch (err) {
        showToast(`Target load failed: ${err.message}`, 'error');
        setTargetHint(`${site.name}: ${err.message}`, 'error');
      }
    }
  };

  sourceSel.addEventListener('change', onSourceChange);
  [...sourceSel.options].forEach(opt => {
    if (!['bundled', 'squig', 'upload', 'custom'].includes(opt.value)) opt.remove();
  });
  nameSel.addEventListener('change', onNameChange);
  const updateTargetMatchOptions = () => {
    const freeTargets = !!allowCrossSource?.checked;
    if (tcBaseTargetData?.meta) {
      tcBaseTargetData.meta.allowCrossSource = freeTargets;
      tcBaseTargetData.meta.allowUnsafeMatch = freeTargets;
    }
    if (freqGraph?.targetData) {
      if (tcBaseTargetData?.meta) {
        rebuildCustomTarget();
      } else {
        freqGraph.setTargetData(freqGraph.getRawTargetData() || freqGraph.targetData, {
          ...(freqGraph.targetMeta || {}),
          allowCrossSource: freeTargets,
          allowUnsafeMatch: freeTargets,
        });
      }
      syncGraphFeatureControls();
      updateAutoEQButtonState();
    }
    if (sourceSel.value === 'squig') onSourceChange();
  };
  allowCrossSource?.addEventListener('change', updateTargetMatchOptions);
  window.addEventListener('squig-source-selected', (event) => {
    const detail = event.detail || {};
    const nextSource = detail.source || detail.sourceId;
    if (detail.source) {
      activeSquigSource = detail.source;
      activeSquigSourceId = detail.source.id;
    }
    if (sourceSel.value === 'squig' && nextSource) setActiveSquigSource(nextSource, detail.reason || 'shared');
  });

  upload.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const t = await TargetLoader.loadUploadedTarget(file);
      applyTarget(t, t.name);
    } catch (err) {
      showToast(`Upload failed: ${err.message}`, 'error');
    }
  });

  clearBtn.addEventListener('click', () => {
    clearTarget();
    nameSel.value = '';
    showToast('Target cleared', 'info');
  });

  // Initial load: bundled targets, Harman IE 2019v2 preselected — but do NOT
  // auto-apply so the user sees an empty graph until they pick.
  onSourceChange();
}

// ═══════════════════════════════════════════════════════════
// TARGET CUSTOMIZER
// ═══════════════════════════════════════════════════════════
function initTargetCustomizer() {
  const tiltSlider   = document.getElementById('tc-tilt');
  const bassSlider   = document.getElementById('tc-bass');
  const trebleSlider = document.getElementById('tc-treble');
  const tiltVal      = document.getElementById('tc-tilt-val');
  const bassVal      = document.getElementById('tc-bass-val');
  const trebleVal    = document.getElementById('tc-treble-val');
  const presetSel    = document.getElementById('tc-preset-select');
  const resetBtn     = document.getElementById('tc-reset');

  if (!tiltSlider) return;

  const applyTC = () => {
    tcState.tilt   = parseFloat(tiltSlider.value);
    tcState.bass   = parseFloat(bassSlider.value);
    tcState.treble = parseFloat(trebleSlider.value);

    tiltVal.textContent   = `${tcState.tilt >= 0 ? '+' : ''}${tcState.tilt.toFixed(1)} dB/oct`;
    bassVal.textContent   = `${tcState.bass >= 0 ? '+' : ''}${tcState.bass.toFixed(1)} dB`;
    trebleVal.textContent = `${tcState.treble >= 0 ? '+' : ''}${tcState.treble.toFixed(1)} dB`;

    rebuildCustomTarget();
  };

  tiltSlider.addEventListener('input', applyTC);
  bassSlider.addEventListener('input', applyTC);
  trebleSlider.addEventListener('input', applyTC);

  presetSel.addEventListener('change', (e) => {
    const p = e.target.value;
    if (!p) return;
    const presets = {
      neutral: { tilt: 0,    bass: 0,  treble: 0 },
      harman:  { tilt: 0,    bass: 6,  treble: -2 },
      warm:    { tilt: -0.5, bass: 3,  treble: -3 },
      bright:  { tilt: 0.5,  bass: -2, treble: 3 },
    };
    const vals = presets[p];
    if (!vals) return;
    tcState = { ...vals };
    tiltSlider.value   = vals.tilt;
    bassSlider.value   = vals.bass;
    trebleSlider.value = vals.treble;
    applyTC();
    e.target.value = '';
  });

  resetBtn.addEventListener('click', () => {
    tcState = { ...TARGET_ADJUSTMENT_DEFAULTS };
    tiltSlider.value   = 0;
    bassSlider.value   = 0;
    trebleSlider.value = 0;
    applyTC();
  });
}

// Rebuild the target curve in the graph using tcState adjustments
function rebuildCustomTarget() {
  // Work from the last-loaded base target data (before customization)
  const base = tcBaseTargetData || freqGraph.targetData;
  if (!base || !base.freq.length) return;

  tcState = normalizeTargetAdjustments(tcState);
  const adjustedTarget = applyTargetAdjustments(base, tcState);
  const adjusted = isTargetAdjusted(tcState);
  const adjustmentLabel = formatTargetAdjustmentLabel(tcState);
  freqGraph.setTargetData(adjustedTarget, {
    ...(base.meta || freqGraph.targetMeta || {}),
    customized: adjusted,
    adjustmentLabel,
    targetAdjustments: { ...tcState },
  });
  if (freqGraph.prefBoundsVisible) refreshPreferenceBounds();
  updateGraphLegend();
  updateAutoEQButtonState();
}

// ═══════════════════════════════════════════════════════════
// PREFERENCE BOUNDS (Harman-inspired)
// ═══════════════════════════════════════════════════════════
function refreshPreferenceBounds() {
  if (!freqGraph) return;
  freqGraph.setPrefBounds(buildPreferenceBounds());
}

function buildPreferenceBounds() {
  const base = freqGraph?.targetData?.freq?.length ? freqGraph.targetData : null;
  if (!base) return buildHarmanPrefBounds();

  const freqs = [];
  const upper = [];
  const lower = [];
  const count = 180;
  for (let i = 0; i <= count; i++) {
    const f = 20 * Math.pow(1000, i / count);
    const center = freqGraph._interpolateSplAt(base, f);
    const tolerance = preferenceToleranceDb(f);
    freqs.push(f);
    upper.push(center + tolerance.upper);
    lower.push(center - tolerance.lower);
  }
  return {
    upper: { freq: freqs, spl: upper },
    lower: { freq: freqs, spl: lower },
  };
}

function preferenceToleranceDb(freq) {
  if (freq < 60) return { upper: 4.5, lower: 5.5 };
  if (freq < 200) return { upper: 3.5, lower: 4.5 };
  if (freq < 1000) return { upper: 2.0, lower: 2.5 };
  if (freq < 4000) return { upper: 2.5, lower: 2.5 };
  if (freq < 8000) return { upper: 3.5, lower: 4.0 };
  if (freq < 12000) return { upper: 5.0, lower: 6.0 };
  return { upper: 7.0, lower: 9.0 };
}

function buildHarmanPrefBounds() {
  // Simplified Harman-inspired preference bounds
  // Upper: slightly boosted bass + gentle treble roll-off
  // Lower: flatter bass + more treble roll-off
  // All values relative to 1 kHz (0 dB)
  const points = [
    // [freq, upperBound, lowerBound]
    [20,    8,   2],
    [30,    7,   1],
    [50,    6,   0],
    [80,    5,   -1],
    [120,   4,   -1],
    [200,   2,   -1],
    [500,   1,   -1],
    [1000,  0,    0],
    [2000,  0,   -1],
    [3000,  1,   -1],
    [4000,  2,   -2],
    [6000,  1,   -4],
    [8000, -1,   -7],
    [10000,-2,   -9],
    [12000,-3,  -11],
    [16000,-5,  -14],
    [20000,-7,  -17],
  ];

  return {
    upper: { freq: points.map(p => p[0]), spl: points.map(p => p[1]) },
    lower: { freq: points.map(p => p[0]), spl: points.map(p => p[2]) },
  };
}

// ═══════════════════════════════════════════════════════════
// HID DEVICE PANEL
// ═══════════════════════════════════════════════════════════
function initHIDPanel() {
  const disconnectedState = document.getElementById('hid-disconnected-state');
  const connectedState    = document.getElementById('hid-connected-state');
  const btnConnect        = document.getElementById('btn-hid-connect');
  const btnDisconnect     = document.getElementById('btn-hid-disconnect');
  const btnPush           = document.getElementById('btn-hid-push');
  const btnPull           = document.getElementById('btn-hid-pull');
  const deviceName        = document.getElementById('hid-device-name');
  const deviceSub         = document.getElementById('hid-device-sub');
  const slotSelect        = document.getElementById('hid-slot-select');
  const statusMsg         = document.getElementById('hid-status-msg');
  const connectorSel      = document.getElementById('device-connector');
  const networkRow        = document.getElementById('hid-network-row');
  const networkHost       = document.getElementById('device-network-host');

  if (!btnConnect) return; // panel not in DOM

  function refreshConnectorAvailability() {
    if (!connectorSel) return;
    const connectors = devicePeq.listConnectors();
    for (const meta of connectors) {
      const opt = connectorSel.querySelector(`option[value="${meta.key}"]`);
      if (!opt) continue;
      opt.textContent = meta.label;
      opt.title = meta.available ? meta.label : `${meta.label} is not available in this app session`;
      opt.disabled = !meta.available;
    }
    if (connectorSel.selectedOptions[0]?.disabled) {
      const firstAvailable = connectors.find(meta => meta.available);
      if (firstAvailable) connectorSel.value = firstAvailable.key;
    }
  }

  function showHIDStatus(msg, type = 'info') {
    statusMsg.textContent = msg;
    statusMsg.className   = `hid-status-msg ${type}`;
    statusMsg.style.display = 'block';
  }
  function hideHIDStatus() {
    statusMsg.style.display = 'none';
  }

  function setConnectedUI(device) {
    disconnectedState.style.display = 'none';
    connectedState.style.display    = '';

    deviceName.textContent = device.model || 'Unknown Device';
    deviceSub.textContent  = `${device.manufacturer || ''} · ${device.modelConfig?.maxFilters || 10} bands max · ${device.protocol || 'usb-hid'}`;

    slotSelect.innerHTML = '';
    for (const slot of (devicePeq.getAvailableSlots() || [])) {
      const opt = document.createElement('option');
      opt.value       = slot.id;
      opt.textContent = slot.name;
      slotSelect.appendChild(opt);
    }

    // Try to pre-select the current slot
    devicePeq.getCurrentSlot().then(slotId => {
      if (slotId != null) slotSelect.value = slotId;
    }).catch(() => {});

    hideHIDStatus();
  }

  function setDisconnectedUI() {
    connectedState.style.display    = 'none';
    disconnectedState.style.display = '';
    hideHIDStatus();
  }

  // ── Connector dropdown: swap UI hint and show network host input ──
  if (connectorSel) {
    refreshConnectorAvailability();
    const onConnectorChange = () => {
      const isNet = connectorSel.value === 'network';
      if (networkRow) networkRow.style.display = isNet ? '' : 'none';
    };
    connectorSel.addEventListener('change', onConnectorChange);
    onConnectorChange();
  }

  // ── Connect ────────────────────────────────────────────────
  btnConnect.addEventListener('click', async () => {
    btnConnect.disabled = true;
    btnConnect.textContent = 'Connecting…';
    try {
      const key = connectorSel?.value || 'hid';
      const opts = key === 'network' ? { host: (networkHost?.value || '').trim() } : {};
      const device = await devicePeq.connect(key, opts);
      if (device) {
        setConnectedUI(device);
        showToast(`Connected: ${device.model}`, 'success');
      } else {
        showToast('No device selected', 'warning');
      }
    } catch (err) {
      showToast(`Connect error: ${err.message}`, 'error');
    } finally {
      btnConnect.disabled = false;
      btnConnect.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M10.5 20H6a2 2 0 01-2-2V6a2 2 0 012-2h12a2 2 0 012 2v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M15 15l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Connect Device`;
    }
  });

  // ── Disconnect ─────────────────────────────────────────────
  btnDisconnect.addEventListener('click', async () => {
    await devicePeq.disconnect();
    setDisconnectedUI();
    showToast('Device disconnected', 'info');
  });

  // ── Push EQ ───────────────────────────────────────────────
  btnPush.addEventListener('click', async () => {
    if (!devicePeq.isConnected()) return;

    const filters = parametricEQ.getFilters().filter(f => f.enabled !== false);
    const preamp  = appState.config.preamp || 0;
    const slot    = parseInt(slotSelect.value, 10);

    btnPush.disabled    = true;
    btnPull.disabled    = true;
    showHIDStatus('Pushing EQ to device…', 'info');

    try {
      const disconnected = await devicePeq.push(filters, preamp, slot);
      if (disconnected) {
        setDisconnectedUI();
        showToast('EQ pushed — device disconnected after save (normal for this model)', 'success');
      } else {
        showHIDStatus('EQ pushed successfully!', 'success');
        showToast('EQ pushed to device', 'success');
      }
    } catch (err) {
      showHIDStatus(`Push failed: ${err.message}`, 'error');
      showToast(`Push failed: ${err.message}`, 'error');
      if (err.message.includes('disconnected')) setDisconnectedUI();
    } finally {
      btnPush.disabled = false;
      btnPull.disabled = false;
    }
  });

  // ── Pull EQ ───────────────────────────────────────────────
  btnPull.addEventListener('click', async () => {
    if (!devicePeq.isConnected()) return;

    btnPush.disabled = true;
    btnPull.disabled = true;
    showHIDStatus('Reading EQ from device…', 'info');

    try {
      const { filters, globalGain } = await devicePeq.pull();

      if (!filters || filters.length === 0) {
        showHIDStatus('No filters returned from device', 'error');
        return;
      }

      pushUndo();
      appState.config.filters = filters;
      appState.config.preamp  = globalGain - (devicePeq.getDevice()?.modelConfig?.maxGain || 12);

      parametricEQ.setFilters(appState.config.filters);
      freqGraph.setFilters(appState.config.filters);

      const preampEl = document.getElementById('preamp-slider');
      const preampVal = document.getElementById('preamp-value');
      if (preampEl) {
        preampEl.value     = appState.config.preamp;
        preampVal.textContent = `${appState.config.preamp >= 0 ? '+' : ''}${appState.config.preamp.toFixed(1)} dB`;
        freqGraph.setPreamp(appState.config.preamp);
      }

      markDirty();
      updateFilterCount();
      showHIDStatus(`Pulled ${filters.length} filters from device`, 'success');
      showToast(`Pulled ${filters.length} filters from device`, 'success');
      openEqualizer('parametric');
    } catch (err) {
      showHIDStatus(`Pull failed: ${err.message}`, 'error');
      showToast(`Pull failed: ${err.message}`, 'error');
      if (err.message.includes('disconnected')) setDisconnectedUI();
    } finally {
      btnPush.disabled = false;
      btnPull.disabled = false;
    }
  });
}
