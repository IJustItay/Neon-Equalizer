/**
 * Target Loader — central access to frequency-response targets.
 *
 *  Four sources:
 *    1. Bundled  — static .txt files under /public/targets/, listed in index.json.
 *    2. Upload   — user-provided .txt / .csv file parsed locally.
 *    3. Reviewer — per-reviewer-site targets declared in that site's
 *                  `config.js` (or `assets/js/config.js`). Isolated per
 *                  reviewer — targets from one reviewer NEVER bleed into
 *                  another's picker.
 *    4. (legacy) autoDiscover — probes a handful of well-known paths. Kept
 *       as a last-resort fallback for very old squig mirrors that don't
 *       ship a config.js.
 *
 *  All paths return the same shape:  { name, freq: [], spl: [] }
 *  which feeds directly into freqGraph.setTargetData() and runAutoEQ().
 */
import { parseMeasurementText, loadSquigSites, getReviewerConfigUrls } from './squiglinkDB.js';

// Lazy cache of bundled index + parsed target files.
let _bundledIndexPromise = null;
const _bundledCache = Object.create(null);

// Per-source cache of parsed reviewer-config {dir, groups} records.
const _reviewerConfigCache = new Map();     // sourceId → Promise<{dir, groups}>
// Per-source cache of already-loaded target payloads keyed by source + path.
const _reviewerTargetCache = new Map();

// Well-known fallback target paths for sites without a parseable config.js.
const SQUIG_TARGET_CANDIDATES = [
  'data/target.txt',
  'data/Target.txt',
  'data/harman.txt',
  'data/Harman.txt',
  'data/diffuse_field.txt',
  'data/diffuse-field.txt',
  'data/Diffuse Field Target.txt',
  'data/IEF Neutral 2023 Target.txt',
  'data/Super 22 Adjusted Target.txt',
  'data/Super Review 22 Target.txt',
];

// ─── Bundled ────────────────────────────────────────────────────────────────

/** Load public/targets/index.json (cached). Returns [{name, file, category}] or []. */
export async function loadBundledIndex() {
  if (!_bundledIndexPromise) {
    _bundledIndexPromise = (async () => {
      try {
        const r = await fetch('./targets/index.json');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return Array.isArray(data.targets) ? data.targets : [];
      } catch (err) {
        console.warn('[targetLoader] bundled index load failed:', err.message);
        return [];
      }
    })();
  }
  return _bundledIndexPromise;
}

/** Fetch + parse a bundled target by its name (as in index.json). */
export async function loadBundledTarget(name) {
  if (_bundledCache[name]) return _bundledCache[name];
  const index = await loadBundledIndex();
  const meta = index.find(t => t.name === name);
  if (!meta) throw new Error(`Bundled target not found: ${name}`);

  const url = `./targets/${encodeURIComponent(meta.file)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${meta.file}`);
  const text = await r.text();
  const parsed = parseMeasurementText(text);
  if (!parsed) throw new Error(`Unreadable target: ${meta.file}`);

  const result = {
    name: meta.name,
    category: meta.category || 'bundled',
    source: 'bundled',
    sourceName: 'Bundled',
    sourceType: meta.rig || '711',
    dataKind: 'target',
    freq: parsed.freq,
    spl: parsed.spl
  };
  _bundledCache[name] = result;
  return result;
}

// ─── Upload ─────────────────────────────────────────────────────────────────

/** Parse an uploaded File/Blob into the same {name, freq, spl} shape. */
export async function loadUploadedTarget(file) {
  if (!file) throw new Error('No file');
  const text = await file.text();
  const parsed = parseMeasurementText(text);
  if (!parsed) throw new Error('Could not parse target file (expected freq<TAB>SPL).');
  const base = (file.name || 'Uploaded').replace(/\.[^.]+$/, '');
  return { name: base, category: 'upload', source: 'upload', sourceName: 'Uploaded', sourceType: 'unknown', dataKind: 'target', freq: parsed.freq, spl: parsed.spl };
}

// ─── Reviewer config.js parsing ─────────────────────────────────────────────
//
// Every squig.link reviewer ships a small config file declaring the targets
// *they* want exposed in their picker — e.g. Avishai includes a "∆" group,
// Hu-Fi bundles their own "Hu-Fi IE2025". We read each reviewer's config on
// demand so their list stays siloed; a target from reviewer A never shows
// up when the user has reviewer B selected.
//
// Two well-known locations (taken straight from the upstream sites):
//   https://{host}/config.js
//   https://{host}/assets/js/config.js
//
// The config is not a real ES module (it uses bare `const`), so we can't
// dynamic-import it. We fetch as text, extract the `DIR = "..."` and
// `targets = [...]` literals, then evaluate the array literal in an
// isolated Function scope.

/** Extract a balanced `[ ... ]` substring starting at `startIdx` (which must point at `[`). */
function extractBalancedArray(text, startIdx) {
  if (text[startIdx] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let i = startIdx;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === strCh) inStr = false;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; }
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
    }
    i++;
  }
  return null;
}

function normalizeDir(dir) {
  const clean = (dir || '').trim().replace(/^\.?\//, '');
  return clean && !clean.endsWith('/') ? `${clean}/` : clean;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function withoutTxt(name) {
  return String(name || '').replace(/\.txt$/i, '');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function fetchTextWithDesktopFallback(url, options = {}) {
  try {
    const response = await fetch(url, options);
    if (response.ok) return { ok: true, status: response.status, text: await response.text() };
    if (typeof window === 'undefined' || !window.apoAPI?.fetchText) return { ok: false, status: response.status, text: '' };
  } catch {
    if (typeof window === 'undefined' || !window.apoAPI?.fetchText) return { ok: false, status: 0, text: '' };
  }

  const fallback = await window.apoAPI.fetchText(url, { timeout: 9000 });
  return {
    ok: !!fallback?.ok,
    status: fallback?.status || 0,
    text: fallback?.text || '',
    error: fallback?.error
  };
}

/** Parse a reviewer's config.js text and return { dir, groups:[{type,files:[{name,file}]}] }. */
function parseConfigText(text) {
  // DIR = "data/"  (also accept ':' in object literals like `DIR: "data/"`)
  let dir = 'data/';
  const dirRe = /\bDIR\s*[:=]\s*(['"`])([^'"`]*)\1/;
  const dm = dirRe.exec(text);
  if (dm) dir = dm[2] || 'data/';
  dir = normalizeDir(dir) || 'data/';

  // Some squig mirrors store target curves outside DIR. Capture any explicit
  // target directory if the config exposes one, otherwise candidate probing
  // below will keep the reviewer isolated while still handling old layouts.
  let targetDir = '';
  const targetDirRe = /\b(?:TARGET_DIR|targetDir|target_dir|PATH_TARGET|TARGET_PATH|target_path)\s*[:=]\s*(['"`])([^'"`]*)\1/;
  const tdm = targetDirRe.exec(text);
  if (tdm) targetDir = normalizeDir(tdm[2]);

  // targets = [...]  or  targets: [...]
  const tRe = /\btargets\s*[:=]\s*\[/g;
  let arr = null;
  let m;
  while ((m = tRe.exec(text))) {
    const bracket = m.index + m[0].length - 1;      // position of `[`
    const slice = extractBalancedArray(text, bracket);
    if (slice) { arr = slice; break; }
  }
  if (!arr) throw new Error('`targets` array not found in config');

  // Evaluate the array literal in a sandboxed Function. Still untrusted input
  // so we strip the most obvious risk vectors (function/new) — in practice
  // the configs are static data, but an abundance of caution costs us nothing.
  const safe = arr
    .replace(/\b(?:function|=>|new\s+[A-Za-z_$])/g, 'null')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  let raw;
  try {
    // eslint-disable-next-line no-new-func
    raw = Function(`"use strict"; return (${safe});`)();
  } catch (err) {
    throw new Error(`targets array unparseable: ${err.message}`);
  }
  if (!Array.isArray(raw)) throw new Error('targets is not an array');

  const groups = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const type = g.type || g.name || 'Targets';
    const rawFiles = Array.isArray(g.files) ? g.files : [];
    const files = [];
    for (const f of rawFiles) {
      if (!f) continue;
      if (typeof f === 'string') {
        files.push({ name: f, file: f });
      } else if (typeof f === 'object') {
        const file = f.file || f.filename || f.name;
        if (!file) continue;
        files.push({ name: f.name || file, file });
      }
    }
    if (files.length) groups.push({ type, files });
  }
  return { dir, targetDir, groups };
}

/**
 * Fetch + parse the reviewer config for one squig source. Returns
 *   { dir, groups: [{ type, files: [{name, file}] }] }
 * or null if the reviewer ships no parseable config.
 * Cached per source for the session.
 */
export async function fetchReviewerConfig(source) {
  if (!source) return null;
  if (_reviewerConfigCache.has(source.id)) return _reviewerConfigCache.get(source.id);

  const candidateUrls = getReviewerConfigUrls(source);

  const task = (async () => {
    for (const url of candidateUrls) {
      try {
        const r = await fetchTextWithDesktopFallback(url, { cache: 'no-store' });
        if (!r.ok) continue;
        const text = r.text;
        if (!text || text.length > 512 * 1024) continue;    // sanity cap: 512 kB
        const parsed = parseConfigText(text);
        if (parsed && parsed.groups.length) return parsed;
      } catch { /* try next */ }
    }
    return null;
  })();

  _reviewerConfigCache.set(source.id, task);
  return task;
}

function buildReviewerTargetCandidates(filename, cfg) {
  const baseName = withoutTxt(filename);
  const fileNames = unique([
    filename,
    `${baseName}.txt`,
    `${baseName} Target.txt`,
  ]);

  const dir = normalizeDir(cfg?.dir) || 'data/';
  const dirs = unique([
    normalizeDir(cfg?.targetDir),
    `${dir}targets/`,
    `${dir}target/`,
    dir,
    'data/targets/',
    'data/target/',
    'targets/',
    'target/',
    '',
  ]);

  const paths = [];
  for (const d of dirs) {
    for (const f of fileNames) {
      paths.push(`${d}${f}`.replace(/^\/+/, ''));
    }
  }
  return unique(paths);
}

/** Load one target file listed in a reviewer's config. */
export async function loadReviewerTarget(source, filename, dirOverride) {
  if (!source || !filename) return null;
  const cacheKey = [
    source.id,
    source.baseUrl,
    source.folder || '/',
    normalizeDir(dirOverride || ''),
    filename,
  ].join('::');
  if (_reviewerTargetCache.has(cacheKey)) return _reviewerTargetCache.get(cacheKey);

  const task = (async () => {
    const cfg = await fetchReviewerConfig(source);
    const base = `${source.baseUrl}${source.folder || '/'}`.replace(/\/+$/, '/');
    const probeCfg = { ...(cfg || {}), dir: dirOverride || cfg?.dir || 'data/' };
    const candidates = buildReviewerTargetCandidates(filename, probeCfg);
    const failures = [];

    for (const path of candidates) {
      const url = `${base}${encodePath(path)}`;
      try {
        const r = await fetchTextWithDesktopFallback(url, { cache: 'no-store' });
        if (!r.ok) {
          failures.push(`${r.status} ${path}`);
          continue;
        }
        const text = r.text;
        const parsed = parseMeasurementText(text);
        if (!parsed) {
          failures.push(`unreadable ${path}`);
          continue;
        }
        return {
          name: `${source.name} · ${withoutTxt(filename)}`,
          shortName: withoutTxt(filename),
          category: 'reviewer',
          source: source.id,
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
          deltaReady: source.deltaReady,
          dataKind: 'target',
          url,
          path,
          points: parsed.freq.length,
          freqRange: [parsed.freq[0], parsed.freq[parsed.freq.length - 1]],
          freq: parsed.freq,
          spl:  parsed.spl,
        };
      } catch (err) {
        failures.push(`${path}: ${err.message}`);
      }
    }

    throw new Error(`Target not found for ${source.name}: ${filename}. Tried ${failures.slice(0, 4).join(', ')}${failures.length > 4 ? ', ...' : ''}`);
  })();
  _reviewerTargetCache.set(cacheKey, task);
  return task;
}

// ─── Legacy auto-discover (fallback only) ───────────────────────────────────

/**
 * Probe a single candidate target filename on a squig source. Used by
 * autoDiscoverSquigTarget for sites that don't ship a parseable config.js.
 */
export async function fetchSquigTarget(source, candidate) {
  if (!source) return null;
  const url = `${source.baseUrl}${source.folder}${candidate}`.replace(/([^:])\/\//g, '$1/');
  try {
    const r = await fetchTextWithDesktopFallback(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const text = r.text;
    const parsed = parseMeasurementText(text);
    if (!parsed) return null;
    const displayName = candidate.replace(/^data\//, '').replace(/\.txt$/i, '');
    return {
      name: `${source.name} · ${displayName}`,
      category: 'reviewer',
      source: source.id,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      deltaReady: source.deltaReady,
      dataKind: 'target',
      freq: parsed.freq,
      spl: parsed.spl
    };
  } catch { return null; }
}

/** Last-resort: try a small set of well-known filenames and return the first that parses. */
export async function autoDiscoverSquigTarget(source) {
  for (const cand of SQUIG_TARGET_CANDIDATES) {
    const t = await fetchSquigTarget(source, cand);
    if (t) return t;
  }
  return null;
}

/** Return all squig sources (loaded from squigsites.json). */
export async function listSquigSources() {
  return loadSquigSites();
}
