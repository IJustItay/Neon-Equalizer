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
    const disconnected = await CONNECTORS[this._active].push(filters, preamp, slot);
    if (disconnected) { this._active = null; this._device = null; }
    return disconnected;
  }

  async pull() {
    if (!this._active) throw new Error('No device connected.');
    return CONNECTORS[this._active].pull();
  }
}

export const devicePeq = new DevicePeqManager();
export default devicePeq;
