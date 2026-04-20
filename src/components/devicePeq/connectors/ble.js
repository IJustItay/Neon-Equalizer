/**
 * Bluetooth LE connector (Web Bluetooth API)
 *
 * Supports FiiO BT5, BTR5, BTR7 etc. which expose the same FiiO PEQ opcode
 * table used over USB HID — just wrapped in a proprietary GATT service.
 *
 * Known service/characteristic UUIDs are placed here; if your device uses a
 * different pair, extend BLE_SERVICES below.
 */

const BLE_SERVICES = {
  // FiiO BT vendor service (same 0xAA header/packet format as the HID FIIO
  // protocol). The UUIDs below are the ones FiiO ships in their Android app;
  // confirmed on BTR5/BTR7 but may shift between firmware revisions.
  fiio: {
    serviceUUID: '0000fee0-0000-1000-8000-00805f9b34fb',
    writeUUID:   '0000fee1-0000-1000-8000-00805f9b34fb',
    notifyUUID:  '0000fee2-0000-1000-8000-00805f9b34fb',
    name:        'FiiO BT',
  },
};

let _server = null;
let _service = null;
let _writeChar = null;
let _notifyChar = null;
let _device = null;
let _vendor = null;
let _slots = [
  { id: 0, name: 'Preset 1' },
  { id: 1, name: 'Preset 2' },
  { id: 2, name: 'Preset 3' },
  { id: 3, name: 'User 1'   },
];
let _inflight = null;

function u8(n) { return n & 0xFF; }
function splitU16(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }

// ─── FiiO frame format — mirrors the HID protocol ─────────────────────────
//
//   0xAA 0x0A <cmd> <len_hi> <len_lo> <payload..> <crc> 0xEE
//
function buildFrame(cmd, payload) {
  const len = payload.length;
  const buf = [0xAA, 0x0A, u8(cmd), (len >> 8) & 0xFF, len & 0xFF, ...payload];
  // XOR checksum
  let crc = 0;
  for (const b of buf.slice(2)) crc ^= b;
  buf.push(crc & 0xFF, 0xEE);
  return new Uint8Array(buf);
}

async function sendFrame(cmd, payload, timeoutMs = 1500) {
  if (!_writeChar) throw new Error('BLE write characteristic unavailable.');
  const frame = buildFrame(cmd, payload);
  const waiter = waitForReply(cmd, timeoutMs);
  await _writeChar.writeValue(frame);
  return waiter;
}

function waitForReply(expectedCmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('BLE reply timeout.')); }, timeoutMs);
    const onNotify = (ev) => {
      const data = new Uint8Array(ev.target.value.buffer);
      if (data[0] !== 0xBB && data[0] !== 0xAA) return;
      if (data[2] !== expectedCmd) return;
      cleanup();
      resolve(data);
    };
    function cleanup() {
      clearTimeout(t);
      _notifyChar.removeEventListener('characteristicvaluechanged', onNotify);
    }
    _notifyChar.addEventListener('characteristicvaluechanged', onNotify);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function connect() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported.');

  const device = await navigator.bluetooth.requestDevice({
    filters: Object.values(BLE_SERVICES).map(s => ({ services: [s.serviceUUID] })),
    optionalServices: Object.values(BLE_SERVICES).map(s => s.serviceUUID),
  });
  if (!device) return null;

  _server  = await device.gatt.connect();

  // Try each known vendor service
  for (const [key, spec] of Object.entries(BLE_SERVICES)) {
    try {
      const svc = await _server.getPrimaryService(spec.serviceUUID);
      _writeChar  = await svc.getCharacteristic(spec.writeUUID);
      _notifyChar = await svc.getCharacteristic(spec.notifyUUID);
      await _notifyChar.startNotifications();
      _service = svc;
      _vendor  = key;
      break;
    } catch { /* try next */ }
  }
  if (!_service) {
    await _server.disconnect();
    throw new Error('No matching BLE PEQ service found on this device.');
  }

  _device = {
    manufacturer: BLE_SERVICES[_vendor].name,
    model:        device.name || BLE_SERVICES[_vendor].name,
    modelConfig: {
      maxFilters:  10,
      maxGain:     12,
      supportsLSHSFilters: true,
      availableSlots: _slots.slice(),
    },
    protocol: 'ble',
    rawDevice: device,
  };
  return _device;
}

export async function disconnect() {
  try { if (_notifyChar) await _notifyChar.stopNotifications(); } catch {}
  try { if (_server && _server.connected) _server.disconnect(); } catch {}
  _server = _service = _writeChar = _notifyChar = null;
  _vendor = _device = null;
}

export function isConnected() { return _device !== null; }
export function getDevice()   { return _device; }
export function getAvailableSlots() { return _slots; }
export async function getCurrentSlot() { return 0; }

export async function push(filters, preamp, slot) {
  if (!_device) throw new Error('No BLE device connected.');

  // 1. Set filter count
  await sendFrame(0x18, [filters.length & 0xFF]);
  // 2. Set preset slot
  await sendFrame(0x16, [slot & 0xFF]);
  // 3. Set each filter
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const fi = i & 0xFF;
    const type = { PK: 0, LSQ: 1, HSQ: 2 }[f.type] ?? 0;
    const freq = splitU16(Math.round(f.freq));
    const gainT = Math.round(f.gain * 10);
    const gain = splitU16(gainT < 0 ? ((Math.abs(gainT) ^ 0xFFFF) + 1) & 0xFFFF : gainT);
    const q    = splitU16(Math.round(f.q * 100));
    await sendFrame(0x15, [fi, type, ...freq, ...gain, ...q]);
  }
  // 4. Preamp
  const pT = Math.round((preamp || 0) * 10);
  const p  = splitU16(pT < 0 ? ((Math.abs(pT) ^ 0xFFFF) + 1) & 0xFFFF : pT);
  await sendFrame(0x17, p);
  // 5. Save
  await sendFrame(0x19, []);
  return false;
}

export async function pull() {
  if (!_device) throw new Error('No BLE device connected.');
  const countResp = await sendFrame(0x18, [], 2000);
  const count = countResp[5] || 10;

  const filters = [];
  for (let i = 0; i < count; i++) {
    const resp = await sendFrame(0x15, [i], 2000);
    // Payload begins at byte 5
    const typeByte = resp[6];
    const freq  = (resp[7] << 8) | resp[8];
    let gainRaw = (resp[9] << 8) | resp[10];
    if (gainRaw & 0x8000) gainRaw = -(((gainRaw ^ 0xFFFF) + 1) / 10);
    else gainRaw = gainRaw / 10;
    const q = ((resp[11] << 8) | resp[12]) / 100;
    filters.push({
      type: ['PK', 'LSQ', 'HSQ'][typeByte] || 'PK',
      freq, gain: gainRaw, q,
      disabled: false,
    });
  }
  const preampResp = await sendFrame(0x17, [], 2000);
  let preampRaw = (preampResp[5] << 8) | preampResp[6];
  const preamp = (preampRaw & 0x8000) ? -(((preampRaw ^ 0xFFFF) + 1) / 10) : preampRaw / 10;

  const appFilters = filters.map((f, i) => ({
    id: `ble_${Date.now()}_${i}`,
    enabled: !f.disabled,
    type: f.type, frequency: f.freq, gain: f.gain, q: f.q,
    color: '#00d4ff', index: i,
  }));
  return { filters: appFilters, globalGain: preamp + 12 };
}
