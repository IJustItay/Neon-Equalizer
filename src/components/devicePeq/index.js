/**
 * Device PEQ Manager — multi-connector façade.
 *
 * Drop-in replacement for the legacy `hidManager` singleton. The app now
 * talks to audio hardware over FOUR different browser APIs:
 *
 *   connectorKey = 'hid'     → navigator.hid   (FiiO / Moondrop / KT / WalkPlay)
 *   connectorKey = 'serial'  → navigator.serial (JDS Labs, Nothing, etc.)
 *   connectorKey = 'ble'     → navigator.bluetooth (FiiO BT, Airoha BLE)
 *   connectorKey = 'network' → fetch()         (WiiM & other streamers)
 *
 * The singleton exposed here mirrors the legacy API so callers in main.js only
 * change the import. Internally it routes every call to the active connector
 * selected by `connect(connectorKey, opts)`.
 *
 * Public API:
 *   devicePeq.listConnectors()                    → [{key,label}]
 *   devicePeq.connect(connectorKey, opts)         → Promise<device>
 *   devicePeq.disconnect()                        → Promise<void>
 *   devicePeq.isConnected()                       → boolean
 *   devicePeq.getDevice()                         → device|null
 *   devicePeq.getAvailableSlots()                 → [{id,name}]
 *   devicePeq.getCurrentSlot()                    → Promise<number|null>
 *   devicePeq.push(filters, preamp, slot)         → Promise<boolean disconnected>
 *   devicePeq.pull()                              → Promise<{filters, globalGain}>
 */

import * as hidConnector     from './connectors/hid.js';
import * as serialConnector  from './connectors/serial.js';
import * as bleConnector     from './connectors/ble.js';
import * as networkConnector from './connectors/network.js';

const CONNECTORS = {
  hid:     hidConnector,
  serial:  serialConnector,
  ble:     bleConnector,
  network: networkConnector,
};

const CONNECTOR_META = [
  { key: 'hid',     label: 'USB HID (FiiO, Moondrop, KT)',         available: () => typeof navigator !== 'undefined' && !!navigator.hid       },
  { key: 'serial',  label: 'USB Serial (JDS Labs, Nothing)',        available: () => typeof navigator !== 'undefined' && !!navigator.serial    },
  { key: 'ble',     label: 'Bluetooth LE (FiiO BT)',                available: () => typeof navigator !== 'undefined' && !!navigator.bluetooth },
  { key: 'network', label: 'Network (WiiM, LAN streamers)',         available: () => typeof fetch !== 'undefined'                              },
];

function normalizeDeviceFilterType(type) {
  const raw = String(type || 'PK').trim();
  if (/^(?:LSQ|LS|LSC|Low\s*Shelf|Lowshelf)/i.test(raw)) return 'LSQ';
  if (/^(?:HSQ|HS|HSC|High\s*Shelf|Highshelf)/i.test(raw)) return 'HSQ';
  if (/^(?:PK|PEQ|Peak|Peaking|Modal)/i.test(raw)) return 'PK';
  return null;
}

function normalizeAppFilterType(type) {
  const raw = String(type || 'PK').trim();
  if (/^(?:LSQ|LS|LSC|Low\s*Shelf|Lowshelf)/i.test(raw)) return 'LS';
  if (/^(?:HSQ|HS|HSC|High\s*Shelf|Highshelf)/i.test(raw)) return 'HS';
  return 'PK';
}

function toDeviceFilter(filter) {
  const type = normalizeDeviceFilterType(filter?.type);
  if (!type) return null;

  const freq = Number(filter.frequency ?? filter.freq);
  const gain = Number(filter.gain ?? 0);
  const q = Number(filter.q ?? 1);
  if (!Number.isFinite(freq) || freq <= 0) return null;

  return {
    type,
    freq,
    gain: Number.isFinite(gain) ? gain : 0,
    q: Number.isFinite(q) && q > 0 ? q : 1,
    disabled: filter.enabled === false || filter.disabled === true,
  };
}

function normalizeFiltersForDevice(filters, modelConfig = {}) {
  const maxFilters = Number.isFinite(Number(modelConfig.maxFilters)) ? Number(modelConfig.maxFilters) : filters.length;
  const defaults = modelConfig.defaultResetFiltersValues || [];
  const fallback = defaults[0] || {};
  const out = filters.slice(0, maxFilters).map(filter => {
    const next = { ...filter };
    next.freq = Math.max(20, Math.min(20000, Number(next.freq) || 100));
    next.q = Math.max(0.01, Math.min(100, Number(next.q) || 1));
    next.gain = Number.isFinite(Number(next.gain)) ? Number(next.gain) : 0;
    next.type = normalizeDeviceFilterType(next.type) || 'PK';
    if (modelConfig.supportsLSHSFilters === false && (next.type === 'LSQ' || next.type === 'HSQ')) {
      next.type = 'PK';
      next.gain = 0;
    }
    return next;
  });

  while (out.length < maxFilters && modelConfig.padFilters !== false && defaults.length) {
    out.push({
      type: normalizeDeviceFilterType(fallback.filterType || fallback.type) || 'PK',
      freq: Number(fallback.freq) || 100,
      gain: Number(fallback.gain) || 0,
      q: Number(fallback.q) || 1,
      disabled: fallback.disabled === true,
    });
  }
  return out;
}

function toAppFilter(filter, index) {
  const freq = Number(filter?.frequency ?? filter?.freq);
  const gain = Number(filter?.gain ?? 0);
  const q = Number(filter?.q ?? 1);

  return {
    id: filter?.id || `device_${Date.now()}_${index}`,
    enabled: filter?.enabled !== false && filter?.disabled !== true,
    type: normalizeAppFilterType(filter?.type),
    frequency: Number.isFinite(freq) && freq > 0 ? freq : 1000,
    gain: Number.isFinite(gain) ? gain : 0,
    q: Number.isFinite(q) && q > 0 ? q : 1,
    bw: filter?.bw ?? null,
    color: filter?.color || '#00d4ff',
    index,
  };
}

class DevicePeqManager {
  constructor() {
    this._active = null;   // currently-connected connector key
    this._device = null;
  }

  listConnectors() {
    return CONNECTOR_META.map(m => ({ ...m, available: m.available() }));
  }

  async connect(connectorKey, opts = {}) {
    await this.disconnect();
    const c = CONNECTORS[connectorKey];
    if (!c) throw new Error(`Unknown connector: ${connectorKey}`);
    const dev = await c.connect(opts);
    if (!dev) return null;
    this._active = connectorKey;
    this._device = dev;
    return dev;
  }

  async disconnect() {
    if (!this._active) return;
    try {
      await CONNECTORS[this._active].disconnect();
    } catch (e) {
      console.warn('[devicePeq] disconnect error:', e);
    }
    this._active = null;
    this._device = null;
  }

  isConnected() { return this._device !== null; }
  getDevice()   { return this._device; }

  getAvailableSlots() {
    if (!this._active) return [];
    return CONNECTORS[this._active].getAvailableSlots() || [];
  }

  async getCurrentSlot() {
    if (!this._active) return null;
    try { return await CONNECTORS[this._active].getCurrentSlot(); }
    catch { return null; }
  }

  async push(filters, preamp, slot) {
    if (!this._active) throw new Error('No device connected.');
    const compatible = (filters || []).map(toDeviceFilter).filter(Boolean);
    const deviceFilters = normalizeFiltersForDevice(compatible, this._device?.modelConfig || {});
    if (!deviceFilters.length) {
      throw new Error('No PEQ-compatible filters to push. Devices accept peaking and low/high shelf filters.');
    }
    const disconnected = await CONNECTORS[this._active].push(deviceFilters, preamp, slot);
    if (disconnected) { this._active = null; this._device = null; }
    return disconnected;
  }

  async pull() {
    if (!this._active) throw new Error('No device connected.');
    const result = await CONNECTORS[this._active].pull();
    const maxGain = this._device?.modelConfig?.maxGain || 12;
    const globalGain = Number.isFinite(Number(result?.globalGain))
      ? Number(result.globalGain)
      : Number(result?.preamp || 0) + maxGain;
    return {
      ...result,
      globalGain,
      filters: (result?.filters || []).map(toAppFilter),
    };
  }
}

export const devicePeq = new DevicePeqManager();
export default devicePeq;
