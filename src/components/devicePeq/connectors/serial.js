/**
 * USB Serial connector (Web Serial API)
 *
 * Implements the JDS Labs Element IV / Atom 2 JSON protocol (newline-framed
 * JSON over USB-CDC) and leaves room for Nothing's similar protocol. Both
 * expose their PEQ bank as a JSON sub-object over CDC.
 *
 * Vendor detection is by USB VID/PID on `navigator.serial.requestPort()`.
 */

const SERIAL_FILTERS = [
  { usbVendorId: 0x152a },                          // JDS Labs Element IV / Atom 2
  { usbVendorId: 0x2886 },                          // Nothing Ear (2)
  { usbVendorId: 0x0d8c },                          // Texas Instruments CDC (used by some Nothing)
];

let _port = null;
let _reader = null;
let _writer = null;
let _decoder = new TextDecoder();
let _encoder = new TextEncoder();
let _rxBuffer = '';
let _vendor = null; // 'jdslabs' | 'nothing'
let _device = null;
let _slots = [{ id: 0, name: 'Default' }];

// ─── Vendor protocols ───────────────────────────────────────────────────────

const VENDORS = {
  jdslabs: {
    label: 'JDS Labs',
    detect: (info) => info.usbVendorId === 0x152a,
    slots: [
      { id: 0, name: 'PEQ Bank' },
    ],
    // Basic JSON command set used by Element IV.
    async pull() {
      const resp = await sendCommand({ FiiR: { Get: 'FiiR' } });
      const blob = resp?.FiiR?.FiiR || {};
      const filters = [];
      const bands = blob.Bands || blob.bands || [];
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        filters.push({
          type:  b.type  || 'PK',
          freq:  b.freq  || 1000,
          gain:  b.gain  || 0,
          q:     b.q     || 1,
          disabled: b.enabled === false,
        });
      }
      const preamp = blob.preamp || 0;
      return { filters, preamp };
    },
    async push(filters, preamp /*, slot */) {
      const bands = filters.map(f => ({
        type: f.type || 'PK',
        freq: f.freq,
        gain: f.gain,
        q:    f.q,
        enabled: f.disabled ? false : true,
      }));
      await sendCommand({
        FiiR: { Set: { FiiR: { preamp, Bands: bands } } },
      });
      return false;
    },
    async getCurrentSlot() { return 0; },
  },

  nothing: {
    label: 'Nothing',
    detect: (info) => info.usbVendorId === 0x2886,
    slots: [{ id: 0, name: 'Default' }],
    async pull() {
      const resp = await sendCommand({ cmd: 'getEq' });
      const filters = (resp?.eq?.bands || []).map(b => ({
        type: b.type || 'PK',
        freq: b.freq, gain: b.gain, q: b.q,
        disabled: !b.enabled,
      }));
      return { filters, preamp: resp?.eq?.preamp || 0 };
    },
    async push(filters, preamp /*, slot */) {
      const bands = filters.map(f => ({
        type: f.type, freq: f.freq, gain: f.gain, q: f.q,
        enabled: !f.disabled,
      }));
      await sendCommand({ cmd: 'setEq', eq: { preamp, bands } });
      return false;
    },
    async getCurrentSlot() { return 0; },
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sendCommand(cmdObj, timeoutMs = 1500) {
  if (!_writer) throw new Error('Serial port not open.');
  const line = JSON.stringify(cmdObj) + '\r\n';
  await _writer.write(_encoder.encode(line));
  return readLine(timeoutMs);
}

async function readLine(timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nl = _rxBuffer.indexOf('\n');
    if (nl >= 0) {
      const raw = _rxBuffer.slice(0, nl).trim();
      _rxBuffer = _rxBuffer.slice(nl + 1);
      if (!raw) continue;
      try { return JSON.parse(raw); }
      catch { /* skip non-JSON banner lines */ }
    }
    const { value, done } = await _reader.read();
    if (done) break;
    if (value) _rxBuffer += _decoder.decode(value, { stream: true });
  }
  throw new Error('Serial command timeout.');
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function connect() {
  if (!navigator.serial) throw new Error('Web Serial not supported.');

  const port = await navigator.serial.requestPort({ filters: SERIAL_FILTERS });
  if (!port) return null;
  await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });

  const info = port.getInfo();
  const vendor = Object.values(VENDORS).find(v => v.detect(info));
  if (!vendor) {
    await port.close();
    throw new Error(`Unknown serial device vendor 0x${(info.usbVendorId || 0).toString(16)}`);
  }

  _port = port;
  _reader = port.readable.getReader();
  _writer = port.writable.getWriter();
  _rxBuffer = '';
  _vendor = vendor;
  _slots = vendor.slots.slice();

  _device = {
    manufacturer: vendor.label,
    model:        `${vendor.label} (serial)`,
    modelConfig:  {
      maxFilters: 10,
      maxGain:    12,
      supportsLSHSFilters: true,
      availableSlots: _slots.slice(),
    },
    protocol: 'serial',
  };
  return _device;
}

export async function disconnect() {
  try { if (_reader) { await _reader.cancel().catch(() => {}); _reader.releaseLock(); } } catch {}
  try { if (_writer) { _writer.releaseLock(); } } catch {}
  try { if (_port)   { await _port.close(); } } catch {}
  _reader = _writer = _port = null;
  _vendor = _device = null;
}

export function isConnected() { return _device !== null; }
export function getDevice()   { return _device; }
export function getAvailableSlots() { return _slots; }
export async function getCurrentSlot() { return _vendor ? _vendor.getCurrentSlot() : 0; }

export async function push(filters, preamp, slot) {
  if (!_vendor) throw new Error('No serial device connected.');
  return _vendor.push(filters, preamp, slot);
}

export async function pull() {
  if (!_vendor) throw new Error('No serial device connected.');
  const { filters, preamp } = await _vendor.pull();
  const appFilters = filters.map((f, i) => ({
    id: `serial_${Date.now()}_${i}`,
    enabled: !f.disabled,
    type: f.type || 'PK',
    frequency: f.freq, gain: f.gain, q: f.q,
    color: '#00d4ff', index: i,
  }));
  const maxGain = _device?.modelConfig?.maxGain || 12;
  return { filters: appFilters, globalGain: preamp + maxGain };
}
