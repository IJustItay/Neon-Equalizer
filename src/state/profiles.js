/**
 * Unified profile + settings persistence.
 *
 * Before this module the app had six overlapping save systems with different
 * key namespaces (`neon-equalizer:*`, `neonEq*`, and a stale `eqapoStudio.*`),
 * settings read/written ad-hoc via scattered localStorage calls, and device
 * presets that stored EQ but none of the surrounding settings.
 *
 * Everything now goes through one place:
 *   - SETTINGS_REGISTRY  — the single declarative source of truth for every
 *                          persisted setting (key, type, default, scope).
 *   - Profile            — a complete, named capture of {eq + settings}.
 *   - Device profiles    — the same Profile shape, bound to an output device,
 *                          so per-device EQ *and* settings are supported.
 *   - summarizeProfile() — describes exactly what a profile contains, which is
 *                          what the UI renders so the user can see what is
 *                          saved for each device.
 *
 * The module is intentionally pure-data (no DOM): main.js supplies the current
 * EQ config and applies the result. That keeps it unit-testable.
 */

export const PROFILES_KEY = 'neon-equalizer:profiles:v1';
export const DEVICE_PROFILES_KEY = 'neon-equalizer:device-profiles:v1';
export const PROFILE_SCHEMA_VERSION = 1;

// Legacy stores migrated on first read.
const LEGACY_QUICK_PRESETS_KEY = 'eqapoStudio.quickPresets.v1';
const LEGACY_DEVICE_PRESETS_KEY = 'neon-equalizer:device-presets:v1';

/**
 * Every persisted setting in the app.
 *
 *   scope 'profile' → captured in profiles and per-device profiles (things a
 *                     user expects to travel with "my setup for these
 *                     headphones").
 *   scope 'app'     → machine/session-level; persisted, but never overwritten
 *                     by loading someone else's profile.
 */
export const SETTINGS_REGISTRY = [
  // Auto-save defaults ON when never set — matches the app's original behavior.
  { id: 'autoSaveApo',        key: 'neon-equalizer:auto-save-apo',              type: 'boolean', fallback: true,  scope: 'profile', label: 'Auto-save to APO' },
  { id: 'deviceAutoSwitch',   key: 'neon-equalizer:device-auto-switch',         type: 'boolean', fallback: false, scope: 'profile', label: 'Auto-switch on device change' },
  { id: 'surround',           key: 'neonEqSurround:v1',                         type: 'json',    fallback: null,  scope: 'profile', label: 'Surround / HRTF' },
  { id: 'reviewerNormalization', key: 'neon-equalizer:reviewer-normalization:v1', type: 'json',  fallback: null,  scope: 'profile', label: 'Reviewer normalization' },
  { id: 'theme',              key: 'neon-equalizer:theme',                      type: 'string',  fallback: '',    scope: 'app',     label: 'Theme' },
  { id: 'helpMode',           key: 'neon-equalizer:help-mode',                  type: 'string',  fallback: '',    scope: 'app',     label: 'Help mode' },
  { id: 'uiZoom',             key: 'neonEqUiZoom',                              type: 'number',  fallback: null,  scope: 'app',     label: 'UI zoom' },
  { id: 'graphHeight',        key: 'neonEqGraphH',                              type: 'number',  fallback: null,  scope: 'app',     label: 'Graph height' },
  { id: 'panelCollapsed',     key: 'neonEqPanelCollapsed',                      type: 'boolean', fallback: false, scope: 'app',     label: 'Panel collapsed' },
];

const REGISTRY_BY_ID = new Map(SETTINGS_REGISTRY.map((s) => [s.id, s]));

/** Settings that travel with a profile. */
export const PROFILE_SETTING_IDS = SETTINGS_REGISTRY
  .filter((s) => s.scope === 'profile')
  .map((s) => s.id);

// ─── Storage plumbing ─────────────────────────────────────────────────────────

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readRaw(store, key) {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}

function writeRaw(store, key, value) {
  try { store?.setItem(key, value); return true; } catch { return false; }
}

function removeRaw(store, key) {
  try { store?.removeItem(key); return true; } catch { return false; }
}

function readJson(store, key, fallback) {
  const raw = readRaw(store, key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// ─── Setting coercion ─────────────────────────────────────────────────────────

function decodeSetting(spec, raw) {
  if (raw === null || raw === undefined) return spec.fallback;
  switch (spec.type) {
    case 'boolean': return raw === 'true' || raw === true;
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : spec.fallback;
    }
    case 'json': {
      if (typeof raw !== 'string') return raw;
      try { return JSON.parse(raw); } catch { return spec.fallback; }
    }
    default: return String(raw);
  }
}

function encodeSetting(spec, value) {
  if (value === null || value === undefined) return null;
  switch (spec.type) {
    case 'boolean': return String(Boolean(value));
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'json': return JSON.stringify(value);
    default: return String(value);
  }
}

/** Read one registered setting. */
export function getSetting(id, store = defaultStorage()) {
  const spec = REGISTRY_BY_ID.get(id);
  if (!spec) return undefined;
  return decodeSetting(spec, readRaw(store, spec.key));
}

/** Write one registered setting (null/undefined removes it). */
export function setSetting(id, value, store = defaultStorage()) {
  const spec = REGISTRY_BY_ID.get(id);
  if (!spec) return false;
  const encoded = encodeSetting(spec, value);
  return encoded === null ? removeRaw(store, spec.key) : writeRaw(store, spec.key, encoded);
}

/**
 * Snapshot settings as a plain object.
 * @param {'profile'|'app'|'all'} scope
 */
export function captureSettings(scope = 'profile', store = defaultStorage()) {
  const out = {};
  for (const spec of SETTINGS_REGISTRY) {
    if (scope !== 'all' && spec.scope !== scope) continue;
    out[spec.id] = decodeSetting(spec, readRaw(store, spec.key));
  }
  return out;
}

/**
 * Write a settings object back to storage. Only keys present in the object and
 * registered in the registry are touched; 'app'-scope settings are skipped
 * unless explicitly allowed, so loading a profile never hijacks machine-level
 * preferences like UI zoom.
 * @returns {string[]} ids actually applied
 */
export function applySettings(settings, { includeAppScope = false, store = defaultStorage() } = {}) {
  if (!settings || typeof settings !== 'object') return [];
  const applied = [];
  for (const [id, value] of Object.entries(settings)) {
    const spec = REGISTRY_BY_ID.get(id);
    if (!spec) continue;
    if (spec.scope === 'app' && !includeAppScope) continue;
    if (setSetting(id, value, store)) applied.push(id);
  }
  return applied;
}

// ─── Profile model ────────────────────────────────────────────────────────────

function newId(prefix = 'p') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Build a profile from an EQ config + settings snapshot.
 * @param {string} name
 * @param {object} eq   - the app's config object (filters, graphicEQ, preamp, …)
 * @param {object} [settings] - defaults to the current 'profile'-scope settings
 */
export function createProfile(name, eq, settings = null, extra = {}) {
  const now = new Date().toISOString();
  return {
    schema: PROFILE_SCHEMA_VERSION,
    id: extra.id || newId(),
    name: String(name || 'Untitled').trim() || 'Untitled',
    createdAt: extra.createdAt || now,
    updatedAt: now,
    eqMode: extra.eqMode || 'parametric',
    device: extra.device || eq?.device || 'all',
    eq: clone(eq) || {},
    settings: clone(settings) || {},
  };
}

/** Normalize anything profile-shaped (incl. legacy records) into a Profile. */
export function normalizeProfile(raw, fallbackName = 'Untitled') {
  if (!raw || typeof raw !== 'object') return null;
  // Legacy quick-preset / device-preset records were { name, config, updatedAt }.
  const eq = raw.eq || raw.config || {};
  const now = new Date().toISOString();
  return {
    schema: PROFILE_SCHEMA_VERSION,
    id: raw.id || newId(),
    name: String(raw.name || fallbackName).trim() || fallbackName,
    createdAt: raw.createdAt || raw.updatedAt || now,
    updatedAt: raw.updatedAt || now,
    eqMode: raw.eqMode || 'parametric',
    device: raw.device || eq.device || 'all',
    eq: clone(eq) || {},
    settings: clone(raw.settings) || {},
  };
}

// ─── Profile store (named user profiles) ──────────────────────────────────────

function migrateLegacyQuickPresets(store) {
  const legacy = readJson(store, LEGACY_QUICK_PRESETS_KEY, null);
  if (!Array.isArray(legacy) || !legacy.length) return [];
  return legacy.map((p) => normalizeProfile(p, 'Imported preset')).filter(Boolean);
}

/** All named profiles, newest first. Migrates legacy quick presets once. */
export function listProfiles(store = defaultStorage()) {
  const raw = readJson(store, PROFILES_KEY, null);
  if (Array.isArray(raw)) {
    return raw.map((p) => normalizeProfile(p)).filter(Boolean);
  }
  const migrated = migrateLegacyQuickPresets(store);
  if (migrated.length) writeRaw(store, PROFILES_KEY, JSON.stringify(migrated));
  return migrated;
}

function persistProfiles(profiles, store) {
  return writeRaw(store, PROFILES_KEY, JSON.stringify(profiles));
}

/** Create or update a profile by name (case-insensitive). Returns the profile. */
export function saveProfile(profile, store = defaultStorage()) {
  const normalized = normalizeProfile(profile);
  if (!normalized) return null;
  const profiles = listProfiles(store);
  const idx = profiles.findIndex(
    (p) => p.id === normalized.id || p.name.toLowerCase() === normalized.name.toLowerCase()
  );
  if (idx >= 0) {
    normalized.id = profiles[idx].id;
    normalized.createdAt = profiles[idx].createdAt;
    profiles[idx] = normalized;
  } else {
    profiles.unshift(normalized);
  }
  persistProfiles(profiles, store);
  return normalized;
}

export function getProfile(idOrName, store = defaultStorage()) {
  const key = String(idOrName || '').toLowerCase();
  return listProfiles(store).find(
    (p) => p.id === idOrName || p.name.toLowerCase() === key
  ) || null;
}

export function deleteProfile(idOrName, store = defaultStorage()) {
  const profiles = listProfiles(store);
  const key = String(idOrName || '').toLowerCase();
  const next = profiles.filter((p) => p.id !== idOrName && p.name.toLowerCase() !== key);
  if (next.length === profiles.length) return false;
  persistProfiles(next, store);
  return true;
}

export function renameProfile(idOrName, newName, store = defaultStorage()) {
  const profiles = listProfiles(store);
  const key = String(idOrName || '').toLowerCase();
  const target = profiles.find((p) => p.id === idOrName || p.name.toLowerCase() === key);
  if (!target) return null;
  const clean = String(newName || '').trim();
  if (!clean) return null;
  target.name = clean;
  target.updatedAt = new Date().toISOString();
  persistProfiles(profiles, store);
  return target;
}

// ─── Device-bound profiles ────────────────────────────────────────────────────

/** Stable key for a device string ('all' for the global default). */
export function deviceKey(device) {
  const text = String(device || '').trim();
  return !text || text.toLowerCase() === 'all' ? 'all' : text;
}

function migrateLegacyDevicePresets(store) {
  const legacy = readJson(store, LEGACY_DEVICE_PRESETS_KEY, null);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {};
  const out = {};
  for (const [key, preset] of Object.entries(legacy)) {
    const profile = normalizeProfile(preset, preset?.name || key);
    if (!profile) continue;
    profile.device = preset?.device || key;
    out[deviceKey(key)] = profile;
  }
  return out;
}

/** Map of deviceKey → Profile. Migrates legacy device presets once. */
export function getDeviceProfiles(store = defaultStorage()) {
  const raw = readJson(store, DEVICE_PROFILES_KEY, null);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const profile = normalizeProfile(value, key);
      if (profile) out[deviceKey(key)] = profile;
    }
    return out;
  }
  const migrated = migrateLegacyDevicePresets(store);
  if (Object.keys(migrated).length) {
    writeRaw(store, DEVICE_PROFILES_KEY, JSON.stringify(migrated));
  }
  return migrated;
}

function persistDeviceProfiles(map, store) {
  return writeRaw(store, DEVICE_PROFILES_KEY, JSON.stringify(map));
}

/** Save the full state (EQ + settings) for one device. */
export function setDeviceProfile(device, profile, store = defaultStorage()) {
  const normalized = normalizeProfile(profile);
  if (!normalized) return null;
  const key = deviceKey(device);
  normalized.device = key === 'all' ? 'all' : (normalized.device || device);
  const map = getDeviceProfiles(store);
  const existing = map[key];
  if (existing) {
    normalized.id = existing.id;
    normalized.createdAt = existing.createdAt;
  }
  map[key] = normalized;
  persistDeviceProfiles(map, store);
  return normalized;
}

export function getDeviceProfile(device, store = defaultStorage()) {
  return getDeviceProfiles(store)[deviceKey(device)] || null;
}

export function deleteDeviceProfile(device, store = defaultStorage()) {
  const map = getDeviceProfiles(store);
  const key = deviceKey(device);
  if (!map[key]) return false;
  delete map[key];
  persistDeviceProfiles(map, store);
  return true;
}

// ─── Summaries (drive the "what is saved here" UI) ────────────────────────────

/**
 * Describe exactly what a profile contains, so the UI can show the user what is
 * stored for a given device/profile instead of an opaque "preset saved".
 */
export function summarizeProfile(profile) {
  const p = normalizeProfile(profile);
  if (!p) {
    return { exists: false, filters: 0, enabledFilters: 0, graphicEQ: false, preamp: 0, settings: [], parts: [], text: 'Nothing saved' };
  }

  const eq = p.eq || {};
  const filters = Array.isArray(eq.filters) ? eq.filters : [];
  const enabledFilters = filters.filter((f) => f && f.enabled !== false).length;
  const graphicBands = eq.graphicEQ?.bands || [];
  const graphicActive = Boolean(eq.graphicEQ?.enabled) &&
    graphicBands.some((b) => Math.abs(Number(b?.gain) || 0) > 0.001);
  const preamp = Number(eq.preamp) || 0;

  const settingLabels = Object.keys(p.settings || {})
    .map((id) => REGISTRY_BY_ID.get(id))
    .filter(Boolean)
    .map((spec) => spec.label);

  const parts = [];
  if (filters.length) {
    parts.push(`${filters.length} filter${filters.length === 1 ? '' : 's'}` +
      (enabledFilters !== filters.length ? ` (${enabledFilters} on)` : ''));
  }
  if (graphicActive) parts.push(`graphic EQ ${graphicBands.length}-band`);
  if (Math.abs(preamp) > 0.001) parts.push(`preamp ${preamp > 0 ? '+' : ''}${preamp.toFixed(1)} dB`);
  if (eq.convolution?.file) parts.push('convolution');
  if (Array.isArray(eq.vstPlugins) && eq.vstPlugins.length) parts.push(`${eq.vstPlugins.length} VST`);
  if (eq.loudnessCorrection?.enabled) parts.push('loudness');
  if (settingLabels.length) parts.push(`${settingLabels.length} setting${settingLabels.length === 1 ? '' : 's'}`);

  return {
    exists: true,
    id: p.id,
    name: p.name,
    device: p.device,
    eqMode: p.eqMode,
    updatedAt: p.updatedAt,
    filters: filters.length,
    enabledFilters,
    graphicEQ: graphicActive,
    graphicBands: graphicBands.length,
    preamp,
    settings: settingLabels,
    parts,
    text: parts.length ? parts.join(' · ') : 'Empty profile',
  };
}

// ─── Import / export ──────────────────────────────────────────────────────────

export function exportProfile(profile) {
  const p = normalizeProfile(profile);
  return p ? JSON.stringify({ kind: 'neon-equalizer-profile', ...p }, null, 2) : null;
}

/** Parse an exported profile. Returns null when the payload isn't a profile. */
export function importProfile(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind && parsed.kind !== 'neon-equalizer-profile') return null;
  if (!parsed.eq && !parsed.config) return null;
  const profile = normalizeProfile(parsed);
  if (profile) profile.id = newId(); // never collide with an existing profile
  return profile;
}
