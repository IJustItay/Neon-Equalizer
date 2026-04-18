/**
 * Network connector (WiiM / Linkplay streamers, Luxsin over HTTP)
 *
 * Browsers can't do mDNS, so the user enters an IP or hostname through the
 * UI. The connector probes a few well-known HTTP endpoints to identify the
 * device and picks the matching handler.
 *
 *   WiiM (Linkplay)  → GET /httpapi.asp?command=EQGetBand  etc.
 *   Luxsin           → GET /api/peq (JSON)
 */

let _host = null;      // full URL prefix "http://192.168.1.50"
let _vendor = null;
let _device = null;
let _slots = [{ id: 0, name: 'Main' }];

const VENDORS = {
  wiim: {
    label: 'WiiM',
    probeUrl: (host) => `${host}/httpapi.asp?command=getStatus`,
    match: (body) => /project:\s*(WiiM|Linkplay)/i.test(body) || /WiiM/.test(body),
    async pull() {
      const r = await fetch(`${_host}/httpapi.asp?command=EQGetAll`);
      const text = await r.text();
      // Linkplay returns either JSON or URL-encoded "Band=...&Band=..."
      let json; try { json = JSON.parse(text); } catch { json = parseUrlLike(text); }
      const filters = (json.Bands || json.bands || []).map(b => ({
        type: b.type || 'PK',
        freq: Number(b.Freq || b.freq),
        gain: Number(b.Gain || b.gain),
        q:    Number(b.Q    || b.q),
        disabled: !(b.Enabled ?? b.enabled ?? true),
      }));
      const preamp = Number(json.Preamp || json.preamp || 0);
      return { filters, preamp };
    },
    async push(filters, preamp /*, slot */) {
      const cmd = {
        Preamp: preamp,
        Bands: filters.map(f => ({
          type: f.type, Freq: f.freq, Gain: f.gain, Q: f.q, Enabled: !f.disabled,
        })),
      };
      const body = encodeURIComponent(JSON.stringify(cmd));
      await fetch(`${_host}/httpapi.asp?command=EQSetAll:${body}`);
      return false;
    },
    async getCurrentSlot() { return 0; },
  },

  luxsin: {
    label: 'Luxsin',
    probeUrl: (host) => `${host}/api/info`,
    match: (body) => /luxsin/i.test(body),
    async pull() {
      const r = await fetch(`${_host}/api/peq`);
      const json = await r.json();
      const filters = (json.bands || []).map(b => ({
        type: b.type || 'PK',
        freq: b.freq, gain: b.gain, q: b.q,
        disabled: !b.enabled,
      }));
      return { filters, preamp: json.preamp || 0 };
    },
    async push(filters, preamp /*, slot */) {
      await fetch(`${_host}/api/peq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preamp,
          bands: filters.map(f => ({
            type: f.type, freq: f.freq, gain: f.gain, q: f.q, enabled: !f.disabled,
          })),
        }),
      });
      return false;
    },
    async getCurrentSlot() { return 0; },
  },
};

function parseUrlLike(text) {
  const out = { Bands: [] };
  for (const pair of text.split('&')) {
    const [k, v] = pair.split('=');
    if (/^Band/i.test(k)) out.Bands.push(JSON.parse(decodeURIComponent(v || '{}')));
    else out[k] = decodeURIComponent(v || '');
  }
  return out;
}

function normalizeHost(raw) {
  if (!raw) throw new Error('Missing host. Enter an IP or hostname.');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  return raw.replace(/\/+$/, '');
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function connect(opts = {}) {
  _host = normalizeHost(opts.host);
  _vendor = null;

  // Probe each vendor in parallel; take the first match.
  const probes = await Promise.allSettled(
    Object.entries(VENDORS).map(async ([key, v]) => {
      const r = await fetch(v.probeUrl(_host), { method: 'GET', mode: 'cors' });
      const body = await r.text();
      return v.match(body) ? key : null;
    })
  );
  for (const p of probes) if (p.status === 'fulfilled' && p.value) { _vendor = VENDORS[p.value]; break; }
  if (!_vendor) throw new Error(`No supported streamer found at ${_host}. Tried: ${Object.keys(VENDORS).join(', ')}.`);

  _device = {
    manufacturer: _vendor.label,
    model:        `${_vendor.label} @ ${_host.replace(/^https?:\/\//, '')}`,
    modelConfig: {
      maxFilters: 10,
      maxGain:    12,
      supportsLSHSFilters: true,
      availableSlots: _slots.slice(),
    },
    protocol: 'network',
  };
  return _device;
}

export async function disconnect() {
  _host = null;
  _vendor = null;
  _device = null;
}

export function isConnected() { return _device !== null; }
export function getDevice()   { return _device; }
export function getAvailableSlots() { return _slots; }
export async function getCurrentSlot() { return _vendor ? _vendor.getCurrentSlot() : 0; }

export async function push(filters, preamp, slot) {
  if (!_vendor) throw new Error('No network device connected.');
  return _vendor.push(filters, preamp, slot);
}

export async function pull() {
  if (!_vendor) throw new Error('No network device connected.');
  const { filters, preamp } = await _vendor.pull();
  const appFilters = filters.map((f, i) => ({
    id: `net_${Date.now()}_${i}`,
    enabled: !f.disabled,
    type: f.type || 'PK',
    frequency: f.freq, gain: f.gain, q: f.q,
    color: '#00d4ff', index: i,
  }));
  return { filters: appFilters, globalGain: preamp + 12 };
}
