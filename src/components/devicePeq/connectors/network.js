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

let _host = null;      // bare host, e.g. "192.168.1.50" or "wiim.lan:8080"
let _vendor = null;
let _device = null;
let _slots = [{ id: 0, name: 'Main' }];

/**
 * HTTP transport for LAN devices. In the desktop app this goes through the
 * main-process `lan-device-request` IPC (the renderer CSP blocks plain-HTTP
 * fetches in production — issue #16); the main process only allows the
 * user-entered host and only when it resolves to a LAN address. Plain fetch
 * remains as a dev/browser fallback.
 */
async function deviceRequest(pathPart, { method = 'GET', body = null, contentType = null } = {}) {
  if (typeof window !== 'undefined' && window.apoAPI?.lanDeviceRequest) {
    const r = await window.apoAPI.lanDeviceRequest({
      host: _host, path: pathPart, method, body, contentType, timeout: 8000,
    });
    if (r?.error && !r.status) throw new Error(r.error);
    return { ok: !!r?.ok, status: r?.status || 0, text: r?.text || '' };
  }
  const r = await fetch(`http://${_host}${pathPart}`, {
    method,
    headers: contentType ? { 'Content-Type': contentType } : undefined,
    body: body ?? undefined,
    mode: 'cors',
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

const VENDORS = {
  wiim: {
    label: 'WiiM',
    probePath: '/httpapi.asp?command=getStatus',
    match: (body) => /project:\s*(WiiM|Linkplay)/i.test(body) || /WiiM/.test(body),
    async pull() {
      const r = await deviceRequest('/httpapi.asp?command=EQGetAll');
      const text = r.text;
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
      await deviceRequest(`/httpapi.asp?command=EQSetAll:${body}`);
      return false;
    },
    async getCurrentSlot() { return 0; },
  },

  luxsin: {
    label: 'Luxsin',
    probePath: '/api/info',
    match: (body) => /luxsin/i.test(body),
    async pull() {
      const r = await deviceRequest('/api/peq');
      const json = JSON.parse(r.text);
      const filters = (json.bands || []).map(b => ({
        type: b.type || 'PK',
        freq: b.freq, gain: b.gain, q: b.q,
        disabled: !b.enabled,
      }));
      return { filters, preamp: json.preamp || 0 };
    },
    async push(filters, preamp /*, slot */) {
      await deviceRequest('/api/peq', {
        method: 'POST',
        contentType: 'application/json',
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
  // Accept pasted URLs but store only the bare host[:port].
  const bare = String(raw).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!bare) throw new Error('Missing host. Enter an IP or hostname.');
  return bare;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function connect(opts = {}) {
  _host = normalizeHost(opts.host);
  _vendor = null;

  // Probe each vendor in parallel; take the first match.
  const probes = await Promise.allSettled(
    Object.entries(VENDORS).map(async ([key, v]) => {
      const r = await deviceRequest(v.probePath);
      return v.match(r.text) ? key : null;
    })
  );
  for (const p of probes) if (p.status === 'fulfilled' && p.value) { _vendor = VENDORS[p.value]; break; }
  if (!_vendor) {
    const reasons = probes
      .filter(p => p.status === 'rejected')
      .map(p => p.reason?.message)
      .filter(Boolean);
    const hint = reasons.length ? ` (${reasons[0]})` : '';
    throw new Error(`No supported streamer found at ${_host}${hint}. Tried: ${Object.keys(VENDORS).join(', ')}.`);
  }

  _device = {
    manufacturer: _vendor.label,
    model:        `${_vendor.label} @ ${_host}`,
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
