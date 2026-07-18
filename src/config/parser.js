/**
 * Equalizer APO Configuration Parser
 * Parses config.txt into structured data objects
 */

import { GENERATED_COMMENT_RE } from './serializer.js';

const FILTER_TYPES = [
  'PK', 'Modal', 'PEQ',
  'LP', 'LPQ', 'HP', 'HPQ', 'BP',
  'LS', 'LSC', 'LS 6dB', 'LS 12dB',
  'HS', 'HSC', 'HS 6dB', 'HS 12dB',
  'NO', 'AP', 'IIR'
];

const CHANNEL_NAMES = ['L', 'R', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR', 'RC'];
const APO_NUMBER_RE = /[-+]?(?:\d+[\.,]?\d*|[\.,]\d+)(?:[eE][-+]?\d+)?/g;

/**
 * Parse an Equalizer APO config file into structured data
 * @param {string} text - Raw config file content
 * @returns {Object} Parsed configuration
 */
export function parseConfig(text) {
  const lines = text.split(/\r?\n/);
  const config = {
    device: null,
    channels: 'all',
    stage: 'post-mix',
    preamp: 0,
    filters: [],
    graphicEQ: null,
    convolution: null,
    delays: [],
    copies: [],
    vstPlugins: [],
    loudnessCorrection: null,
    includes: [],
    conditionals: [],       // legacy shape, kept for old snapshots — new parses use conditionalBlocks
    conditionalBlocks: [],  // verbatim If…EndIf regions, preserved opaquely (issue #13)
    evals: [],
    comments: [],
    unsupportedLines: [],
    rawLines: []
  };

  let filterIndex = 0;
  let currentChannel = 'all';
  const filterColors = generateFilterColors(20);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    config.rawLines.push(lines[i]);

    // Skip empty lines
    if (!line) continue;

    // Comments
    if (line.startsWith('#')) {
      const commentedCommand = line.replace(/^#\s*/, '');
      const commentedColonIdx = commentedCommand.indexOf(':');
      if (commentedColonIdx !== -1) {
        const commentedCmd = commentedCommand.substring(0, commentedColonIdx).trim().toLowerCase();
        const commentedParams = commentedCommand.substring(commentedColonIdx + 1).trim();
        if (commentedCmd === 'vstplugin') {
          config.vstPlugins.push({ ...parseVSTPlugin(commentedParams, i), enabled: false });
          continue;
        }
        if (commentedCmd === 'loudnesscorrection') {
          config.loudnessCorrection = { ...parseLoudnessCorrection(commentedParams, i), enabled: false };
          continue;
        }
        if (commentedCmd === 'include' && commentedParams) {
          // "# Include: foo.txt" is a disabled include, not prose (issue #22).
          config.includes.push({ file: commentedParams, enabled: false, line: i });
          continue;
        }
      }
      // Skip section headers this app generates itself — storing them would
      // duplicate them on every save. Everything else is user content.
      if (!GENERATED_COMMENT_RE.test(line)) {
        config.comments.push({ line: i, text: line });
      }
      continue;
    }

    // Parse command lines
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const cmdPart = line.substring(0, colonIdx).trim();
    const params = line.substring(colonIdx + 1).trim();

    // If…EndIf regions are preserved verbatim as opaque blocks: the commands
    // inside stay exactly where the user put them, so saving can never move a
    // guarded filter outside its condition (issue #13). Their contents are not
    // editable through the structured UI.
    if (cmdPart.toLowerCase() === 'if') {
      const block = { line: i, lines: [lines[i]] };
      let depth = 1;
      let j = i + 1;
      for (; j < lines.length && depth > 0; j++) {
        const inner = lines[j].trim();
        const innerCmd = inner.includes(':') ? inner.substring(0, inner.indexOf(':')).trim().toLowerCase() : '';
        if (innerCmd === 'if') depth++;
        else if (innerCmd === 'endif') depth--;
        block.lines.push(lines[j]);
        config.rawLines.push(lines[j]);
      }
      config.conditionalBlocks.push(block);
      i = j - 1;
      continue;
    }

    // Handle Filter with number (e.g., "Filter 1:")
    const filterMatch = cmdPart.match(/^Filter\s*(\d*)$/i);
    if (filterMatch) {
      const filter = parseFilter(params, filterIndex, filterColors[filterIndex % filterColors.length]);
      if (filter) {
        filter.channel = currentChannel;
        config.filters.push(filter);
        filterIndex++;
      }
      continue;
    }

    switch (cmdPart.toLowerCase()) {
      case 'preamp':
        config.preamp = parsePreamp(params);
        break;

      case 'device':
        config.device = params;
        break;

      case 'channel':
        config.channels = params;
        currentChannel = normalizeChannelSpec(params);
        break;

      case 'stage':
        config.stage = params.toLowerCase().trim();
        break;

      case 'include':
        config.includes.push({ file: params, enabled: true, line: i });
        break;

      case 'graphiceq':
        config.graphicEQ = parseGraphicEQ(params);
        break;

      case 'convolution':
        config.convolution = { file: params, enabled: true };
        break;

      case 'delay':
        config.delays.push(parseDelay(params));
        break;

      case 'copy':
        config.copies.push(...parseCopy(params));
        break;

      case 'vstplugin':
        config.vstPlugins.push(parseVSTPlugin(params, i));
        break;

      case 'loudnesscorrection':
        config.loudnessCorrection = parseLoudnessCorrection(params, i);
        break;

      case 'elseif':
      case 'else':
      case 'endif':
        // Stray conditional token outside an If block — preserve verbatim.
        config.unsupportedLines.push({ line: i, text: lines[i] });
        break;
      case 'eval':
        config.evals.push({ expr: params, line: i });
        break;

      default:
        config.unsupportedLines.push({ line: i, text: lines[i] });
        break;
    }
  }

  return config;
}

/**
 * Normalize a Channel: directive value into the per-filter channel spec.
 * Known single channel names are canonicalized (issue #14); any other
 * selector (e.g. "L R", numeric channels) is kept verbatim so serialization
 * can reproduce it exactly.
 */
function normalizeChannelSpec(params) {
  const spec = String(params || '').trim();
  if (!spec || spec.toLowerCase() === 'all') return 'all';
  const canonical = CHANNEL_NAMES.find(name => name.toLowerCase() === spec.toLowerCase());
  return canonical || spec;
}

/**
 * Parse a Preamp value
 */
function parsePreamp(params) {
  const match = params.match(/([-+]?[\d.,]+(?:[eE][-+]?\d+)?)\s*dB/i);
  return match ? parseApoNumber(match[1]) : 0;
}

/**
 * Parse a Filter line
 */
function parseFilter(params, index, color) {
  // ON/OFF state
  const onOff = params.match(/^(ON|OFF)\s+/i);
  const enabled = onOff ? onOff[1].toUpperCase() === 'ON' : true;
  let rest = onOff ? params.substring(onOff[0].length) : params;

  // Filter type - try longer types first
  let type = null;
  const sortedTypes = [...FILTER_TYPES].sort((a, b) => b.length - a.length);
  for (const t of sortedTypes) {
    const regex = new RegExp(`^${t.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (regex.test(rest)) {
      type = t;
      rest = rest.replace(regex, '').trim();
      break;
    }
  }

  if (!type) return null;

  // Parse parameters
  const freq = extractParam(rest, 'Fc', 'Hz');
  const gain = extractParam(rest, 'Gain', 'dB');
  let q = extractParam(rest, 'Q');
  let bw = extractParam(rest, 'BW Oct');
  if (bw === null) bw = extractParam(rest, 'BW');

  // IIR custom coefficients
  let iirOrder = null;
  let iirCoefficients = null;
  if (type === 'IIR') {
    const orderMatch = rest.match(/Order\s+(\d+)/i);
    if (orderMatch) iirOrder = parseInt(orderMatch[1]);
    const coeffMatch = rest.match(/Coefficients\s+([\d\s.eE+-]+)/i);
    if (coeffMatch) {
      iirCoefficients = coeffMatch[1].trim().split(/\s+/).map(Number);
    }
  }

  // Modal T60
  let t60 = null;
  if (type === 'Modal') {
    const t60Match = rest.match(/T60\s+target\s+([\d.]+)\s*ms/i);
    if (t60Match) t60 = parseFloat(t60Match[1]);
  }

  return {
    id: `filter_${Date.now()}_${index}`,
    enabled,
    type,
    frequency: freq,
    gain: gain,
    q: q,
    bw: bw,
    iirOrder,
    iirCoefficients,
    t60,
    color,
    index
  };
}

/**
 * Extract a numeric parameter from a filter string
 */
function extractParam(str, name, unit) {
  let pattern;
  if (unit) {
    pattern = new RegExp(`${name}\\s+([-+]?[\\d.,\\u00A0]+(?:[eE][-+]?\\d+)?)\\s*${unit}`, 'i');
  } else {
    pattern = new RegExp(`${name}\\s+([-+]?[\\d.,\\u00A0]+(?:[eE][-+]?\\d+)?)`, 'i');
  }
  const match = str.match(pattern);
  return match ? (name.toLowerCase() === 'fc' ? parseApoFrequency(match[1]) : parseApoNumber(match[1])) : null;
}

/**
 * Parse GraphicEQ bands
 */
function parseGraphicEQ(params) {
  const values = extractNumberPairs(params);
  const bands = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const frequency = values[i];
    const gain = values[i + 1];
    if (Number.isFinite(frequency) && frequency > 0 && Number.isFinite(gain)) {
      bands.push({ frequency, gain });
    }
  }
  bands.sort((a, b) => a.frequency - b.frequency);
  return { bands, enabled: true };
}

/**
 * Parse Delay value
 */
function parseDelay(params) {
  const msMatch = params.match(/([-+]?[\d.,]+(?:[eE][-+]?\d+)?)\s*ms/i);
  if (msMatch) {
    return { value: parseApoNumber(msMatch[1]), unit: 'ms', enabled: true };
  }
  const samplesMatch = params.match(/(\d+)\s*samples/i);
  if (samplesMatch) {
    return { value: parseInt(samplesMatch[1]), unit: 'samples', enabled: true };
  }
  return { value: 0, unit: 'ms', enabled: true };
}

function extractNumberPairs(text) {
  const matches = String(text || '').match(APO_NUMBER_RE) || [];
  return matches.map(parseApoNumber).filter(Number.isFinite);
}

function parseApoNumber(value) {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim().replace(/\u00A0/g, '');
  if (!normalized.includes('.')) normalized = normalized.replace(/,/g, '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse a frequency token using unambiguous separator rules (issue #17).
 * A separator only counts as a thousands separator when the token proves it:
 *   "1.234,5"     \u2192 dots group thousands, comma is the decimal \u2192 1234.5
 *   "1,234.5"     \u2192 commas group thousands, dot is the decimal \u2192 1234.5
 *   "1.000.000"   \u2192 repeated 3-digit dot groups \u2192 1000000
 * A single dot is ALWAYS a decimal point \u2014 "20.000" is 20 Hz, never 20 kHz.
 */
function parseApoFrequency(value) {
  let normalized = String(value ?? '').trim().replace(/\u00A0/g, '');
  const hasDot = normalized.includes('.');
  const hasComma = normalized.includes(',');

  const isGrouped = (str, sep) => {
    const parts = str.replace(/^[-+]/, '').split(sep);
    return parts.length > 2 &&
      /^\d{1,3}$/.test(parts[0]) &&
      parts.slice(1).every(p => /^\d{3}$/.test(p));
  };

  if (hasDot && hasComma) {
    if (normalized.lastIndexOf('.') < normalized.lastIndexOf(',')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');   // 1.234,5
    } else {
      normalized = normalized.replace(/,/g, '');                      // 1,234.5
    }
  } else if (hasComma) {
    normalized = isGrouped(normalized, ',')
      ? normalized.replace(/,/g, '')                                  // 1,000,000
      : normalized.replace(/,/g, '.');                                // 1234,5
  } else if (hasDot && isGrouped(normalized, '.') && !/[eE]/.test(normalized)) {
    normalized = normalized.replace(/\./g, '');                       // 1.000.000
  }

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse Copy assignments
 */
function parseCopy(params) {
  const assignments = params.split(/\s+/);
  const copies = [];
  for (const assignment of assignments) {
    const eqIdx = assignment.indexOf('=');
    if (eqIdx === -1) continue;
    const target = assignment.substring(0, eqIdx);
    const expression = assignment.substring(eqIdx + 1);
    copies.push({ target, expression, enabled: true });
  }
  return copies;
}

/**
 * Parse VSTPlugin settings from Equalizer APO.
 * Syntax: VSTPlugin: Library <dll path> [ChunkData "..."] [Param Value ...]
 */
function parseVSTPlugin(params, line) {
  const libraryMatch = String(params || '').match(/\bLibrary\s+(?:"((?:[^"]|"")*)"|(\S+))/i);
  const library = libraryMatch ? (libraryMatch[1] || libraryMatch[2] || '').replace(/""/g, '"') : '';
  const parameters = libraryMatch
    ? `${params.slice(0, libraryMatch.index)}${params.slice(libraryMatch.index + libraryMatch[0].length)}`.trim()
    : String(params || '').trim();

  return {
    library,
    parameters,
    enabled: true,
    line
  };
}

/**
 * Parse Equalizer APO loudness correction parameters.
 * Syntax: LoudnessCorrection: State 1 ReferenceLevel 75 ReferenceOffset 0 Attenuation 1
 */
function parseLoudnessCorrection(params, line) {
  const parts = splitApoArgs(params);
  const values = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    values.set(parts[i].toLowerCase(), parts[i + 1]);
  }

  const state = parseInt(values.get('state') ?? '1', 10);
  const referenceLevel = parseInt(values.get('referencelevel') ?? '75', 10);
  const referenceOffset = parseInt(values.get('referenceoffset') ?? '0', 10);
  const attenuation = parseApoNumber(values.get('attenuation') ?? '1');

  return {
    enabled: state !== 0,
    referenceLevel: Number.isFinite(referenceLevel) ? referenceLevel : 75,
    referenceOffset: Number.isFinite(referenceOffset) ? referenceOffset : 0,
    attenuation: Number.isFinite(attenuation) ? Math.min(1, Math.max(0, attenuation)) : 1,
    line
  };
}

function splitApoArgs(text) {
  const parts = [];
  const regex = /"((?:[^"]|"")*)"|(\S+)/g;
  let match;
  while ((match = regex.exec(text || '')) !== null) {
    parts.push(match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2]);
  }
  return parts;
}

/**
 * Generate visually distinct colors for filter nodes
 */
function generateFilterColors(count) {
  const colors = [];
  const hues = [190, 270, 330, 45, 150, 210, 300, 30, 120, 240];
  for (let i = 0; i < count; i++) {
    const hue = hues[i % hues.length];
    const sat = 85 + (i % 3) * 5;
    const light = 60 + (i % 2) * 10;
    colors.push(`hsl(${hue}, ${sat}%, ${light}%)`);
  }
  return colors;
}

export { FILTER_TYPES, CHANNEL_NAMES, generateFilterColors };
