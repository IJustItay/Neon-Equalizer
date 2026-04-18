/**
 * Squiglink Multi-Source Database — v5 (modernGraphTool-style)
 *
 * Replaces the hardcoded 8-source list with the authoritative master
 * registry served by squig.link itself:
 *
 *   https://squig.link/squigsites.json
 *
 * That file lists every known squiglink-compatible reviewer (currently
 * 116 sites / 138 databases) grouped by rig type (5128 / IEMs /
 * Headphones / Earbuds). For each DB we fetch its `data/phone_book.json`
 * and merge all entries into one searchable unified database.
 *
 * URL construction rules (mirrors squigsites.js):
 *   - urlType "root"      → https://squig.link
 *   - urlType "altDomain" → site.altDomain (e.g. hangout.audio)
 *   - urlType "subdomain" → https://{username}.squig.link
 *   - urlType "labFolder" → https://squig.link/lab/{username}
 * Then append `folder` (usually "/" or "/5128/") + "data/...".
 *
 * Measurement-path fixups (from modernGraphTool's squiglink-integration):
 *   - silicagel / doltonius  → /data/  becomes  /data/phones/
 *   - labFolder hana         → /data/  becomes  /data/measurements/
 *
 * Supplemental metadata (scores, signatures, shop links) still merged
 * from MRSallee/squiglist as before.
 */

// ─── Registry URLs ────────────────────────────────────────────────────────────

const SQUIGSITES_URL = 'https://squig.link/squigsites.json';
const SQUIGLIST_URL =
  'https://raw.githubusercontent.com/MRSallee/squiglist/main/data.json';

const ICON_BY_TYPE = {
  '5128':       '⭐',
  'IEMs':       '🎧',
  'Headphones': '🎵',
  'Earbuds':    '🎶',
};

// ─── Mutable exported source list (populated after loadSquigSites) ────────────

/**
 * Flat list of { id, username, name, type, baseUrl, folder,
 * dataPath, phoneBookPath, deltaReady, color, icon }.
 * Exposed as a *reference* so callers iterating after loadSquigSites()
 * completes see the full list.
 */
export const SQUIG_SOURCES = [];

// ─── Cache ────────────────────────────────────────────────────────────────────

let _sitesLoaded = false;
let _sitesPromise = null;
let _unifiedDB = null;
let _unifiedPromise = null;
let _sourceStatus = {};          // { sourceId: 'loaded' | 'error' | 'loading' }
let _squiglistCache = null;
const _runtimeConfigCache = new Map();

// ─── Fetch helper with timeout ────────────────────────────────────────────────

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function sourceFolderSlug(folder) {
  return String(folder || '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^\w-]+/g, '_');
}

/** Config files are not always inside the DB folder; Listener 5128 uses /assets/js/config_5128.js. */
export function getReviewerConfigUrls(source) {
  if (!source?.baseUrl) return [];
  const folder = source.folder || '/';
  const base = `${source.baseUrl}${folder}`.replace(/\/+$/, '/');
  const root = source.baseUrl.replace(/\/+$/, '');
  const slug = sourceFolderSlug(folder);
  const folderConfig = slug ? `config_${slug}.js` : 'config.js';

  return unique([
    `${base}config.js`,
    `${base}assets/js/config.js`,
    `${root}/assets/js/${folderConfig}`,
    `${root}/assets/js/config.js`,
    `${root}/config.js`,
  ]);
}

async function fetchTextForRuntimeConfig(url) {
  try {
    const r = await fetchWithTimeout(url, { cache: 'no-store' }, 6000);
    if (r.ok) return await r.text();
  } catch { /* desktop fallback below */ }

  try {
    if (typeof window === 'undefined' || !window.apoAPI?.fetchText) return '';
    const fallback = await window.apoAPI.fetchText(url, { timeout: 9000 });
    return fallback?.ok ? (fallback.text || '') : '';
  } catch {
    return '';
  }
}

function parseRuntimeConfigText(text) {
  const dir = /\bDIR\s*[:=]\s*(['"`])([^'"`]*)\1/.exec(text)?.[2] || '';
  const sampleCount = Number(/\bnum_samples\s*[:=]\s*(\d+)/.exec(text)?.[1] || 0);
  const channelsRaw = /\bdefault_channels\s*[:=]\s*\[([^\]]*)\]/.exec(text)?.[1] || '';
  const channels = (channelsRaw.match(/(['"`])([^'"`]*)\1/g) || [])
    .map(v => v.slice(1, -1))
    .filter(v => v !== '');
  return {
    dir,
    sampleNumbers: sampleCount > 0 ? Array.from({ length: sampleCount }, (_, i) => String(i + 1)) : [''],
    channels: channels.length ? channels : ['L', 'R'],
  };
}

async function fetchRuntimeConfig(phone) {
  const source = {
    id: phone?.sourceId,
    baseUrl: phone?.sourceBase,
    folder: phone?.folder || '/',
  };
  const cacheKey = `${source.id || source.baseUrl || ''}:${source.folder}`;
  if (_runtimeConfigCache.has(cacheKey)) return _runtimeConfigCache.get(cacheKey);

  const task = (async () => {
    for (const url of getReviewerConfigUrls(source)) {
      const text = await fetchTextForRuntimeConfig(url);
      if (!text || text.length > 512 * 1024) continue;
      const parsed = parseRuntimeConfigText(text);
      if (parsed.dir || parsed.sampleNumbers.length > 1 || parsed.channels.length) return parsed;
    }
    const sampleCount = Number(phone?.samples || 0);
    return {
      dir: '',
      sampleNumbers: sampleCount > 1 ? Array.from({ length: sampleCount }, (_, i) => String(i + 1)) : [''],
      channels: ['L', 'R'],
    };
  })();

  _runtimeConfigCache.set(cacheKey, task);
  return task;
}

// ─── Master Registry Loading ──────────────────────────────────────────────────

/**
 * Build a source descriptor from a squigsites.json entry + one of its dbs.
 */
function buildSource(site, db) {
  let baseUrl;
  switch (site.urlType) {
    case 'root':      baseUrl = 'https://squig.link'; break;
    case 'altDomain': baseUrl = (site.altDomain || '').replace(/\/$/, ''); break;
    case 'subdomain': baseUrl = `https://${site.username}.squig.link`; break;
    case 'labFolder':
    default:          baseUrl = `https://squig.link/lab/${site.username}`; break;
  }

  const folder = db.folder || '/';                                // "/" or "/5128/"
  const phoneBookPath = `${folder}data/phone_book.json`;          // always plain
  let dataPath = `${folder}data`;                                 // measurement dir

  // modernGraphTool path fixups for known non-standard layouts
  const probe = `${baseUrl}${folder}`;
  if (probe.includes('silicagel') || probe.includes('doltonius')) {
    dataPath = `${folder}data/phones`;
  } else if (probe.includes('/lab/hana/')) {
    dataPath = `${folder}data/measurements`;
  }

  const typeTag = folder === '/' ? '' : `-${folder.replace(/\//g, '')}`;
  const id = `${site.username}${typeTag}-${db.type}`.toLowerCase();

  return {
    id,
    username: site.username,
    name: folder === '/' ? site.name : `${site.name} (${db.type})`,
    type: db.type,
    deltaReady: db.deltaReady === true || db.deltaReady === 'true',
    baseUrl,
    folder,
    dataPath,                                                     // e.g. /data or /5128/data
    phoneBookPath,                                                // e.g. /data/phone_book.json
    color: colorForName(site.username + db.type),
    icon: ICON_BY_TYPE[db.type] || '🎧',
  };
}

/**
 * Fetch squigsites.json and build the SQUIG_SOURCES list. Idempotent.
 * Falls back to a small hardcoded set if the master list is unreachable.
 */
export async function loadSquigSites() {
  if (_sitesLoaded) return SQUIG_SOURCES;
  if (_sitesPromise) return _sitesPromise;

  _sitesPromise = (async () => {
    try {
      const r = await fetchWithTimeout(`${SQUIGSITES_URL}?cb=${Date.now()}`, {}, 10000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const sites = await r.json();

      SQUIG_SOURCES.length = 0;
      for (const site of sites) {
        for (const db of (site.dbs || [])) {
          SQUIG_SOURCES.push(buildSource(site, db));
        }
      }
      _sitesLoaded = true;
      return SQUIG_SOURCES;
    } catch (err) {
      console.warn('Failed to load squigsites.json, using fallback list:', err.message);
      SQUIG_SOURCES.length = 0;
      SQUIG_SOURCES.push(...buildFallbackSources());
      _sitesLoaded = true;
      return SQUIG_SOURCES;
    }
  })();

  return _sitesPromise;
}

/** Minimal fallback list if squigsites.json is unreachable. */
function buildFallbackSources() {
  const fb = [
    { username: 'superreview',   name: 'Super* Review', urlType: 'root',      dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'hbb',           name: 'HBB',           urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'pw',            name: 'Paul Wasabii',  urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'listener',      name: 'Listener',      urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }, { type: '5128', folder: '/5128/' }] },
    { username: 'silicagel',     name: 'SilicaGel',     urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'tonedeafmonk',  name: 'ToneDeafMonk',  urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'precog',        name: 'Precogvision',  urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'vsg',           name: 'VSG',           urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
  ];
  const out = [];
  for (const s of fb) for (const db of s.dbs) out.push(buildSource(s, db));
  return out;
}

/** Stable pastel-ish color derived from the source id — so many sites stay visually distinct. */
function colorForName(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 62%, 55%)`;
}

// ─── Phone Book Loading (per source) ──────────────────────────────────────────

async function loadPhoneBook(source) {
  _sourceStatus[source.id] = 'loading';
  const url = `${source.baseUrl}${source.phoneBookPath}`;
  try {
    const r = await fetchWithTimeout(url, {}, 8000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    const phones = parsePhoneBook(raw, source);
    _sourceStatus[source.id] = phones.length > 0 ? 'loaded' : 'empty';
    return phones;
  } catch (err) {
    _sourceStatus[source.id] = 'error';
    return [];
  }
}

/** Parse a phone_book.json array into a flat list of phone entries. */
function parsePhoneBook(raw, source) {
  const phones = [];
  const brands = Array.isArray(raw) ? raw : (raw.brands || raw.brandPhones || []);

  for (const brand of brands) {
    const brandName = [brand.name, brand.suffix].filter(Boolean).join(' ');

    for (const phoneEntry of (brand.phones || [])) {
      // Short form: plain string
      if (typeof phoneEntry === 'string') {
        phones.push(makePhone(source, brandName, {
          name: phoneEntry, file: phoneEntry,
        }));
        continue;
      }

      const phone = phoneEntry;
      const names    = Array.isArray(phone.name)   ? phone.name   : [phone.name || ''];
      const files    = Array.isArray(phone.file)   ? phone.file
                        : (phone.file ? [phone.file] : names);
      const suffixes = Array.isArray(phone.suffix) ? phone.suffix
                        : (phone.suffix ? [phone.suffix] : []);

      phones.push(makePhone(source, brandName, {
        name:        names[0] || '',
        files:       files.filter(Boolean),
        suffixes,
        prefix:      phone.prefix || '',
        reviewLink:  phone.reviewLink || null,
        shopLink:    phone.shopLink || null,
        reviewScore: phone.reviewScore ? parseInt(phone.reviewScore, 10) : 0,
        price:       phone.price || '',
        description: phone.description || '',
        samples:     phone.samples || 0,
      }));
    }
  }
  return phones;
}

function makePhone(source, brandName, data) {
  const baseName = data.name || '';
  const displayName = buildDisplayName(brandName, baseName);
  return {
    brand:       brandName,
    name:        displayName,
    files:       data.files || [data.file].filter(Boolean),
    suffixes:    data.suffixes || [],
    prefix:      data.prefix || '',
    reviewLink:  data.reviewLink || null,
    shopLink:    data.shopLink || null,
    reviewScore: data.reviewScore || 0,
    price:       data.price || '',
    signature:   '',
    description: data.description || '',
    samples:     data.samples || 0,
    // Source metadata
    sourceId:    source.id,
    sourceName:  source.name,
    sourceType:  source.type,
    sourceColor: source.color,
    sourceIcon:  source.icon,
    sourceBase:  source.baseUrl,
    dataPath:    source.dataPath,
    folder:      source.folder,
    deltaReady:  source.deltaReady,
  };
}

function buildDisplayName(brand, phoneName) {
  if (!brand || !phoneName) return phoneName || brand || 'Unknown';
  if (phoneName.toLowerCase().startsWith(brand.toLowerCase())) return phoneName;
  return `${brand} ${phoneName}`;
}

// ─── MRSallee squiglist enrichment (signatures, scores, shop links) ───────────

async function loadSquiglist() {
  if (_squiglistCache) return _squiglistCache;
  try {
    const r = await fetchWithTimeout(SQUIGLIST_URL, {}, 10000);
    if (!r.ok) return {};
    const raw = await r.json();
    const map = {};
    for (const item of (raw.rows || raw || [])) {
      const phoneName = item.phonename || item.name;
      if (!phoneName) continue;
      map[phoneName.toLowerCase()] = {
        signature: item.signature || '',
        price:     item.price || '',
        score:     typeof item.score === 'number' ? item.score : 0,
        pricezone: item.pricezone || 0,
        squiglink: item.squiglink || '',
        review:    item.review || null,
        shopLinks: {
          amazon:     item.amazon || null,
          aliexpress: item.aliexpress || null,
          drop:       item.drop || null,
          hifigo:     item.hifigo || null,
          linsoul:    item.linsoul || null,
        },
      };
    }
    _squiglistCache = map;
    return map;
  } catch (err) {
    console.warn('Failed to load MRSallee squiglist:', err.message);
    return {};
  }
}

// ─── Concurrency-limited parallel fetcher ─────────────────────────────────────

async function mapWithConcurrency(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (_) { results[i] = null; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ─── Unified DB Load ──────────────────────────────────────────────────────────

/**
 * Load all (or selected) squiglink sources into one unified DB.
 * Results are cached — subsequent calls return the same data.
 *
 * @param {string[]|null} selectedSourceIds
 * @param {(done, total) => void} [onProgress]
 * @returns {Promise<{phones, sourceStatus, totalSources, loadedSources, sources}>}
 */
export async function loadAllSources(selectedSourceIds = null, onProgress = null) {
  // Return cached result if we already loaded everything
  if (_unifiedDB && !selectedSourceIds) {
    return {
      phones: _unifiedDB,
      sourceStatus: { ..._sourceStatus },
      totalSources: SQUIG_SOURCES.length,
      loadedSources: Object.values(_sourceStatus).filter(s => s === 'loaded').length,
      sources: SQUIG_SOURCES.slice(),
    };
  }
  if (_unifiedPromise && !selectedSourceIds) return _unifiedPromise;

  const loader = (async () => {
    await loadSquigSites();

    const sources = selectedSourceIds
      ? SQUIG_SOURCES.filter(s => selectedSourceIds.includes(s.id))
      : SQUIG_SOURCES;

    const [phoneLists, squiglist] = await Promise.all([
      mapWithConcurrency(sources, 12, loadPhoneBook, onProgress),
      loadSquiglist(),
    ]);

    const allPhones = phoneLists.flat().filter(Boolean);

    // Enrich with squiglist metadata (signatures, scores, shop links)
    for (const phone of allPhones) {
      const key = phone.name.toLowerCase();
      const meta = squiglist[key] || findFuzzyMatch(squiglist, phone.name, phone.brand);
      if (meta) {
        if (!phone.price && meta.price) phone.price = meta.price;
        if (meta.signature) phone.signature = meta.signature;
        if (meta.score > phone.reviewScore) phone.reviewScore = meta.score;
        if (meta.shopLinks) phone.shopLinks = meta.shopLinks;
      }
    }

    // Dedupe within same source only (keeping cross-source duplicates
    // so the user can compare the same IEM across reviewers).
    const seen = new Set();
    const deduped = [];
    for (const phone of allPhones) {
      const key = `${phone.sourceId}:${phone.name.toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(phone); }
    }

    if (!selectedSourceIds) _unifiedDB = deduped;

    return {
      phones: deduped,
      sourceStatus: { ..._sourceStatus },
      totalSources: sources.length,
      loadedSources: sources.filter(s => _sourceStatus[s.id] === 'loaded').length,
      sources: sources.slice(),
    };
  })();

  if (!selectedSourceIds) _unifiedPromise = loader;
  return loader;
}

function findFuzzyMatch(squiglist, phoneName, brand) {
  if (brand && phoneName.toLowerCase().startsWith(brand.toLowerCase())) {
    const stripped = phoneName.slice(brand.length).trim().toLowerCase();
    if (squiglist[stripped]) return squiglist[stripped];
  }
  const key = phoneName.toLowerCase();
  for (const [k, v] of Object.entries(squiglist)) {
    if (k.includes(key) || key.includes(k)) return v;
  }
  return null;
}

export async function getDB() {
  if (_unifiedDB) return _unifiedDB;
  const result = await loadAllSources();
  return result.phones;
}

export function getSourceStatus() {
  return { ..._sourceStatus };
}

/** Exposed so UI code (e.g. FR Tracer URL paste) can wait for the list. */
export async function getSources() {
  await loadSquigSites();
  return SQUIG_SOURCES;
}

// ─── Measurement Fetch ────────────────────────────────────────────────────────

async function tryFetchTxt(url) {
  try {
    const r = await fetchWithTimeout(url, {}, 6000);
    let text = null;
    if (r.ok) {
      text = await r.text();
    } else if (typeof window !== 'undefined' && window.apoAPI?.fetchText) {
      const fallback = await window.apoAPI.fetchText(url, { timeout: 9000 });
      if (fallback?.ok) text = fallback.text;
    }
    if (!text && typeof window !== 'undefined' && window.apoAPI?.fetchText) {
      const fallback = await window.apoAPI.fetchText(url, { timeout: 9000 });
      if (fallback?.ok) text = fallback.text;
    }
    if (!text) return null;
    const parsed = parseMeasurementText(text);
    return parsed && parsed.freq.length > 5 ? parsed : null;
  } catch {
    try {
      const fallback = await (typeof window !== 'undefined'
        ? window.apoAPI?.fetchText?.(url, { timeout: 9000 })
        : null);
      if (!fallback?.ok || !fallback.text) return null;
      const parsed = parseMeasurementText(fallback.text);
      return parsed && parsed.freq.length > 5 ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * Fetch raw FR for a phone entry.
 * Strategy: L+R pair → single file → first suffix variant → prefixed.
 */
function buildMeasurementStems(phone, fileIndex = 0) {
  const files = phone.files || [];
  const orderedFiles = unique([
    files[fileIndex],
    files[0],
    ...files,
  ]);
  const stems = [];

  orderedFiles.forEach((file, idx) => {
    const prefix = phone.prefix || '';
    const suffixes = unique([
      '',
      phone.suffixes?.[idx],
      phone.suffixes?.[fileIndex],
      ...(phone.suffixes || []),
    ]);

    stems.push(file);
    if (prefix) stems.push(`${prefix}${file}`);
    for (const suffix of suffixes) {
      if (!suffix) continue;
      stems.push(`${file} ${suffix}`.trim());
      if (prefix) stems.push(`${prefix}${file} ${suffix}`.trim());
    }
  });

  return unique(stems);
}

function buildMeasurementBaseUrls(phone, runtimeConfig) {
  const sourceBase = (phone.sourceBase || '').replace(/\/+$/, '');
  const folderBase = `${sourceBase}${phone.folder || '/'}`.replace(/\/+$/, '/');
  const bases = [
    `${sourceBase}${phone.dataPath || ''}`.replace(/\/+$/, ''),
  ];

  if (runtimeConfig?.dir) {
    try {
      bases.push(new URL(runtimeConfig.dir, folderBase).href.replace(/\/+$/, ''));
    } catch { /* ignore malformed reviewer DIR */ }
  }

  bases.push(
    `${folderBase}data`.replace(/\/+$/, ''),
    `${folderBase}data/phones`.replace(/\/+$/, ''),
    `${folderBase}data/measurements`.replace(/\/+$/, '')
  );

  return unique(bases);
}

async function fetchChannelPair(base, stem, channels, sampleNumber) {
  if (!channels?.length || (channels.length === 1 && channels[0] === '')) {
    return tryFetchTxt(`${base}/${encodeURIComponent(stem)}.txt`);
  }

  const sampleSuffix = sampleNumber || '';
  const channelUrls = channels.map(ch => `${base}/${encodeURIComponent(`${stem} ${ch}${sampleSuffix}`)}.txt`);
  const channelData = await Promise.all(channelUrls.map(tryFetchTxt));
  const valid = channelData.filter(Boolean);
  if (valid.length >= 2) return averageMany(valid);
  return valid[0] || null;
}

export async function fetchMeasurement(phone, fileIndex = 0) {
  const stems = buildMeasurementStems(phone, fileIndex);
  if (!stems.length) return null;

  const runtimeConfig = await fetchRuntimeConfig(phone);
  const bases = buildMeasurementBaseUrls(phone, runtimeConfig);
  const channels = unique([...(runtimeConfig.channels || []), 'L', 'R']).filter(ch => ch !== '');
  const sampleNumbers = [...new Set([...(runtimeConfig.sampleNumbers || ['']), ''])];

  for (const base of bases) {
    for (const stem of stems) {
      for (const sampleNumber of sampleNumbers) {
        const paired = await fetchChannelPair(base, stem, channels, sampleNumber);
        if (paired) return paired;
      }

      const direct = await tryFetchTxt(`${base}/${encodeURIComponent(stem)}.txt`);
      if (direct) return direct;

      const underscoreData = await Promise.all([
        tryFetchTxt(`${base}/${encodeURIComponent(`${stem}_L`)}.txt`),
        tryFetchTxt(`${base}/${encodeURIComponent(`${stem}_R`)}.txt`),
      ]);
      const validUnderscore = underscoreData.filter(Boolean);
      if (validUnderscore.length >= 2) return averageMany(validUnderscore);
      if (validUnderscore[0]) return validUnderscore[0];
    }
  }

  return null;
}

/**
 * Legacy: fetch from main squig.link with a share key. Kept for URL-paste flow.
 */
export async function fetchSquigMeasurement(shareKey) {
  const name = shareKey.replace(/_/g, ' ');
  const base = 'https://squig.link/data';

  const [l, r] = await Promise.all([
    tryFetchTxt(`${base}/${encodeURIComponent(name + ' L')}.txt`),
    tryFetchTxt(`${base}/${encodeURIComponent(name + ' R')}.txt`),
  ]);
  if (l && r) return averageLR(l, r);
  if (l) return l;
  if (r) return r;

  const direct = await tryFetchTxt(`${base}/${encodeURIComponent(name)}.txt`);
  if (direct) return direct;

  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped !== name) {
    const [ls, rs] = await Promise.all([
      tryFetchTxt(`${base}/${encodeURIComponent(stripped + ' L')}.txt`),
      tryFetchTxt(`${base}/${encodeURIComponent(stripped + ' R')}.txt`),
    ]);
    if (ls && rs) return averageLR(ls, rs);
    if (ls) return ls;
    if (rs) return rs;
  }
  return null;
}

// ─── Embed URLs ───────────────────────────────────────────────────────────────

/** Build an embed URL for a phone entry, respecting its source site + folder. */
export function getEmbedUrl(phone, fileIndex = 0) {
  const file = phone.files?.[fileIndex] || phone.files?.[0] || phone.name;
  const shareKey = file.replace(/ /g, '_');
  const folder = phone.folder || '/';
  return `${phone.sourceBase}${folder}?embed&share=${encodeURIComponent(shareKey)}`;
}

/** Legacy helper for bare share keys (main squig.link). */
export function getSquigEmbedUrl(shareKey, showTarget = true) {
  const base = `https://squig.link/?embed&share=${encodeURIComponent(shareKey)}`;
  return showTarget ? `${base},Super_Review_Target` : base;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Filter + rank. Supports multi-word AND matching and optional source / type /
 * signature filters. Returns at most `limit` results (default 200).
 */
export function searchDB(db, query, filters = {}) {
  let results = db;

  if (filters.sourceId)   results = results.filter(p => p.sourceId   === filters.sourceId);
  if (filters.sourceType) results = results.filter(p => p.sourceType === filters.sourceType);
  if (filters.signature)  results = results.filter(p => p.signature  === filters.signature);
  if (filters.deltaOnly)  results = results.filter(p => p.deltaReady);

  if (query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    results = results.filter(p => {
      const hay = `${p.name} ${p.brand} ${p.sourceName}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }

  results = results.slice().sort((a, b) => {
    if (a.reviewScore !== b.reviewScore) return b.reviewScore - a.reviewScore;
    return a.name.localeCompare(b.name);
  });

  const limit = filters.limit || 200;
  return results.slice(0, limit);
}

// ─── Text Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse REW/squig.link style freq/SPL text. Handles tab, comma, and space
 * separators; skips comments (*, #, leading letter).
 */
export function parseMeasurementText(text) {
  const freq = [];
  const spl  = [];

  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line[0] === '*' || line[0] === '#') continue;
    if (/^[a-zA-Z]/.test(line)) continue;

    const parts = line.split(/[\s\t,]+/);
    if (parts.length >= 2) {
      const f = parseFloat(parts[0]);
      const s = parseFloat(parts[1]);
      if (!isNaN(f) && !isNaN(s) && f >= 10 && f <= 25000) {
        freq.push(f);
        spl.push(s);
      }
    }
  }
  return freq.length > 5 ? { freq, spl } : null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function averageLR(lData, rData) {
  return averageMany([lData, rData]);
}

function averageMany(curves) {
  const valid = (curves || []).filter(Boolean);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  const len = Math.min(...valid.map(curve => curve.freq.length));
  return {
    freq: valid[0].freq.slice(0, len),
    spl:  valid[0].spl.slice(0, len).map((_, i) =>
      valid.reduce((sum, curve) => sum + curve.spl[i], 0) / valid.length
    ),
  };
}

/** Extract share key from a squig.link-style URL (legacy helper). */
export function extractShareKey(url) {
  if (!url) return null;
  const m = url.match(/[?&]share=([^&,]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── Legacy MRSallee-only DB API ──────────────────────────────────────────────

export async function loadSquiglistDB() {
  const squiglist = await loadSquiglist();
  return Object.entries(squiglist).map(([key, meta]) => ({
    name:      key,
    signature: meta.signature || '',
    price:     meta.price || '',
    score:     meta.score || 0,
    squiglink: meta.squiglink || '',
    shareKey:  extractShareKey(meta.squiglink || ''),
    review:    meta.review || null,
    shopLinks: meta.shopLinks || {},
  })).filter(x => x.name && x.shareKey);
}

// ─── Signature Colors ─────────────────────────────────────────────────────────

export const SIGNATURE_COLORS = {
  'Harman Neutral': '#10b981',
  'Neutral':        '#10b981',
  'Bassy Neutral':  '#34d399',
  'Warm Neutral':   '#59b58a',
  'Bright Neutral': '#60a5fa',
  'Lean Neutral':   '#93c5fd',
  'Mild V':         '#a78bfa',
  'V':              '#ec4899',
  'Bassy V':        '#f59e0b',
  'Warm V':         '#fbbf24',
  'Bright V':       '#ef4444',
  'Lean V':         '#f87171',
  'V-shape':        '#ec4899',
};
