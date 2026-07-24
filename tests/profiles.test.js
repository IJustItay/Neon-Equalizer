import { describe, it, expect, beforeEach } from 'vitest';
import {
  SETTINGS_REGISTRY,
  PROFILE_SETTING_IDS,
  getSetting,
  setSetting,
  captureSettings,
  applySettings,
  createProfile,
  normalizeProfile,
  listProfiles,
  saveProfile,
  getProfile,
  deleteProfile,
  renameProfile,
  deviceKey,
  getDeviceProfiles,
  setDeviceProfile,
  getDeviceProfile,
  deleteDeviceProfile,
  summarizeProfile,
  exportProfile,
  importProfile,
  PROFILES_KEY,
  DEVICE_PROFILES_KEY,
} from '../src/state/profiles.js';

// Minimal in-memory localStorage stand-in.
function memStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

const EQ = {
  device: 'all',
  preamp: -6,
  filters: [
    { id: 'f1', type: 'PK', frequency: 1000, gain: 3, q: 1, enabled: true },
    { id: 'f2', type: 'LSC', frequency: 105, gain: 2, q: 0.7, enabled: false },
  ],
  graphicEQ: { enabled: true, bands: [{ frequency: 100, gain: 3 }, { frequency: 1000, gain: 0 }] },
};

let store;
beforeEach(() => { store = memStore(); });

describe('settings registry', () => {
  it('has unique ids and storage keys', () => {
    const ids = SETTINGS_REGISTRY.map((s) => s.id);
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry declares a valid scope and type', () => {
    for (const s of SETTINGS_REGISTRY) {
      expect(['profile', 'app']).toContain(s.scope);
      expect(['boolean', 'number', 'string', 'json']).toContain(s.type);
      expect(s.label).toBeTruthy();
    }
  });

  it('round-trips each type through storage', () => {
    setSetting('autoSaveApo', true, store);
    setSetting('uiZoom', 1.15, store);
    setSetting('theme', 'dark', store);
    setSetting('surround', { mode: 'hrtf', level: 3 }, store);

    expect(getSetting('autoSaveApo', store)).toBe(true);
    expect(getSetting('uiZoom', store)).toBe(1.15);
    expect(getSetting('theme', store)).toBe('dark');
    expect(getSetting('surround', store)).toEqual({ mode: 'hrtf', level: 3 });
  });

  it('returns declared fallbacks when unset', () => {
    // Auto-save is ON by default — preserves the app's original behavior.
    expect(getSetting('autoSaveApo', store)).toBe(true);
    expect(getSetting('deviceAutoSwitch', store)).toBe(false);
    expect(getSetting('surround', store)).toBeNull();
    expect(getSetting('theme', store)).toBe('');
  });

  it('stores false distinctly from unset', () => {
    setSetting('autoSaveApo', false, store);
    expect(getSetting('autoSaveApo', store)).toBe(false);
  });

  it('ignores unknown setting ids', () => {
    expect(setSetting('nope', 1, store)).toBe(false);
    expect(getSetting('nope', store)).toBeUndefined();
  });

  it('survives corrupt JSON in storage', () => {
    const bad = memStore({ 'neonEqSurround:v1': '{not json' });
    expect(getSetting('surround', bad)).toBeNull();
  });
});

describe('capture/apply settings', () => {
  it('captures only profile-scope settings by default', () => {
    setSetting('autoSaveApo', true, store);
    setSetting('uiZoom', 1.25, store);
    const captured = captureSettings('profile', store);
    expect(Object.keys(captured).sort()).toEqual([...PROFILE_SETTING_IDS].sort());
    expect(captured).not.toHaveProperty('uiZoom');
  });

  it('does NOT overwrite app-scope settings when applying a profile', () => {
    setSetting('uiZoom', 1.0, store);
    const applied = applySettings({ uiZoom: 0.8, autoSaveApo: true }, { store });
    expect(applied).toEqual(['autoSaveApo']);
    // The user's own zoom is preserved.
    expect(getSetting('uiZoom', store)).toBe(1.0);
    expect(getSetting('autoSaveApo', store)).toBe(true);
  });

  it('applies app-scope settings when explicitly allowed', () => {
    applySettings({ uiZoom: 0.8 }, { includeAppScope: true, store });
    expect(getSetting('uiZoom', store)).toBe(0.8);
  });

  it('ignores unregistered keys and non-objects', () => {
    expect(applySettings({ bogus: 1 }, { store })).toEqual([]);
    expect(applySettings(null, { store })).toEqual([]);
  });
});

describe('profile CRUD', () => {
  it('creates, saves and reads back a profile', () => {
    const p = createProfile('Studio', EQ, captureSettings('profile', store));
    saveProfile(p, store);
    const loaded = getProfile('Studio', store);
    expect(loaded.name).toBe('Studio');
    expect(loaded.eq.filters).toHaveLength(2);
    expect(loaded.eq.preamp).toBe(-6);
  });

  it('updates in place when saving the same name (no duplicates)', () => {
    saveProfile(createProfile('Studio', EQ), store);
    saveProfile(createProfile('studio', { ...EQ, preamp: -3 }), store);
    const all = listProfiles(store);
    expect(all).toHaveLength(1);
    expect(all[0].eq.preamp).toBe(-3);
  });

  it('preserves id and createdAt across updates', () => {
    const first = saveProfile(createProfile('Studio', EQ), store);
    const second = saveProfile(createProfile('Studio', { ...EQ, preamp: 0 }), store);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('renames and deletes', () => {
    saveProfile(createProfile('Studio', EQ), store);
    expect(renameProfile('Studio', 'Mastering', store).name).toBe('Mastering');
    expect(getProfile('Studio', store)).toBeNull();
    expect(deleteProfile('Mastering', store)).toBe(true);
    expect(listProfiles(store)).toHaveLength(0);
  });

  it('deep-clones EQ so later mutation cannot corrupt a saved profile', () => {
    const live = JSON.parse(JSON.stringify(EQ));
    saveProfile(createProfile('Studio', live), store);
    live.filters[0].gain = 99;
    expect(getProfile('Studio', store).eq.filters[0].gain).toBe(3);
  });
});

describe('per-device profiles', () => {
  it('normalizes device keys', () => {
    expect(deviceKey('all')).toBe('all');
    expect(deviceKey('')).toBe('all');
    expect(deviceKey(null)).toBe('all');
    expect(deviceKey('  Speakers (Realtek)  ')).toBe('Speakers (Realtek)');
  });

  it('stores EQ *and* settings per device', () => {
    setSetting('autoSaveApo', true, store);
    const profile = createProfile('Headphones', EQ, captureSettings('profile', store));
    setDeviceProfile('Headphones (USB DAC)', profile, store);

    const loaded = getDeviceProfile('Headphones (USB DAC)', store);
    expect(loaded.eq.filters).toHaveLength(2);
    expect(loaded.settings.autoSaveApo).toBe(true);
  });

  it('keeps separate state for separate devices', () => {
    setDeviceProfile('DAC A', createProfile('A', { ...EQ, preamp: -6 }), store);
    setDeviceProfile('DAC B', createProfile('B', { ...EQ, preamp: -1 }), store);
    expect(getDeviceProfile('DAC A', store).eq.preamp).toBe(-6);
    expect(getDeviceProfile('DAC B', store).eq.preamp).toBe(-1);
    expect(Object.keys(getDeviceProfiles(store))).toHaveLength(2);
  });

  it('deletes a device profile without touching others', () => {
    setDeviceProfile('DAC A', createProfile('A', EQ), store);
    setDeviceProfile('DAC B', createProfile('B', EQ), store);
    expect(deleteDeviceProfile('DAC A', store)).toBe(true);
    expect(getDeviceProfile('DAC A', store)).toBeNull();
    expect(getDeviceProfile('DAC B', store)).not.toBeNull();
    expect(deleteDeviceProfile('DAC A', store)).toBe(false);
  });
});

describe('legacy migration', () => {
  it('migrates old eqapoStudio quick presets into profiles', () => {
    const legacy = memStore({
      'eqapoStudio.quickPresets.v1': JSON.stringify([
        { name: 'Old Preset', updatedAt: '2024-01-01T00:00:00.000Z', config: EQ },
      ]),
    });
    const profiles = listProfiles(legacy);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Old Preset');
    expect(profiles[0].eq.filters).toHaveLength(2);
    // Persisted under the new key so migration happens once.
    expect(legacy.getItem(PROFILES_KEY)).toBeTruthy();
  });

  it('migrates old device presets into device profiles', () => {
    const legacy = memStore({
      'neon-equalizer:device-presets:v1': JSON.stringify({
        'Speakers': { name: 'Speakers', device: 'Speakers', config: EQ },
      }),
    });
    const map = getDeviceProfiles(legacy);
    expect(map.Speakers.eq.preamp).toBe(-6);
    expect(legacy.getItem(DEVICE_PROFILES_KEY)).toBeTruthy();
  });

  it('normalizeProfile accepts both legacy {config} and new {eq}', () => {
    expect(normalizeProfile({ name: 'x', config: EQ }).eq.preamp).toBe(-6);
    expect(normalizeProfile({ name: 'x', eq: EQ }).eq.preamp).toBe(-6);
    expect(normalizeProfile(null)).toBeNull();
  });
});

describe('summarizeProfile', () => {
  it('describes what is actually saved', () => {
    const s = summarizeProfile(createProfile('X', EQ, { autoSaveApo: true }));
    expect(s.exists).toBe(true);
    expect(s.filters).toBe(2);
    expect(s.enabledFilters).toBe(1);
    expect(s.graphicEQ).toBe(true);
    expect(s.preamp).toBe(-6);
    expect(s.text).toContain('2 filters');
    expect(s.text).toContain('(1 on)');
    expect(s.text).toContain('preamp -6.0 dB');
    expect(s.text).toContain('1 setting');
  });

  it('reports nothing saved for a missing profile', () => {
    const s = summarizeProfile(null);
    expect(s.exists).toBe(false);
    expect(s.text).toBe('Nothing saved');
  });

  it('does not count a flat graphic EQ as active', () => {
    const flat = { ...EQ, graphicEQ: { enabled: true, bands: [{ frequency: 100, gain: 0 }] } };
    expect(summarizeProfile(createProfile('X', flat)).graphicEQ).toBe(false);
  });

  it('reports an empty profile clearly', () => {
    expect(summarizeProfile(createProfile('X', {})).text).toBe('Empty profile');
  });
});

describe('import / export', () => {
  it('round-trips a profile through JSON', () => {
    const p = createProfile('Studio', EQ, { autoSaveApo: true });
    const imported = importProfile(exportProfile(p));
    expect(imported.name).toBe('Studio');
    expect(imported.eq.filters).toHaveLength(2);
    expect(imported.settings.autoSaveApo).toBe(true);
  });

  it('assigns a fresh id on import so it cannot clobber an existing profile', () => {
    const p = createProfile('Studio', EQ);
    expect(importProfile(exportProfile(p)).id).not.toBe(p.id);
  });

  it('rejects non-profile payloads', () => {
    expect(importProfile('not json')).toBeNull();
    expect(importProfile('{"kind":"something-else","eq":{}}')).toBeNull();
    expect(importProfile('{"name":"no eq here"}')).toBeNull();
  });
});
