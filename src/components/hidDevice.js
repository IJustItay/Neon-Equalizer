/**
 * HID Device PEQ Manager
 *
 * WebHID-based parametric EQ control for audio devices.
 * Ported from modernGraphTool (IJustItay/modernGraphTool) — bundles FiiO,
 * WalkPlay, Moondrop, and KT Micro protocols into a single module.
 *
 * Public API (consumed by main.js):
 *   hidManager.connect()            — open picker, return {manufacturer, model, modelConfig, …}
 *   hidManager.disconnect()
 *   hidManager.isConnected()
 *   hidManager.getDevice()
 *   hidManager.getAvailableSlots()  — [{id, name}]
 *   hidManager.getCurrentSlot()     — Promise<number>
 *   hidManager.push(filters, preamp, slot)       — Promise<bool disconnected>
 *   hidManager.pull()               — Promise<{filters, globalGain}>
 */

// ═════════════════════════════════════════════════════════════════════════════
// Filter format helpers (convert between app and device formats)
// ═════════════════════════════════════════════════════════════════════════════

function normalizeDeviceFilterType(type) {
  const raw = String(type || 'PK').trim();
  if (/^(?:LSQ|LS|LSC|Low\s*Shelf|Lowshelf)/i.test(raw)) return 'LSQ';
  if (/^(?:HSQ|HS|HSC|High\s*Shelf|Highshelf)/i.test(raw)) return 'HSQ';
  if (/^(?:PK|PEQ|Peak|Peaking|Modal)/i.test(raw)) return 'PK';
  return 'PK';
}

function normalizeAppFilterType(type) {
  const normalized = normalizeDeviceFilterType(type);
  if (normalized === 'LSQ') return 'LS';
  if (normalized === 'HSQ') return 'HS';
  return 'PK';
}

function toDeviceFilter(f) {
  return {
    type:    normalizeDeviceFilterType(f.type),
    freq:    f.frequency || f.freq || 1000,
    gain:    f.gain || 0,
    q:       f.q || 1,
    disabled: f.enabled === false || f.disabled === true,
  };
}

function toAppFilter(f, i) {
  return {
    id:        `hid_${Date.now()}_${i}`,
    enabled:   !(f.disabled),
    type:      normalizeAppFilterType(f.type),
    frequency: f.freq || 1000,
    gain:      f.gain || 0,
    q:         f.q    || 1,
    color:     '#00d4ff',
    index:     i,
  };
}

function sanitizeFilters(filters, maxFilters, modelConfig) {
  const out = filters.slice(0, maxFilters).map(f => ({
    ...f,
    type: normalizeDeviceFilterType(f.type),
  }));
  for (const f of out) {
    if (f.freq < 20 || f.freq > 20000) f.freq = 100;
    if (f.q < 0.01 || f.q > 100)       f.q = 1;
  }
  // Convert LS/HS → PK flat if device doesn't support
  if (modelConfig.supportsLSHSFilters === false) {
    for (const f of out) {
      if (f.type === 'LSQ' || f.type === 'HSQ') {
        f.type = 'PK'; f.gain = 0;
      }
    }
  }
  // Pad with defaults
  if (out.length < maxFilters && modelConfig.defaultResetFiltersValues) {
    const def = modelConfig.defaultResetFiltersValues[0];
    while (out.length < maxFilters) {
      out.push({
        type: normalizeDeviceFilterType(def.filterType || def.type),
        freq: def.freq || 100,
        gain: def.gain || 0,
        q:    def.q    || 1,
        disabled: false,
      });
    }
  }
  return out;
}

function normalizedBiquadCoeffs(type, freq, gain, q, sampleRate = 96000) {
  type = normalizeDeviceFilterType(type);
  freq = Math.max(1e-6, Math.min(Number(freq) || 1000, sampleRate / 2 - 1));
  gain = Math.max(-40, Math.min(Number(gain) || 0, 40));
  q = Math.max(1e-4, Math.min(Number(q) || 1, 1000));

  const w0 = (2 * Math.PI * freq) / sampleRate;
  const sinW0 = Math.sin(w0);
  const cosW0 = Math.cos(w0);
  const a = Math.pow(10, gain / 40);
  const alpha = sinW0 / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (type === 'LSQ') {
    const shelfAlpha = 2 * Math.sqrt(a) * alpha;
    b0 = a * ((a + 1) - (a - 1) * cosW0 + shelfAlpha);
    b1 = 2 * a * ((a - 1) - (a + 1) * cosW0);
    b2 = a * ((a + 1) - (a - 1) * cosW0 - shelfAlpha);
    a0 = (a + 1) + (a - 1) * cosW0 + shelfAlpha;
    a1 = -2 * ((a - 1) + (a + 1) * cosW0);
    a2 = (a + 1) + (a - 1) * cosW0 - shelfAlpha;
  } else if (type === 'HSQ') {
    const shelfAlpha = 2 * Math.sqrt(a) * alpha;
    b0 = a * ((a + 1) + (a - 1) * cosW0 + shelfAlpha);
    b1 = -2 * a * ((a - 1) + (a + 1) * cosW0);
    b2 = a * ((a + 1) + (a - 1) * cosW0 - shelfAlpha);
    a0 = (a + 1) - (a - 1) * cosW0 + shelfAlpha;
    a1 = 2 * ((a - 1) - (a + 1) * cosW0);
    a2 = (a + 1) - (a - 1) * cosW0 - shelfAlpha;
  } else {
    b0 = 1 + alpha * a;
    b1 = -2 * cosW0;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cosW0;
    a2 = 1 - alpha / a;
  }

  return {
    a: [1, a1 / a0, a2 / a0],
    b: [b0 / a0, b1 / a0, b2 / a0],
  };
}

function quantizeBiquadForDevice(type, freq, gain, q) {
  const coeffs = normalizedBiquadCoeffs(type, freq, gain, q);
  return [
    coeffs.b[0],
    coeffs.b[1],
    coeffs.b[2],
    -coeffs.a[1],
    -coeffs.a[2],
  ].map(c => Math.round(c * 1073741824));
}

// ═════════════════════════════════════════════════════════════════════════════
// FiiO protocol
// ═════════════════════════════════════════════════════════════════════════════

const FIIO = (() => {
  const PEQ_FILTER_COUNT   = 0x18;
  const PEQ_GLOBAL_GAIN    = 0x17;
  const PEQ_FILTER_PARAMS  = 0x15;
  const PEQ_PRESET_SWITCH  = 0x16;
  const PEQ_SAVE_TO_DEVICE = 0x19;
  const SET_HEADER1 = 0xAA, SET_HEADER2 = 0x0A;
  const GET_HEADER1 = 0xBB, GET_HEADER2 = 0x0B;
  const END_HEADERS = 0xEE;

  function reportId(mc) { return mc.reportId !== undefined ? mc.reportId : 7; }
  function splitU16(v)  { return [(v >> 8) & 0xFF, v & 0xFF]; }
  function combine(h,l) { return (h << 8) | l; }
  function gainBytes(gain) {
    let t = Math.round(gain * 10);
    if (t < 0) t = ((Math.abs(t) ^ 0xFFFF) + 1) & 0xFFFF;
    return [(t >> 8) & 0xFF, t & 0xFF];
  }
  function handleGain(h, l) {
    const r = combine(h, l);
    return r & 0x8000 ? -(((r ^ 0xFFFF) + 1) / 10) : r / 10;
  }
  const TYPE_TO_CODE = { PK: 0, LSQ: 1, HSQ: 2 };
  const CODE_TO_TYPE = ['PK', 'LSQ', 'HSQ'];

  async function send(dev, rid, packet) {
    await dev.sendReport(rid, new Uint8Array(packet));
  }
  async function setGlobalGain(dev, rid, gain) {
    const [h, l] = splitU16(Math.round(gain * 10) & 0xFFFF);
    // note: FiiO expects low,high order here (same as reference)
    await send(dev, rid, [SET_HEADER1, SET_HEADER2, 0, 0, PEQ_GLOBAL_GAIN, 2, h, l, 0, END_HEADERS]);
  }
  async function setFilterCount(dev, rid, n) {
    await send(dev, rid, [SET_HEADER1, SET_HEADER2, 0, 0, PEQ_FILTER_COUNT, 1, n, 0, END_HEADERS]);
  }
  async function setFilterParams(dev, rid, idx, freq, gain, q, type) {
    const [fH, fL] = splitU16(Math.round(freq));
    const [gH, gL] = gainBytes(gain);
    const [qH, qL] = splitU16(Math.round(q * 100));
    await send(dev, rid, [
      SET_HEADER1, SET_HEADER2, 0, 0, PEQ_FILTER_PARAMS, 8,
      idx, gH, gL, fH, fL, qH, qL, TYPE_TO_CODE[type] ?? 0, 0, END_HEADERS,
    ]);
  }
  async function saveToDevice(dev, rid, slot) {
    await send(dev, rid, [SET_HEADER1, SET_HEADER2, 0, 0, PEQ_SAVE_TO_DEVICE, 1, slot, 0, END_HEADERS]);
  }
  async function getPreset(dev, rid) {
    await send(dev, rid, [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_PRESET_SWITCH, 0, 0, END_HEADERS]);
  }
  async function getGlobalGain(dev, rid) {
    await send(dev, rid, [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_GLOBAL_GAIN, 0, 0, END_HEADERS]);
  }
  async function getFilterCount(dev, rid) {
    await send(dev, rid, [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_FILTER_COUNT, 0, 0, END_HEADERS]);
  }
  async function getFilterParams(dev, rid, idx) {
    await send(dev, rid, [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_FILTER_PARAMS, 1, idx, 0, END_HEADERS]);
  }

  function waitFor(cond, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FiiO response timeout')), timeout);
      const iv = setInterval(() => {
        if (cond()) { clearTimeout(timer); clearInterval(iv); resolve(); }
      }, 100);
    });
  }

  return {
    async push(dd, slot, preamp, filtersIn) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const rid = reportId(mc);
      const filters = sanitizeFilters(filtersIn, mc.maxFilters, mc);

      // FiiO trick: write globalGain = maxGain + preamp (preamp is negative for headroom)
      await setGlobalGain(dev, rid, (mc.maxGain || 12) + (preamp || 0));
      await setFilterCount(dev, rid, filters.length);
      await new Promise(r => setTimeout(r, 100));

      for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const g = f.disabled ? 0 : f.gain;
        await setFilterParams(dev, rid, i, f.freq, g, f.q, f.type);
      }
      await new Promise(r => setTimeout(r, 100));
      await saveToDevice(dev, rid, slot);

      return !!mc.disconnectOnSave;
    },

    async pull(dd) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const rid = reportId(mc);
      const filters = [];
      let peqCount = 0;
      let rawGlobalGain = 0;

      dev.oninputreport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d[0] !== GET_HEADER1 || d[1] !== GET_HEADER2) return;
        switch (d[4]) {
          case PEQ_FILTER_COUNT:
            peqCount = d[6];
            for (let i = 0; i < peqCount; i++) getFilterParams(dev, rid, i);
            break;
          case PEQ_FILTER_PARAMS: {
            const idx = d[6];
            filters[idx] = {
              type: CODE_TO_TYPE[d[13]] || 'PK',
              gain: handleGain(d[7], d[8]),
              freq: combine(d[9], d[10]),
              q:    combine(d[11], d[12]) / 100 || 1,
              disabled: false,
            };
            filters[idx].disabled = !(filters[idx].gain || filters[idx].freq || filters[idx].q);
            break;
          }
          case PEQ_GLOBAL_GAIN:
            rawGlobalGain = handleGain(d[6], d[7]);
            break;
        }
      };

      await getPreset(dev, rid);
      await getFilterCount(dev, rid);
      await getGlobalGain(dev, rid);

      try { await waitFor(() => filters.length === peqCount && peqCount > 0); }
      catch (_) {}

      // Preamp = rawGlobalGain - maxGain (reverse of the push trick)
      const preamp = rawGlobalGain - (mc.maxGain || 12);
      return { filters: filters.filter(Boolean), preamp };
    },

    async getCurrentSlot(dd) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const rid = reportId(mc);
      let slot = null;

      dev.oninputreport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d[0] !== GET_HEADER1 || d[1] !== GET_HEADER2) return;
        if (d[4] === PEQ_PRESET_SWITCH) {
          slot = (d[6] === mc.disabledPresetId) ? -1 : d[6];
        }
      };
      await getPreset(dev, rid);
      try { await waitFor(() => slot !== null, 5000); } catch (_) { slot = 0; }
      return slot;
    },
  };
})();

// ═════════════════════════════════════════════════════════════════════════════
// WalkPlay protocol
// ═════════════════════════════════════════════════════════════════════════════

const WALKPLAY = (() => {
  const REPORT_ID = 0x4B;
  const READ = 0x80, WRITE = 0x01, END = 0x00;
  const CMD = {
    PEQ_VALUES:   0x09,
    VERSION:      0x0C,
    TEMP_WRITE:   0x0A,
    FLASH_EQ:     0x01,
    GLOBAL_GAIN:  0x03,
  };
  const TYPE_TO_CODE = { PK: 2, LSQ: 1, HSQ: 3 };
  const CODE_TO_TYPE = { 1: 'LSQ', 2: 'PK', 3: 'HSQ' };

  async function sendReport(dev, rid, packet) {
    await dev.sendReport(rid, new Uint8Array(packet));
  }

  function computeIIR(freq, gain, q, type = 'PK') {
    const bArr = new Array(20).fill(0);
    const qd = quantizeBiquadForDevice(type, freq, gain, q);
    let idx = 0;
    for (const v of qd) {
      bArr[idx]     = v & 0xFF;
      bArr[idx + 1] = (v >> 8)  & 0xFF;
      bArr[idx + 2] = (v >> 16) & 0xFF;
      bArr[idx + 3] = (v >> 24) & 0xFF;
      idx += 4;
    }
    return bArr;
  }

  function u16LE(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
  function s16LE(v) {
    if (v < 0) v += 0x10000;
    return [v & 0xFF, (v >> 8) & 0xFF];
  }

  async function waitForResp(dev, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject('Walkplay timeout'), timeout);
      dev.oninputreport = (ev) => {
        clearTimeout(timer);
        resolve(new Uint8Array(ev.data.buffer));
      };
    });
  }

  async function readGlobalGain(dev) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        dev.removeEventListener('inputreport', onReport);
        reject('Walkplay global gain timeout');
      }, 500);
      const onReport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d[0] !== READ || d[1] !== CMD.GLOBAL_GAIN) return;
        clearTimeout(timer);
        dev.removeEventListener('inputreport', onReport);
        resolve(new Int8Array([d[4]])[0]);
      };
      dev.addEventListener('inputreport', onReport);
      await sendReport(dev, REPORT_ID, [READ, CMD.GLOBAL_GAIN, END]);
    });
  }
  async function writeGlobalGain(dev, value) {
    const g = Math.round(value);
    await sendReport(dev, REPORT_ID, [WRITE, CMD.GLOBAL_GAIN, 0x02, 0x00, g & 0xFF]);
  }

  function parseFilterPacket(pkt) {
    const freq = pkt[27] | (pkt[28] << 8);
    const qRaw = pkt[29] | (pkt[30] << 8);
    const q = Math.round((qRaw / 256) * 10) / 10;
    let gainRaw = pkt[31] | (pkt[32] << 8);
    if (gainRaw > 32767) gainRaw -= 65536;
    const gain = Math.round((gainRaw / 256) * 10) / 10;
    const type = CODE_TO_TYPE[pkt[33]] || 'PK';
    return {
      filterIndex: pkt[4],
      freq, q, gain, type,
      disabled: !(freq || q || gain),
    };
  }

  return {
    async push(dd, slot, preamp, filtersIn) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const filters = sanitizeFilters(filtersIn, mc.maxFilters, mc);
      const slotByte = (mc && typeof mc.defaultIndex !== 'undefined') ? mc.defaultIndex : (parseInt(slot, 10) || 0);

      for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const coeffs = computeIIR(f.freq, f.disabled ? 0 : f.gain, f.q, f.type);
        const packet = [
          WRITE, CMD.PEQ_VALUES, 0x18, 0x00, i, 0x00, 0x00,
          ...coeffs,
          ...u16LE(f.freq),
          ...u16LE(Math.round(f.q * 256)),
          ...s16LE(Math.round((f.disabled ? 0 : f.gain) * 256)),
          TYPE_TO_CODE[f.type] ?? 2,
          0x00,
          slotByte,
          END,
        ];
        await sendReport(dev, REPORT_ID, packet);
      }

      await writeGlobalGain(dev, preamp || 0);
      await sendReport(dev, REPORT_ID, [WRITE, CMD.TEMP_WRITE, 0x04, 0x00, 0x00, 0xFF, 0xFF, END]);
      await sendReport(dev, REPORT_ID, [WRITE, CMD.FLASH_EQ, 0x01, END]);

      return !!mc.disconnectOnSave;
    },

    async pull(dd) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const filters = [];

      dev.oninputreport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d.length >= 32) {
          try {
            const p = parseFilterPacket(d);
            if (p.filterIndex < mc.maxFilters) filters[p.filterIndex] = p;
          } catch (_) {}
        }
      };

      for (let i = 0; i < mc.maxFilters; i++) {
        await sendReport(dev, REPORT_ID, [READ, CMD.PEQ_VALUES, 0x00, 0x00, i, END]);
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 200));
      dev.oninputreport = null;

      let preamp = 0;
      try { preamp = await readGlobalGain(dev); } catch (_) {}

      const out = [];
      for (let i = 0; i < mc.maxFilters; i++) if (filters[i]) out.push(filters[i]);
      return { filters: out, preamp };
    },

    async getCurrentSlot(dd) {
      const dev = dd.rawDevice;
      try {
        await sendReport(dev, REPORT_ID, [READ, CMD.PEQ_VALUES, END]);
        const resp = await waitForResp(dev, 1500);
        dev.oninputreport = null;
        return resp ? resp[35] : 0;
      } catch (_) {
        dev.oninputreport = null;
        return 0;
      }
    },
  };
})();

// ═════════════════════════════════════════════════════════════════════════════
// Moondrop protocol
// ═════════════════════════════════════════════════════════════════════════════

const MOONDROP = (() => {
  const REPORT_ID = 0x4B;
  const WRITE = 1;
  const READ  = 128;
  const CMD_UPDATE_EQ         = 9;
  const CMD_EQ_COEFF_TO_REG   = 10;
  const CMD_SAVE_EQ_TO_FLASH  = 1;
  const CMD_SET_DAC_OFFSET    = 3;
  const TYPE_TO_CODE = { PK: 2, LSQ: 1, HSQ: 3 };
  const CODE_TO_TYPE = { 1: 'LSQ', 2: 'PK', 3: 'HSQ' };

  function encodeBiquad(freq, gain, q, type = 'PK') {
    return quantizeBiquadForDevice(type, freq, gain, q);
  }
  function coeffsToBytes(coeffs) {
    const arr = new Uint8Array(20);
    for (let i = 0; i < coeffs.length; i++) {
      const v = coeffs[i];
      arr[i * 4]     = v & 0xFF;
      arr[i * 4 + 1] = (v >> 8) & 0xFF;
      arr[i * 4 + 2] = (v >> 16) & 0xFF;
      arr[i * 4 + 3] = (v >> 24) & 0xFF;
    }
    return arr;
  }

  function buildWritePacket(idx, f) {
    const p = new Uint8Array(63);
    p[0] = WRITE;
    p[1] = CMD_UPDATE_EQ;
    p[2] = 0x18;
    p[3] = 0x00;
    p[4] = idx;
    p[5] = 0x00;
    p[6] = 0x00;
    p.set(coeffsToBytes(encodeBiquad(f.freq, f.gain, f.q, f.type)), 7);
    p[27] = f.freq & 0xFF;
    p[28] = (f.freq >> 8) & 0xFF;
    p[29] = Math.round((f.q % 1) * 256);
    p[30] = Math.floor(f.q);
    p[31] = Math.round((f.gain % 1) * 256);
    p[32] = Math.floor(f.gain);
    p[33] = TYPE_TO_CODE[f.type] ?? 2;
    p[34] = 0;
    p[35] = 7;
    return p;
  }
  function buildEnablePacket(idx) {
    const p = new Uint8Array(63);
    p[0] = WRITE;
    p[1] = CMD_EQ_COEFF_TO_REG;
    p[2] = idx;
    p[3] = 0;
    p[4] = 255; p[5] = 255; p[6] = 255;
    return p;
  }

  function buildReadPacket(idx) {
    return new Uint8Array([READ, CMD_UPDATE_EQ, 0x18, 0x00, idx, 0x00]);
  }

  function decodeResp(data) {
    const e = new Int8Array(data.buffer);
    const freq = (e[27] & 0xFF) | ((e[28] & 0xFF) << 8);
    const q = (e[30] & 0xFF) + (e[29] & 0xFF) / 256;
    const gain = Math.floor((e[32] + (e[31] & 0xFF) / 256) * 10) / 10;
    const type = CODE_TO_TYPE[e[33]] || 'PK';
    const valid = freq > 10 && freq < 24000 && !isNaN(gain) && !isNaN(q);
    return {
      type,
      freq: valid ? freq : 0,
      q:    valid ? q : 1,
      gain: valid ? gain : 0,
      disabled: !valid,
    };
  }

  async function readFilter(dev, idx) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        dev.removeEventListener('inputreport', onReport);
        reject('Moondrop read timeout');
      }, 1000);
      const onReport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d[0] !== READ || d[1] !== CMD_UPDATE_EQ) return;
        clearTimeout(timer);
        dev.removeEventListener('inputreport', onReport);
        resolve(decodeResp(d));
      };
      dev.addEventListener('inputreport', onReport);
      await dev.sendReport(REPORT_ID, buildReadPacket(idx));
    });
  }

  async function readPregain(dev) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        dev.removeEventListener('inputreport', onReport);
        reject('Moondrop pregain timeout');
      }, 1000);
      const onReport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d[0] !== READ || d[1] !== CMD_SET_DAC_OFFSET) return;
        clearTimeout(timer);
        dev.removeEventListener('inputreport', onReport);
        // Signed byte
        let v = d[4];
        if (v > 127) v -= 256;
        resolve(v);
      };
      dev.addEventListener('inputreport', onReport);
      await dev.sendReport(REPORT_ID, new Uint8Array([READ, CMD_SET_DAC_OFFSET]));
    });
  }

  async function writePregain(dev, value) {
    const v = Math.round(value);
    const byte = v < 0 ? (v + 256) & 0xFF : v & 0xFF;
    await dev.sendReport(REPORT_ID, new Uint8Array([WRITE, CMD_SET_DAC_OFFSET, 0x02, 0x00, byte]));
  }

  return {
    async push(dd, slot, preamp, filtersIn) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const filters = sanitizeFilters(filtersIn, mc.maxFilters, mc);

      for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const fx = { ...f, gain: f.disabled ? 0 : f.gain };
        await dev.sendReport(REPORT_ID, buildWritePacket(i, fx));
        await dev.sendReport(REPORT_ID, buildEnablePacket(i));
      }

      await writePregain(dev, preamp || 0);
      await dev.sendReport(REPORT_ID, new Uint8Array([WRITE, CMD_SAVE_EQ_TO_FLASH]));
      return !!mc.disconnectOnSave;
    },

    async pull(dd) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const filters = [];
      for (let i = 0; i < mc.maxFilters; i++) {
        try { filters.push(await readFilter(dev, i)); }
        catch (_) { break; }
      }
      let preamp = 0;
      try { preamp = await readPregain(dev); } catch (_) {}
      return { filters: filters.filter(Boolean), preamp };
    },

    async getCurrentSlot(dd) {
      const dev = dd.rawDevice;
      return new Promise(async (resolve) => {
        const timer = setTimeout(() => {
          dev.removeEventListener('inputreport', onReport);
          resolve(0);
        }, 1000);
        const onReport = (ev) => {
          const d = new Uint8Array(ev.data.buffer);
          if (d[0] !== 0x80 || d[1] !== 0x0F) return;
          clearTimeout(timer);
          dev.removeEventListener('inputreport', onReport);
          resolve(d[3]);
        };
        dev.addEventListener('inputreport', onReport);
        await dev.sendReport(REPORT_ID, new Uint8Array([0x80, 0x0F, 0x00]));
      });
    },
  };
})();

// ═════════════════════════════════════════════════════════════════════════════
// KT Micro protocol
// ═════════════════════════════════════════════════════════════════════════════

const KTMICRO = (() => {
  const REPORT_ID     = 0x4B;
  const CMD_READ      = 0x52;
  const CMD_WRITE     = 0x57;
  const CMD_COMMIT    = 0x53;
  const CMD_CLEAR     = 0x43;

  function u16LE(v)          { return [v & 0xFF, (v >> 8) & 0xFF]; }
  function s16LE(v) {
    let x = Math.round(v);
    if (x < 0) x += 0x10000;
    return [x & 0xFF, (x >> 8) & 0xFF];
  }

  function buildReadPacket(field) {
    return new Uint8Array([field, 0, 0, 0, CMD_READ, 0, 0, 0, 0]);
  }
  function buildReadGlobal() {
    return new Uint8Array([0x66, 0, 0, 0, CMD_READ, 0, 0, 0, 0]);
  }
  function buildWriteGlobal() {
    return new Uint8Array([0x66, 0, 0, 0, CMD_WRITE, 0, 0, 0, 0]);
  }
  function buildEnableEQPacket(slotId) {
    return new Uint8Array([0x24, 0, 0, 0, CMD_WRITE, 0, slotId, 0, 0, 0]);
  }
  function buildReadEQPacket() {
    return new Uint8Array([0x24, 0, 0, 0, CMD_READ, 0, 0x03, 0, 0, 0]);
  }
  function buildWritePacket(filterId, freq, gain) {
    const [fL, fH] = u16LE(Math.round(freq));
    const [gL, gH] = s16LE(Math.round(gain * 10));
    return new Uint8Array([filterId, 0, 0, 0, CMD_WRITE, 0, gL, gH, fL, fH]);
  }
  function buildQPacket(filterId, q, type) {
    const [qL, qH] = u16LE(Math.round(q * 1000));
    let tv = 0;
    if (type === 'LSQ') tv = 3;
    else if (type === 'HSQ') tv = 4;
    return new Uint8Array([filterId, 0, 0, 0, CMD_WRITE, 0, qL, qH, tv, 0]);
  }
  function buildCommand(code) {
    return new Uint8Array([0, 0, 0, 0, code, 0, 0, 0, 0, 0]);
  }

  async function readFilter(dev, idx, compensate2X) {
    const gfId = 0x26 + idx * 2;
    const qId  = gfId + 1;
    return new Promise(async (resolve, reject) => {
      const result = {};
      const timer = setTimeout(() => {
        dev.removeEventListener('inputreport', onReport);
        reject('KTMicro read timeout');
      }, 1000);
      const onReport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        if (d[4] !== CMD_READ) return;
        if (d[0] === gfId) {
          const rawG = d[6] | (d[7] << 8);
          const gain = (rawG > 0x7FFF ? rawG - 0x10000 : rawG) / 10;
          let freq = d[8] + (d[9] << 8);
          if (compensate2X) freq *= 2;
          Object.assign(result, { gain, freq });
        } else if (d[0] === qId) {
          const q = (d[6] + (d[7] << 8)) / 1000;
          let type = 'PK';
          if (d[8] === 3) type = 'LSQ';
          else if (d[8] === 4) type = 'HSQ';
          Object.assign(result, { q, type });
        }
        if ('gain' in result && 'freq' in result && 'q' in result && 'type' in result) {
          clearTimeout(timer);
          dev.removeEventListener('inputreport', onReport);
          result.disabled = !(result.gain || result.freq);
          resolve(result);
        }
      };
      dev.addEventListener('inputreport', onReport);
      await dev.sendReport(REPORT_ID, buildReadPacket(gfId));
      await dev.sendReport(REPORT_ID, buildReadPacket(qId));
    });
  }

  async function readPregain(dev) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        dev.removeEventListener('inputreport', onReport);
        reject('KTMicro pregain timeout');
      }, 1000);
      const onReport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        clearTimeout(timer);
        dev.removeEventListener('inputreport', onReport);
        let v = d[6];
        if (v > 127) v -= 256;
        resolve(v);
      };
      dev.addEventListener('inputreport', onReport);
      await dev.sendReport(REPORT_ID, buildReadGlobal());
    });
  }

  async function writePregain(dev, value) {
    const req = buildWriteGlobal();
    let v = Math.round(value);
    if (v < 0) v &= 0xFF;
    req[6] = v;
    await dev.sendReport(REPORT_ID, req);
  }

  async function enablePEQ(dd, enable, slotId) {
    const dev = dd.rawDevice;
    const mc = dd.modelConfig;
    if (!enable || slotId === mc.disabledPresetId) {
      slotId = mc.disabledPresetId;
    }
    await dev.sendReport(REPORT_ID, buildEnableEQPacket(slotId));
  }

  async function getCurrentSlotInternal(dd) {
    const dev = dd.rawDevice;
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        dev.removeEventListener('inputreport', onReport);
        reject('KTMicro slot timeout');
      }, 1000);
      const onReport = (ev) => {
        const d = new Uint8Array(ev.data.buffer);
        clearTimeout(timer);
        dev.removeEventListener('inputreport', onReport);
        resolve(d[6]);
      };
      dev.addEventListener('inputreport', onReport);
      await dev.sendReport(REPORT_ID, buildReadEQPacket());
    });
  }

  return {
    async push(dd, slot, preamp, filtersIn) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const filters = sanitizeFilters(filtersIn, mc.maxFilters, mc);

      try {
        const cur = await getCurrentSlotInternal(dd);
        if (cur === mc.disabledPresetId) {
          const firstSlot = mc.availableSlots[0].id;
          await enablePEQ(dd, true, firstSlot);
          slot = firstSlot;
        }
      } catch (_) { /* best effort */ }

      for (let i = 0; i < filters.length && i < mc.maxFilters; i++) {
        const filterId = 0x26 + i * 2;
        let freq = filters[i].freq;
        if (mc.compensate2X) freq = freq / 2;
        const gain = filters[i].disabled ? 0 : filters[i].gain;
        await dev.sendReport(REPORT_ID, buildWritePacket(filterId, freq, gain));
        await dev.sendReport(REPORT_ID, buildQPacket(filterId + 1, filters[i].q, filters[i].type));
      }

      if (mc.supportsPregain) {
        await writePregain(dev, preamp || 0);
      }

      await dev.sendReport(REPORT_ID, buildCommand(CMD_COMMIT));
      await new Promise(r => setTimeout(r, 500));

      return !!mc.disconnectOnSave;
    },

    async pull(dd) {
      const dev = dd.rawDevice;
      const mc  = dd.modelConfig;
      const filters = [];
      for (let i = 0; i < mc.maxFilters; i++) {
        try { filters.push(await readFilter(dev, i, mc.compensate2X)); }
        catch (_) { break; }
      }
      let preamp = 0;
      if (mc.supportsPregain) {
        try { preamp = await readPregain(dev); } catch (_) {}
      }
      return { filters: filters.filter(Boolean), preamp };
    },

    async getCurrentSlot(dd) {
      try { return await getCurrentSlotInternal(dd); } catch (_) { return 0; }
    },

    enablePEQ,
  };
})();

// ═════════════════════════════════════════════════════════════════════════════
// Device configurations (vendor IDs + per-model configs)
// ═════════════════════════════════════════════════════════════════════════════

const COMMON_FIIO_SLOTS = [
  { id: 0, name: 'Jazz' }, { id: 1, name: 'Pop' }, { id: 2, name: 'Rock' },
  { id: 3, name: 'Dance' }, { id: 4, name: 'R&B' }, { id: 5, name: 'Classic' },
  { id: 6, name: 'Hip-hop' }, { id: 7, name: 'Monitor' },
  { id: 160, name: 'USER1' }, { id: 161, name: 'USER2' }, { id: 162, name: 'USER3' },
  { id: 163, name: 'USER4' }, { id: 164, name: 'USER5' },
];
const FIIO_USER_ONLY_SLOTS = [
  { id: 0, name: 'Jazz' }, { id: 1, name: 'Pop' }, { id: 2, name: 'Rock' },
  { id: 3, name: 'Dance' }, { id: 4, name: 'R&B' }, { id: 5, name: 'Classic' },
  { id: 6, name: 'Hip-hop' },
  { id: 7, name: 'USER1' }, { id: 8, name: 'USER2' }, { id: 9, name: 'USER3' },
];

export const DEVICE_CONFIGS = [
  // ── FiiO ────────────────────────────────────────────────────
  {
    vendorIds: [0x2972, 0x0A12],
    manufacturer: 'FiiO',
    protocol: 'fiio',
    defaultModelConfig: {
      minGain: -12, maxGain: 12, maxFilters: 10, reportId: 7,
      disconnectOnSave: false, disabledPresetId: -1,
      supportsLSHSFilters: true, supportsPregain: true,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, type: 'PK' }],
      availableSlots: COMMON_FIIO_SLOTS,
    },
    devices: {
      'FIIO QX13':            { modelConfig: { maxFilters: 10, disconnectOnSave: false } },
      'FIIO KA17':            { modelConfig: { reportId: 1, disabledPresetId: 11, availableSlots: FIIO_USER_ONLY_SLOTS } },
      'FIIO KA17 (MQA HID)':  { modelConfig: { reportId: 1, disabledPresetId: 11, availableSlots: FIIO_USER_ONLY_SLOTS } },
      'FIIO Q7':              { modelConfig: { reportId: 1, disabledPresetId: 11, availableSlots: FIIO_USER_ONLY_SLOTS } },
      'FIIO BT11 (UAC1.0)':   { modelConfig: { reportId: 1, disabledPresetId: 11, availableSlots: FIIO_USER_ONLY_SLOTS } },
      'FIIO Air Link':        { modelConfig: { reportId: 1, disabledPresetId: 11, availableSlots: FIIO_USER_ONLY_SLOTS } },
      'FIIO BTR13':           { modelConfig: { disabledPresetId: 12, availableSlots: FIIO_USER_ONLY_SLOTS } },
      'BTR17':                { modelConfig: { reportId: 7, disabledPresetId: 11 } },
      'FIIO KA15':            { modelConfig: { availableSlots: FIIO_USER_ONLY_SLOTS } },
      'JadeAudio JA11':       { modelConfig: { maxFilters: 5, reportId: 2, disconnectOnSave: true, disabledPresetId: 4,
                                  availableSlots: [ {id:0,name:'Vocal'},{id:1,name:'Classic'},{id:2,name:'Bass'},{id:3,name:'USER1'} ]}},
      'JadeAudio JIEZI':      { modelConfig: { maxFilters: 5, reportId: 2, disconnectOnSave: true, disabledPresetId: 4 } },
      'SNOWSKY Melody':       { modelConfig: { maxFilters: 5, disconnectOnSave: true } },
      'LS-TC2':               { modelConfig: { maxFilters: 5, disconnectOnSave: true, disabledPresetId: 11,
                                  availableSlots: [ {id:0,name:'Vocal'},{id:1,name:'Classic'},{id:2,name:'Bass'},
                                                    {id:3,name:'Dance'},{id:4,name:'R&B'},{id:160,name:'USER1'} ]}},
    },
  },
  // ── WalkPlay (FX17 also uses this vendor but speaks FiiO protocol) ─────────
  {
    vendorIds: [0x3302, 0x0762, 0x35D8, 0x2FC6, 0x0104, 0xB445, 0x0661, 0x0666, 0x0D8C],
    manufacturer: 'WalkPlay',
    protocol: 'walkplay',
    defaultModelConfig: {
      minGain: -12, maxGain: 6, maxFilters: 8, schemeNo: 10,
      disconnectOnSave: false, disabledPresetId: -1,
      supportsLSHSFilters: true, supportsPregain: true,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, type: 'PK' }],
      availableSlots: [{ id: 101, name: 'Custom' }],
    },
    devices: {
      'FIIO FX17 ': { manufacturer: 'FiiO', protocol: 'fiio',
        modelConfig: { maxFilters: 10, reportId: 7, disabledPresetId: 11,
          defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, type: 'PK' }],
          supportsLSHSFilters: true, supportsPregain: true, maxGain: 12,
          availableSlots: COMMON_FIIO_SLOTS } },
      'Rays':         { manufacturer: 'Moondrop', protocol: 'moondrop' },
      'Marigold':     { manufacturer: 'Moondrop', protocol: 'moondrop' },
      'FreeDSP Pro':  { manufacturer: 'Moondrop', protocol: 'moondrop' },
      'ddHiFi DSP IEM - Memory': { manufacturer: 'Moondrop', protocol: 'moondrop' },
      'Quark2':       { manufacturer: 'Moondrop' },
      'ECHO-A':       { manufacturer: 'Moondrop' },
      'Truthear KeyX':{ manufacturer: 'Truthear', modelConfig: { defaultIndex: 0x17 } },
      'EPZ TP13 AI ENC audio': { manufacturer: 'EPZ' },
    },
  },
  // ── KT Micro ───────────────────────────────────────────────
  {
    vendorIds: [0x31B2],
    manufacturer: 'KT Micro',
    protocol: 'ktmicro',
    defaultModelConfig: {
      minGain: -12, maxGain: 12, maxFilters: 5,
      compensate2X: true, disconnectOnSave: true,
      disabledPresetId: 0x02,
      supportsPregain: false, supportsLSHSFilters: true,
      defaultResetFiltersValues: [{ gain: 0, freq: 100, q: 1, type: 'PK' }],
      availableSlots: [{ id: 0x03, name: 'Custom' }],
    },
    devices: {
      'Kiwi Ears-Allegro PRO':  { manufacturer: 'Kiwi Ears',
        modelConfig: { supportsLSHSFilters: false, disconnectOnSave: true } },
      'KT02H20 HIFI Audio':     { manufacturer: 'JCally',
        modelConfig: { supportsLSHSFilters: false } },
      'TANCHJIM BUNNY DSP':     { manufacturer: 'TANCHJIM',
        modelConfig: { compensate2X: false, supportsPregain: true } },
      'TANCHJIM FISSION':       { manufacturer: 'TANCHJIM',
        modelConfig: { compensate2X: false, supportsPregain: true } },
      'CDSP':                   { manufacturer: 'Moondrop',
        modelConfig: { compensate2X: false } },
      'Chu2 DSP':               { manufacturer: 'Moondrop',
        modelConfig: { compensate2X: false } },
    },
  },
];

const PROTOCOLS = {
  fiio:     FIIO,
  walkplay: WALKPLAY,
  moondrop: MOONDROP,
  ktmicro:  KTMICRO,
};

function findSupportedConfig(device) {
  return DEVICE_CONFIGS.find(cfg => cfg.vendorIds.includes(device.vendorId));
}

function describeHidDevice(device) {
  const vendor = Number.isFinite(device?.vendorId) ? `0x${device.vendorId.toString(16)}` : 'unknown';
  const product = Number.isFinite(device?.productId) ? `0x${device.productId.toString(16)}` : 'unknown';
  return `${device?.productName || 'Unnamed HID device'} (vendor ${vendor}, product ${product})`;
}

// ═════════════════════════════════════════════════════════════════════════════
// HIDDeviceManager
// ═════════════════════════════════════════════════════════════════════════════

export class HIDDeviceManager {
  constructor() { this._device = null; }

  isConnected() { return this._device !== null; }
  getDevice()   { return this._device; }
  getAvailableSlots() {
    if (!this._device) return [];
    return this._device.modelConfig.availableSlots || [];
  }

  async connect() {
    if (!navigator.hid) throw new Error('WebHID is not supported in this environment.');

    const filters = DEVICE_CONFIGS.flatMap(cfg =>
      cfg.vendorIds.map(vendorId => ({ vendorId }))
    );

    const granted = await navigator.hid.getDevices();
    const alreadyAllowed = granted.find(device => findSupportedConfig(device));
    const selected = alreadyAllowed ? [alreadyAllowed] : await navigator.hid.requestDevice({ filters });
    if (!selected || selected.length === 0) return null;

    const raw = selected[0];

    const vendorCfg = findSupportedConfig(raw);
    if (!vendorCfg) {
      throw new Error(`Unsupported HID PEQ device: ${describeHidDevice(raw)}`);
    }

    const deviceOverride = (vendorCfg.devices || {})[raw.productName] || {};
    const modelConfig = Object.assign({},
      vendorCfg.defaultModelConfig || {},
      deviceOverride.modelConfig || {},
    );
    const manufacturer = deviceOverride.manufacturer || vendorCfg.manufacturer;
    const protocol     = deviceOverride.protocol     || vendorCfg.protocol || 'fiio';

    if (!raw.opened) await raw.open();

    this._device = {
      rawDevice:    raw,
      manufacturer,
      model:        raw.productName,
      vendorId:     raw.vendorId,
      modelConfig,
      protocol,
    };
    return this._device;
  }

  async disconnect() {
    if (!this._device) return;
    try {
      if (this._device.rawDevice.opened) await this._device.rawDevice.close();
    } catch (e) {
      console.warn('HID close error:', e);
    }
    this._device = null;
  }

  async push(filters, preamp, slot) {
    if (!this._device) throw new Error('No device connected.');
    await this._ensureOpen();
    const handler = PROTOCOLS[this._device.protocol];
    if (!handler) throw new Error(`Unsupported protocol: ${this._device.protocol}`);

    const devFilters = filters.map(toDeviceFilter);
    const disconnectAfter = await handler.push(this._device, slot, preamp || 0, devFilters);

    if (disconnectAfter) {
      await this.disconnect();
      return true;
    }
    return false;
  }

  async pull() {
    if (!this._device) throw new Error('No device connected.');
    await this._ensureOpen();
    const handler = PROTOCOLS[this._device.protocol];
    if (!handler) throw new Error(`Unsupported protocol: ${this._device.protocol}`);

    const { filters, preamp } = await handler.pull(this._device);
    const appFilters = filters.map((f, i) => toAppFilter(f, i));

    // Backward compat: main.js expects { filters, globalGain } and computes
    //   preamp = globalGain - maxGain
    // So pre-shift preamp by +maxGain so the formula yields the right value.
    const maxGain = this._device.modelConfig.maxGain || 12;
    return { filters: appFilters, globalGain: preamp + maxGain };
  }

  async getCurrentSlot() {
    if (!this._device) return null;
    await this._ensureOpen();
    const handler = PROTOCOLS[this._device.protocol];
    if (!handler) return null;
    try { return await handler.getCurrentSlot(this._device); } catch (_) { return null; }
  }

  async _ensureOpen() {
    if (!this._device) return;
    const raw = this._device.rawDevice;
    if (!raw.opened) {
      const known = await navigator.hid.getDevices();
      const match = known.find(d => d.vendorId === raw.vendorId && d.productId === raw.productId);
      if (match) {
        if (!match.opened) await match.open();
        this._device.rawDevice = match;
      } else {
        this._device = null;
        throw new Error('Device disconnected.');
      }
    }
  }
}

export const hidManager = new HIDDeviceManager();
