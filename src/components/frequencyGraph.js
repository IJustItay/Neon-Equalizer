/**
 * Frequency Response Graph
 * Interactive Canvas-based visualization with draggable filter nodes
 */

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -30;
const MAX_DB = 30;

export class FrequencyGraph {
  constructor(canvas, overlay, tooltip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overlay = overlay;
    this.tooltip = tooltip;
    this.filters = [];
    this.graphicEQ = null;
    this.preamp = 0;

    this.padding = { top: 48, right: 36, bottom: 44, left: 64 };
    this.showIndividual = false;
    this.dbRange = { min: MIN_DB, max: MAX_DB };
    this.viewFreqRange = { min: MIN_FREQ, max: MAX_FREQ };

    // Measurement & Target from Squiglink
    this.measurementData = null; // { freq: [], spl: [] }
    this.measurementMeta = null; // { source, label, color, width }
    this.targetData = null; // { freq: [], spl: [] }
    this.targetMeta = null; // { source, label, sourceId, sourceType, dataKind }

    // Preference bounds overlay
    this.prefBoundsVisible = false;
    this.prefBoundsData = null; // { upper: {freq,spl}, lower: {freq,spl} }

    // Smoothing (1/N octave). 'none', '1/48', '1/24', '1/12', '1/6', '1/3'
    this.smoothing = 'none';
    // Normalization reference frequency (0 = disabled / keep raw alignment)
    this.normalizeFreq = 1000;
    // Show measurement − target delta as a semi-transparent band centred at 0 dB.
    this.showDelta = false;
    this.baselineMode = 'none';
    this.curveVisibility = {
      measurement: true,
      target: true,
      corrected: true,
      eq: true,
    };
    this.curveColors = {
      measurement: null,
      target: '#34d399',
      corrected: '#fb923c',
    };
    this.curveOffsets = {
      measurement: 0,
      target: 0,
      corrected: 0,
      eq: 0,
    };
    this.spectrumAnalyser = null;
    this._spectrumData = null;

    // Dragging state
    this.dragFilter = null;
    this.dragType = null; // 'freq-gain' or 'q'
    this.hoveredFilter = null;
    this.mousePos = { x: 0, y: 0 };
    this.isPanning = false;
    this.panStart = null;

    this.onFilterChange = null; // callback
    this.onFilterSelect = null;
    this.onFilterDelete = null;

    this._animFrame = null;
    this._dpr = window.devicePixelRatio || 1;

    this._setupCanvas();
    this._bindEvents();
    this.render();
  }

  _setupCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * this._dpr;
    this.canvas.height = rect.height * this._dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.scale(this._dpr, this._dpr);
    this.width = rect.width;
    this.height = rect.height;
  }

  _bindEvents() {
    // Resize
    this._resizeObserver = new ResizeObserver(() => {
      this._setupCanvas();
      this.render();
    });
    this._resizeObserver.observe(this.canvas.parentElement);

    // Mouse events on the overlay
    this.overlay.style.pointerEvents = 'auto';
    this.overlay.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.overlay.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this.overlay.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this.overlay.addEventListener('mouseleave', (e) => this._onMouseLeave(e));
    this.overlay.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.overlay.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    this.overlay.addEventListener('contextmenu', (e) => this._onContextMenu(e));
  }

  // Coordinate conversions
  freqToX(freq) {
    const range = this._getFreqView();
    const logMin = Math.log10(range.min);
    const logMax = Math.log10(range.max);
    const logFreq = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)));
    return this.padding.left + (logFreq - logMin) / (logMax - logMin) * (this.width - this.padding.left - this.padding.right);
  }

  xToFreq(x) {
    const range = this._getFreqView();
    const logMin = Math.log10(range.min);
    const logMax = Math.log10(range.max);
    const ratio = Math.max(0, Math.min(1, (x - this.padding.left) / (this.width - this.padding.left - this.padding.right)));
    return Math.pow(10, logMin + ratio * (logMax - logMin));
  }

  dbToY(db) {
    const ratio = (db - this.dbRange.max) / (this.dbRange.min - this.dbRange.max);
    return this.padding.top + ratio * (this.height - this.padding.top - this.padding.bottom);
  }

  yToDb(y) {
    const ratio = (y - this.padding.top) / (this.height - this.padding.top - this.padding.bottom);
    return this.dbRange.max + ratio * (this.dbRange.min - this.dbRange.max);
  }

  resetView() {
    this.viewFreqRange = { min: MIN_FREQ, max: MAX_FREQ };
    this.dbRange = { min: MIN_DB, max: MAX_DB };
    this.render();
  }

  resetDisplayState() {
    this.viewFreqRange = { min: MIN_FREQ, max: MAX_FREQ };
    this.dbRange = { min: MIN_DB, max: MAX_DB };
    this.showIndividual = false;
    this.smoothing = 'none';
    this.normalizeFreq = 1000;
    this._renormalizeLoaded();
    this.showDelta = false;
    this.baselineMode = 'none';
    this.prefBoundsVisible = false;
    this.curveVisibility = {
      measurement: true,
      target: true,
      corrected: true,
      eq: true,
    };
    this.curveOffsets = {
      measurement: 0,
      target: 0,
      corrected: 0,
      eq: 0,
    };
    this.render();
  }

  _getFreqView() {
    const min = Number.isFinite(this.viewFreqRange?.min) ? this.viewFreqRange.min : MIN_FREQ;
    const max = Number.isFinite(this.viewFreqRange?.max) ? this.viewFreqRange.max : MAX_FREQ;
    if (max <= min) return { min: MIN_FREQ, max: MAX_FREQ };
    return {
      min: Math.max(MIN_FREQ, Math.min(MAX_FREQ, min)),
      max: Math.max(MIN_FREQ, Math.min(MAX_FREQ, max)),
    };
  }

  _setFreqView(min, max) {
    const fullMin = Math.log10(MIN_FREQ);
    const fullMax = Math.log10(MAX_FREQ);
    const fullSpan = fullMax - fullMin;
    let minLog = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, min)));
    let maxLog = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, max)));
    if (maxLog < minLog) [minLog, maxLog] = [maxLog, minLog];

    let span = Math.max(Math.log10(1.5), Math.min(fullSpan, maxLog - minLog));
    if (span >= fullSpan - 0.001) {
      this.viewFreqRange = { min: MIN_FREQ, max: MAX_FREQ };
      return;
    }

    let center = (minLog + maxLog) / 2;
    minLog = center - span / 2;
    maxLog = center + span / 2;
    if (minLog < fullMin) {
      maxLog += fullMin - minLog;
      minLog = fullMin;
    }
    if (maxLog > fullMax) {
      minLog -= maxLog - fullMax;
      maxLog = fullMax;
    }

    this.viewFreqRange = {
      min: Math.pow(10, Math.max(fullMin, minLog)),
      max: Math.pow(10, Math.min(fullMax, maxLog)),
    };
  }

  _setDbView(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (max < min) [min, max] = [max, min];
    const minSpan = 3;
    const maxSpan = 120;
    const hardMin = -120;
    const hardMax = 120;
    let span = Math.max(minSpan, Math.min(maxSpan, max - min));
    let center = (min + max) / 2;
    min = center - span / 2;
    max = center + span / 2;
    if (min < hardMin) {
      max += hardMin - min;
      min = hardMin;
    }
    if (max > hardMax) {
      min -= max - hardMax;
      max = hardMax;
    }
    this.dbRange = {
      min: Math.max(hardMin, min),
      max: Math.min(hardMax, max),
    };
  }

  _isInsidePlot(x, y) {
    return x >= this.padding.left &&
      x <= this.width - this.padding.right &&
      y >= this.padding.top &&
      y <= this.height - this.padding.bottom;
  }

  // Update filters
  setFilters(filters) {
    this.filters = filters;
    this.render();
  }

  setGraphicEQ(graphicEQ) {
    this.graphicEQ = graphicEQ && graphicEQ.enabled !== false ? graphicEQ : null;
    this.render();
  }

  setPreamp(val) {
    this.preamp = val;
    this.render();
  }

  // Calculate biquad filter response at frequency
  _calcFilterResponse(filter, freq, sampleRate = 48000) {
    if (!filter.enabled || !filter.frequency) return 0;

    const w0 = 2 * Math.PI * filter.frequency / sampleRate;
    const w = 2 * Math.PI * freq / sampleRate;
    const Q = filter.q || 0.707;
    const gain = filter.gain || 0;
    const A = Math.pow(10, gain / 40);

    let alpha;
    if (filter.bw) {
      alpha = Math.sin(w0) * Math.sinh(Math.log(2) / 2 * filter.bw * w0 / Math.sin(w0));
    } else {
      alpha = Math.sin(w0) / (2 * Q);
    }

    let b0, b1, b2, a0, a1, a2;

    switch (filter.type) {
      case 'PK':
      case 'PEQ':
      case 'Modal':
        b0 = 1 + alpha * A;
        b1 = -2 * Math.cos(w0);
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha / A;
        break;

      case 'LP':
      case 'LPQ':
        b0 = (1 - Math.cos(w0)) / 2;
        b1 = 1 - Math.cos(w0);
        b2 = (1 - Math.cos(w0)) / 2;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'HP':
      case 'HPQ':
        b0 = (1 + Math.cos(w0)) / 2;
        b1 = -(1 + Math.cos(w0));
        b2 = (1 + Math.cos(w0)) / 2;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'BP':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'NO':
        b0 = 1;
        b1 = -2 * Math.cos(w0);
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'AP':
        b0 = 1 - alpha;
        b1 = -2 * Math.cos(w0);
        b2 = 1 + alpha;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'LS':
      case 'LSC':
      case 'LS 6dB':
      case 'LS 12dB': {
        const sq = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * Math.cos(w0) + sq);
        b1 = 2 * A * ((A - 1) - (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - sq);
        a0 = (A + 1) + (A - 1) * Math.cos(w0) + sq;
        a1 = -2 * ((A - 1) + (A + 1) * Math.cos(w0));
        a2 = (A + 1) + (A - 1) * Math.cos(w0) - sq;
        break;
      }

      case 'HS':
      case 'HSC':
      case 'HS 6dB':
      case 'HS 12dB': {
        const sqh = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + sqh);
        b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) + (A - 1) * Math.cos(w0) - sqh);
        a0 = (A + 1) - (A - 1) * Math.cos(w0) + sqh;
        a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0));
        a2 = (A + 1) - (A - 1) * Math.cos(w0) - sqh;
        break;
      }

      default:
        return 0;
    }

    // Calculate magnitude response at frequency w
    const phi = Math.pow(Math.sin(w / 2), 2);
    const numR = Math.pow(b0 / a0 + b1 / a0 + b2 / a0, 2) -
                 4 * (b0 * b1 / (a0 * a0) + 4 * b0 * b2 / (a0 * a0) + b1 * b2 / (a0 * a0)) * phi +
                 16 * b0 * b2 / (a0 * a0) * phi * phi;
    const denR = Math.pow(1 + a1 / a0 + a2 / a0, 2) -
                 4 * (a1 / a0 + 4 * a2 / a0 + a1 * a2 / (a0 * a0)) * phi +
                 16 * a2 / a0 * phi * phi;

    // Use direct z-transform evaluation for more accuracy
    const cosw = Math.cos(w);
    const cos2w = Math.cos(2 * w);
    const sinw = Math.sin(w);
    const sin2w = Math.sin(2 * w);

    const numReal = b0 / a0 + (b1 / a0) * cosw + (b2 / a0) * cos2w;
    const numImag = -(b1 / a0) * sinw - (b2 / a0) * sin2w;
    const denReal = 1 + (a1 / a0) * cosw + (a2 / a0) * cos2w;
    const denImag = -(a1 / a0) * sinw - (a2 / a0) * sin2w;

    const numMag = Math.sqrt(numReal * numReal + numImag * numImag);
    const denMag = Math.sqrt(denReal * denReal + denImag * denImag);

    if (denMag === 0) return 0;
    return 20 * Math.log10(numMag / denMag);
  }

  // Calculate combined response at frequency.
  // Preamp is a flat headroom shift — excluded here so the EQ curve shows
  // the frequency-dependent gain pattern only. getPeakGain still works
  // because it temporarily sets this.preamp = 0 before sampling.
  _calcCombinedResponse(freq) {
    let total = 0;
    for (const f of this.filters) {
      total += this._calcFilterResponse(f, freq);
    }
    total += this._calcGraphicResponse(freq);
    return total;
  }

  _calcGraphicResponse(freq) {
    const bands = this.graphicEQ?.bands;
    if (!bands || !bands.length) return 0;

    const sorted = bands
      .filter(b => Number.isFinite(b.frequency) && Number.isFinite(b.gain))
      .slice()
      .sort((a, b) => a.frequency - b.frequency);
    if (!sorted.length) return 0;
    if (freq <= sorted[0].frequency) return sorted[0].gain;
    const last = sorted.length - 1;
    if (freq >= sorted[last].frequency) return sorted[last].gain;

    for (let i = 0; i < last; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (freq < a.frequency || freq > b.frequency) continue;
      const ratio = Math.log(freq / a.frequency) / Math.log(b.frequency / a.frequency);
      return a.gain + (b.gain - a.gain) * Math.max(0, Math.min(1, ratio));
    }
    return 0;
  }

  // Get the maximum peak gain across the frequency spectrum
  getPeakGain() {
    let maxDb = -Infinity;
    // Sample 200 points across log scale from 20 to 20000 Hz
    const logMin = Math.log10(MIN_FREQ);
    const logMax = Math.log10(MAX_FREQ);
    const numPoints = 200;
    
    // Evaluate without preamp since we want to find the raw peak to offset
    const originalPreamp = this.preamp;
    this.preamp = 0;
    
    for (let i = 0; i <= numPoints; i++) {
        const ratio = i / numPoints;
        const freq = Math.pow(10, logMin + ratio * (logMax - logMin));
        const db = this._calcCombinedResponse(freq);
        if (db > maxDb) {
            maxDb = db;
        }
    }
    
    this.preamp = originalPreamp;
    return maxDb;
  }

  setMeasurementData(data, meta = {}) {
    if (!data) {
      this.measurementData = null;
      this._rawMeasurementData = null;
      this.measurementMeta = null;
    } else {
      const clean = this._sanitizeCurve(data);
      this._rawMeasurementData = { freq: clean.freq.slice(), spl: clean.spl.slice() };
      this.measurementData = this.normalizeSplData(clean);
      this.measurementMeta = {
        source: meta.source || 'measurement',
        label: meta.label || 'Measurement',
        color: meta.color || '#8ab4ff',
        width: meta.width || 1.5,
        sourceId: meta.sourceId || null,
        sourceName: meta.sourceName || null,
        sourceType: meta.sourceType || null,
        dataKind: meta.dataKind || 'raw',
        gearName: meta.gearName || null,
        deltaReady: meta.deltaReady,
        path: meta.path || null,
      };
    }
    this.render();
  }

  setTargetData(data, meta = {}) {
    if (!data) {
      this.targetData = null;
      this._rawTargetData = null;
      this.targetMeta = null;
    } else {
      const clean = this._sanitizeCurve(data);
      this._rawTargetData = { freq: clean.freq.slice(), spl: clean.spl.slice() };
      this.targetData = this.normalizeSplData(clean);
      this.targetMeta = {
        source: meta.source || 'target',
        label: meta.label || 'Target',
        sourceId: meta.sourceId || null,
        sourceName: meta.sourceName || null,
        sourceType: meta.sourceType || null,
        category: meta.category || null,
        dataKind: meta.dataKind || 'target',
        allowCrossSource: !!meta.allowCrossSource,
        allowUnsafeMatch: !!meta.allowUnsafeMatch,
        deltaReady: meta.deltaReady,
        customized: !!meta.customized,
        adjustmentLabel: meta.adjustmentLabel || null,
        path: meta.path || null,
      };
    }
    this.render();
  }

  getCurveCompatibility() {
    const errors = [];
    const warnings = [];
    const measurement = this.measurementMeta || {};
    const target = this.targetMeta || {};
    const unrestricted = !!target.allowUnsafeMatch;

    if (!this.measurementData) errors.push('No measurement loaded.');
    if (!this.targetData) errors.push('No target loaded.');
    if (errors.length) return { ok: false, errors, warnings, message: errors[0] };

    if ((measurement.dataKind || 'raw') !== 'raw') {
      if (unrestricted) {
        warnings.push('Free reviewer targets: compensated/delta measurement is allowed, but alignment may be less reliable.');
      } else {
        errors.push('Measurement is marked as compensated/delta data. Load or mark it as raw FR before comparing to a target.');
      }
    }

    if (target.category === 'reviewer') {
      if (measurement.sourceId && target.sourceId && measurement.sourceId !== target.sourceId) {
        if (target.allowCrossSource || unrestricted) {
          warnings.push(`Cross-reviewer target: measurement is from ${measurement.sourceName || measurement.sourceId}, target is from ${target.sourceName || target.sourceId}.`);
        } else {
          errors.push(`Reviewer mismatch: measurement is from ${measurement.sourceName || measurement.sourceId}, target is from ${target.sourceName || target.sourceId}. Enable Free reviewer targets to allow this.`);
        }
      } else if (!measurement.sourceId && measurement.source === 'trace') {
        warnings.push(unrestricted
          ? 'Free reviewer targets: trace source is accepted for this target.'
          : 'Trace source is not verified. Use a trace captured from the same reviewer and rig as the selected target.');
      }
    }

    const genericTypes = new Set(['generic', 'unknown']);
    const measurementType = this._gearFamily(measurement.sourceType);
    const targetType = this._gearFamily(target.sourceType);
    if (
      measurementType &&
      targetType &&
      !genericTypes.has(measurementType) &&
      !genericTypes.has(targetType) &&
      measurementType !== targetType
    ) {
      if (target.allowCrossSource || unrestricted) {
        warnings.push(`Cross-rig target: measurement is ${measurement.sourceType}, target is ${target.sourceType}.`);
      } else {
        errors.push(`Rig mismatch: measurement is ${measurement.sourceType}, target is ${target.sourceType}.`);
      }
    }

    const overlap = this._curveOverlap(this.measurementData, this.targetData);
    if (!overlap) {
      errors.push('Measurement and target have no overlapping frequency range.');
    } else {
      const octaves = Math.log2(overlap.max / overlap.min);
      if (octaves < 5) warnings.push(`Limited overlap (${Math.round(overlap.min)}-${Math.round(overlap.max)} Hz); AutoEQ/delta may be unreliable.`);
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      message: errors[0] || warnings[0] || 'Measurement and target are compatible.',
    };
  }

  _curveOverlap(a, b) {
    if (!a?.freq?.length || !b?.freq?.length) return null;
    const min = Math.max(a.freq[0], b.freq[0], MIN_FREQ);
    const max = Math.min(a.freq[a.freq.length - 1], b.freq[b.freq.length - 1], MAX_FREQ);
    return max > min ? { min, max } : null;
  }

  _gearFamily(type) {
    const t = String(type || '').trim().toLowerCase();
    if (!t) return '';
    if (['iems', 'iem', '711', 'iec711', 'iec 711', 'clone iec 711'].includes(t)) return '711';
    if (t.includes('711')) return '711';
    if (t.includes('5128')) return '5128';
    if (t.includes('headphone')) return 'headphones';
    if (t.includes('earbud')) return 'earbuds';
    if (t === 'generic' || t === 'unknown') return t;
    return t;
  }

  setPrefBounds(data) {
    // data: { upper: {freq:[],spl:[]}, lower: {freq:[],spl:[]} } or null
    this.prefBoundsData = data;
    this.render();
  }

  togglePrefBounds() {
    this.prefBoundsVisible = !this.prefBoundsVisible;
    this.render();
    return this.prefBoundsVisible;
  }

  // Normalizes an array of SPL values to 0 dB at the configured reference frequency.
  normalizeSplData(data) {
    data = this._sanitizeCurve(data);
    if (!data || !data.freq || !data.freq.length) return data;
    const ref = this.normalizeFreq;
    if (!ref || ref <= 0) return { freq: data.freq, spl: data.spl.slice() };

    const refSpl = this._interpolateSplAt(data, ref);
    return {
      freq: data.freq,
      spl: data.spl.map(s => s - refSpl),
    };
  }

  _sanitizeCurve(data) {
    if (!data || !Array.isArray(data.freq) || !Array.isArray(data.spl)) return { freq: [], spl: [] };
    const pairs = [];
    const len = Math.min(data.freq.length, data.spl.length);
    for (let i = 0; i < len; i++) {
      const freq = Number(data.freq[i]);
      const spl = Number(data.spl[i]);
      if (Number.isFinite(freq) && Number.isFinite(spl) && freq >= 10 && freq <= 25000) {
        pairs.push({ freq, spl });
      }
    }
    pairs.sort((a, b) => a.freq - b.freq);

    const freq = [];
    const spl = [];
    for (const pair of pairs) {
      const last = freq.length - 1;
      if (last >= 0 && Math.abs(freq[last] - pair.freq) < 0.0001) {
        spl[last] = (spl[last] + pair.spl) / 2;
      } else {
        freq.push(pair.freq);
        spl.push(pair.spl);
      }
    }
    return { freq, spl };
  }

  _interpolateSplAt(data, freq) {
    const freqs = data.freq;
    const spl = data.spl;
    if (!freqs.length) return 0;
    if (freq <= freqs[0]) return spl[0] || 0;
    const last = freqs.length - 1;
    if (freq >= freqs[last]) return spl[last] || 0;

    for (let i = 0; i < last; i++) {
      const f0 = freqs[i];
      const f1 = freqs[i + 1];
      if (freq < f0 || freq > f1) continue;
      if (f1 === f0) return spl[i] || 0;
      const ratio = Math.log(freq / f0) / Math.log(f1 / f0);
      return spl[i] + (spl[i + 1] - spl[i]) * Math.max(0, Math.min(1, ratio));
    }
    return spl[0] || 0;
  }

  /** Reapply normalization to already-loaded measurement + target curves. */
  _renormalizeLoaded() {
    if (this._rawMeasurementData) this.measurementData = this.normalizeSplData(this._rawMeasurementData);
    if (this._rawTargetData) this.targetData = this.normalizeSplData(this._rawTargetData);
  }

  setSmoothing(val) {
    this.smoothing = val || 'none';
    this.render();
  }

  setNormalizeFreq(freq) {
    this.normalizeFreq = Math.max(0, +freq || 0);
    this._renormalizeLoaded();
    this.render();
  }

  getRawMeasurementData() {
    return this._rawMeasurementData || this.measurementData;
  }

  getRawTargetData() {
    return this._rawTargetData || this.targetData;
  }

  setBaselineMode(mode) {
    this.baselineMode = ['none', 'target', 'measurement'].includes(mode) ? mode : 'none';
    this.render();
    return this.baselineMode;
  }

  setCurveVisible(curve, visible) {
    if (!(curve in this.curveVisibility)) return false;
    this.curveVisibility[curve] = !!visible;
    this.render();
    return this.curveVisibility[curve];
  }

  setCurveColor(curve, color) {
    if (!(curve in this.curveColors)) return;
    this.curveColors[curve] = color || null;
    this.render();
  }

  toggleCurveVisible(curve) {
    if (!(curve in this.curveVisibility)) return false;
    return this.setCurveVisible(curve, !this.curveVisibility[curve]);
  }

  adjustCurveOffset(curve, deltaDb) {
    if (!(curve in this.curveOffsets)) return 0;
    const next = Math.max(-60, Math.min(60, this.curveOffsets[curve] + (+deltaDb || 0)));
    this.curveOffsets[curve] = Math.round(next * 10) / 10;
    this.render();
    return this.curveOffsets[curve];
  }

  setCurveOffset(curve, db) {
    if (!(curve in this.curveOffsets)) return 0;
    const next = Math.max(-60, Math.min(60, +db || 0));
    this.curveOffsets[curve] = Math.round(next * 10) / 10;
    this.render();
    return this.curveOffsets[curve];
  }

  cycleDbRange() {
    const scales = [[-30, 30], [-20, 20], [-40, 40], [-15, 15]];
    const idx = scales.findIndex(s => s[0] === this.dbRange.min && s[1] === this.dbRange.max);
    const next = scales[(idx + 1) % scales.length];
    this.dbRange = { min: next[0], max: next[1] };
    this.render();
    return `±${next[1]} dB`;
  }

  setShowDelta(on) {
    this.showDelta = !!on;
    this.render();
    return this.showDelta;
  }

  _alignmentReference(meas, target) {
    const overlap = this._curveOverlap(meas, target);
    if (!overlap) return this.normalizeFreq || 1000;
    const desired = this.normalizeFreq > 0 ? this.normalizeFreq : 1000;
    return Math.max(overlap.min, Math.min(overlap.max, desired));
  }

  _alignTargetToMeasurement(meas, target) {
    if (!meas || !target) return target;
    const ref = this._alignmentReference(meas, target);
    const measRef = this._interpolateSplAt(meas, ref);
    const targetRef = this._interpolateSplAt(target, ref);
    const offset = measRef - targetRef;
    if (!Number.isFinite(offset) || Math.abs(offset) < 0.0001) return target;
    return {
      freq: target.freq,
      spl: target.spl.map(v => v + offset),
    };
  }

  _offsetCurve(data, db = 0) {
    if (!data || !data.freq?.length) return data;
    if (!Number.isFinite(db) || Math.abs(db) < 0.0001) return data;
    return {
      freq: data.freq,
      spl: data.spl.map(v => v + db),
    };
  }

  _compensateToBaseline(data, baseline) {
    if (!data || !baseline?.freq?.length) return data;
    return {
      freq: data.freq,
      spl: data.freq.map((freq, i) => data.spl[i] - this._interpolateSplAt(baseline, freq)),
    };
  }

  _displayCurve(data, curveKey, baselineData = null) {
    if (!data || !data.freq?.length) return data;
    let out = data;
    if (baselineData) out = this._compensateToBaseline(out, baselineData);
    return this._offsetCurve(out, this.curveOffsets[curveKey] || 0);
  }

  setSpectrumAnalyser(analyser) {
    this.spectrumAnalyser = analyser || null;
    this._spectrumData = null;
    this.render();
  }

  /**
   * Apply 1/N-octave smoothing to a {freq, spl} curve.
   * Ports the binning approach from modernGraphTool's FRSmoother.
   */
  _smoothCurve(data) {
    if (!data || !data.freq || !data.freq.length) return data;
    const fractions = { '1/48': 1/48, '1/24': 1/24, '1/12': 1/12, '1/6': 1/6, '1/3': 1/3 };
    const fr = fractions[this.smoothing];
    if (!fr) return data;

    // Build octave bands
    const bands = [];
    let f = 20;
    while (f < 20000) {
      const upper = f * Math.pow(2, fr);
      bands.push({ lower: f, upper, center: Math.sqrt(f * upper) });
      f = upper;
    }

    // Bin the curve into bands and average
    const outFreq = [];
    const outSpl = [];
    for (const band of bands) {
      const values = [];
      for (let i = 0; i < data.freq.length; i++) {
        if (data.freq[i] >= band.lower && data.freq[i] <= band.upper) values.push(data.spl[i]);
      }
      if (values.length) {
        outFreq.push(band.center);
        outSpl.push(values.reduce((a, b) => a + b, 0) / values.length);
      }
    }
    return { freq: outFreq, spl: outSpl };
  }

  /**
   * Export the current canvas as a PNG blob and trigger a download.
   * Re-renders at 2× DPR for crispness, then restores.
   */
  saveScreenshot(filename) {
    try {
      // Build a temporary high-res canvas
      const scale = 2;
      const tmp = document.createElement('canvas');
      tmp.width = this.width * scale;
      tmp.height = this.height * scale;
      const tctx = tmp.getContext('2d');
      tctx.fillStyle = this._theme().screenshotBg;
      tctx.fillRect(0, 0, tmp.width, tmp.height);
      tctx.drawImage(this.canvas, 0, 0, tmp.width, tmp.height);
      const url = tmp.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `eq-graph-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    } catch (err) {
      console.error('Screenshot failed:', err);
      return false;
    }
  }

  _theme() {
    const light = document.documentElement?.dataset?.theme === 'light';
    return light
      ? {
          screenshotBg: '#f6f9fc',
          bg0: 'rgba(0, 143, 189, 0.055)',
          bg1: 'rgba(4, 120, 87, 0.025)',
          grid: 'rgba(15, 23, 42, 0.10)',
          gridStrong: 'rgba(15, 23, 42, 0.22)',
          label: 'rgba(15, 23, 42, 0.48)',
          labelStrong: 'rgba(15, 23, 42, 0.66)',
          axis: 'rgba(15, 23, 42, 0.40)',
          nodeFill: '#ffffff',
        }
      : {
          screenshotBg: '#0a0a0f',
          bg0: 'rgba(0, 212, 255, 0.02)',
          bg1: 'rgba(124, 58, 237, 0.01)',
          grid: 'rgba(255, 255, 255, 0.04)',
          gridStrong: 'rgba(255, 255, 255, 0.12)',
          label: 'rgba(255, 255, 255, 0.2)',
          labelStrong: 'rgba(255, 255, 255, 0.4)',
          axis: 'rgba(255, 255, 255, 0.15)',
          nodeFill: '#0a0a0f',
        };
  }

  // Render
  render() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    this._animFrame = requestAnimationFrame(() => this._draw());
  }

  _draw() {
    this._animFrame = null;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);
    const theme = this._theme();

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, theme.bg0);
    bgGrad.addColorStop(1, theme.bg1);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    this._drawGrid(ctx, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(
      this.padding.left,
      this.padding.top,
      w - this.padding.left - this.padding.right,
      h - this.padding.top - this.padding.bottom
    );
    ctx.clip();
    this._drawCurves(ctx, w, h);
    if (this.curveVisibility.eq) this._drawNodes(ctx);
    ctx.restore();

    if (this.spectrumAnalyser) this.render();
  }

  _drawGrid(ctx, w, h) {
    const theme = this._theme();
    const plotLeft = this.padding.left;
    const plotRight = w - this.padding.right;
    const plotTop = this.padding.top;
    const plotBottom = h - this.padding.bottom;

    // Frequency grid lines (logarithmic)
    const freqLines = this._getFrequencyTicks(plotRight - plotLeft);
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px Inter';
    ctx.fillStyle = theme.label;
    ctx.textAlign = 'center';

    for (const freq of freqLines) {
      const x = this.freqToX(freq);
      if (x < plotLeft || x > plotRight) continue;

      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();

      ctx.fillText(formatAxisFreq(freq), x, plotBottom + 18);
    }

    // dB grid lines
    const dbTicks = this._getDbTicks();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const db of dbTicks) {
      const y = this.dbToY(db);
      if (y < plotTop || y > plotBottom) continue;

      ctx.strokeStyle = db === 0 ? theme.gridStrong : theme.grid;
      ctx.lineWidth = db === 0 ? 1.5 : 1;

      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();

      ctx.fillStyle = db === 0 ? theme.labelStrong : theme.label;
      ctx.fillText(formatAxisDb(db), plotLeft - 10, y);
    }

    // Hz label
    ctx.fillStyle = theme.axis;
    ctx.textAlign = 'center';
    ctx.fillText('Hz', (plotLeft + plotRight) / 2, plotBottom + 32);

    // dB label
    ctx.save();
    ctx.translate(18, (plotTop + plotBottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('dB', 0, 0);
    ctx.restore();
  }

  _getFrequencyTicks(plotWidth = 700) {
    const range = this._getFreqView();
    const multipliers = [1, 2, 3, 5];
    const ticks = [];
    for (let power = 1; power <= 5; power++) {
      const base = Math.pow(10, power);
      for (const m of multipliers) {
        const value = m * base;
        if (value >= range.min * 0.999 && value <= range.max * 1.001 && value >= MIN_FREQ && value <= MAX_FREQ) {
          ticks.push(value);
        }
      }
    }

    const minGap = plotWidth < 520 ? 54 : 42;
    const visible = [];
    for (const tick of ticks.sort((a, b) => a - b)) {
      const x = this.freqToX(tick);
      if (visible.length && x - visible[visible.length - 1].x < minGap) continue;
      visible.push({ tick, x });
    }
    return visible.map(v => v.tick);
  }

  _getDbTicks() {
    const min = this.dbRange.min;
    const max = this.dbRange.max;
    const span = Math.max(1, max - min);
    const roughStep = span / 8;
    const power = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const normalized = roughStep / power;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    const step = nice * power;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let value = start; value <= max + step * 0.25; value += step) {
      const rounded = Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(step < 1 ? 1 : 0));
      if (rounded >= min - 1e-6 && rounded <= max + 1e-6) ticks.push(rounded);
    }
    return ticks;
  }

  _drawCurves(ctx, w, h) {
    const plotLeft = this.padding.left;
    const plotRight = w - this.padding.right;
    const numPoints = Math.ceil((plotRight - plotLeft) / 2);

    this._drawSpectrumOverlay(ctx, plotLeft, plotRight);

    if (this.curveVisibility.eq) {
    // Individual filter curves
    if (this.showIndividual) {
      for (const filter of this.filters) {
        if (!filter.enabled) continue;

        ctx.beginPath();
        for (let i = 0; i <= numPoints; i++) {
          const x = plotLeft + (i / numPoints) * (plotRight - plotLeft);
          const freq = this.xToFreq(x);
          const db = this._calcFilterResponse(filter, freq) + (this.curveOffsets.eq || 0);
          const y = this.dbToY(db);

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = filter.color || '#00d4ff';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Combined curve
    ctx.beginPath();
    const points = [];
    for (let i = 0; i <= numPoints; i++) {
      const x = plotLeft + (i / numPoints) * (plotRight - plotLeft);
      const freq = this.xToFreq(x);
      const db = this._calcCombinedResponse(freq) + (this.curveOffsets.eq || 0);
      const y = this.dbToY(db);
      points.push({ x, y });

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    // Stroke combined curve with gradient
    const curveGrad = ctx.createLinearGradient(0, 0, w, 0);
    curveGrad.addColorStop(0, '#00d4ff');
    curveGrad.addColorStop(0.5, '#7c3aed');
    curveGrad.addColorStop(1, '#ec4899');
    ctx.strokeStyle = curveGrad;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Fill area under curve
    const zeroY = this.dbToY(this.curveOffsets.eq || 0);
    ctx.lineTo(plotRight, zeroY);
    ctx.lineTo(plotLeft, zeroY);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, 0, w, 0);
    fillGrad.addColorStop(0, 'rgba(0, 212, 255, 0.08)');
    fillGrad.addColorStop(0.5, 'rgba(124, 58, 237, 0.06)');
    fillGrad.addColorStop(1, 'rgba(236, 72, 153, 0.04)');
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Glow effect
    ctx.beginPath();
    for (let i = 0; i <= numPoints; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = curveGrad;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.15;
    ctx.stroke();
    ctx.globalAlpha = 1;
    }

    // --- Draw Preference Bounds ---
    if (this.prefBoundsVisible && this.prefBoundsData) {
      const { upper, lower } = this.prefBoundsData;
      if (upper && lower && upper.freq.length && lower.freq.length) {
        // Build filled polygon: upper path forward + lower path backward
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < upper.freq.length; i++) {
          const x = this.freqToX(upper.freq[i]);
          const y = this.dbToY(upper.spl[i]);
          if (x < plotLeft || x > plotRight) continue;
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        for (let i = lower.freq.length - 1; i >= 0; i--) {
          const x = this.freqToX(lower.freq[i]);
          const y = this.dbToY(lower.spl[i]);
          if (x < plotLeft || x > plotRight) continue;
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(250, 200, 50, 0.08)';
        ctx.fill();

        // Upper bound line
        ctx.beginPath();
        started = false;
        for (let i = 0; i < upper.freq.length; i++) {
          const x = this.freqToX(upper.freq[i]);
          const y = this.dbToY(upper.spl[i]);
          if (x < plotLeft || x > plotRight) continue;
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(250, 200, 50, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Lower bound line
        ctx.beginPath();
        started = false;
        for (let i = 0; i < lower.freq.length; i++) {
          const x = this.freqToX(lower.freq[i]);
          const y = this.dbToY(lower.spl[i]);
          if (x < plotLeft || x > plotRight) continue;
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(250, 200, 50, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- Draw Target & Measurement Overlays ---

    // Helper to stroke a {freq, spl} curve within the plot area.
    const strokeSplCurve = (data, options) => {
      if (!data || !data.freq || !data.freq.length) return;
      const { color, width = 1.5, dash = null, shadow = null } = options;
      ctx.save();
      if (shadow) {
        ctx.shadowColor = shadow.color;
        ctx.shadowBlur = shadow.blur;
      }
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap  = 'round';
      if (dash) ctx.setLineDash(dash);
      let started = false;
      for (let i = 0; i < data.freq.length; i++) {
        const x = this.freqToX(data.freq[i]);
        const y = this.dbToY(data.spl[i]);
        if (x < plotLeft || x > plotRight) continue;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    const targetBase = this.smoothing !== 'none' ? this._smoothCurve(this.targetData) : this.targetData;
    const measBase = this.smoothing !== 'none' ? this._smoothCurve(this.measurementData) : this.measurementData;
    const baselineData = this.baselineMode === 'target'
      ? targetBase
      : this.baselineMode === 'measurement'
        ? measBase
        : null;

    // Target: dashed green (thin, squig-style). No glow by default.
    const targetDrawn = this._displayCurve(targetBase, 'target', baselineData);
    if (this.curveVisibility.target) {
      strokeSplCurve(targetDrawn, {
        color: this.curveColors.target || '#34d399',
        width: 1.2,
        dash: [4, 3],
      });
    }

    // Measurement tier: source/trace data selected for AutoEQ.
    const measDrawn = this._displayCurve(measBase, 'measurement', baselineData);
    const measMeta = this.measurementMeta || {};
    if (this.curveVisibility.measurement) {
      strokeSplCurve(measDrawn, {
        color: this.curveColors.measurement || measMeta.color || '#8ab4ff',
        width: measMeta.width || 1.5,
      });
    }

    // Delta band (measurement - target), using a target aligned to the measurement ref.
    if (this.showDelta && measBase && targetBase && this.getCurveCompatibility().ok) {
      this._drawDeltaBand(ctx, measBase, this._alignTargetToMeasurement(measBase, targetBase), plotLeft, plotRight);
    }

    // Corrected response: measurement + EQ filters. Distinct orange + dot-dash.
    // Preamp is a flat level shift (headroom) and must not offset the shape we
    // compare against the target — exclude it so the corrected curve sits on
    // top of the target when filters match.
    if (this.curveVisibility.corrected && measBase && this.filters && this.filters.length) {
      const corrected = {
        freq: measBase.freq,
        spl: measBase.freq.map((f, i) => {
          let s = measBase.spl[i];
          for (const filt of this.filters) {
            if (!filt.isEffect) s += this._calcFilterResponse(filt, f);
          }
          return s + this._calcGraphicResponse(f);
        }),
      };
      strokeSplCurve(this._displayCurve(corrected, 'corrected', baselineData), {
        color: this.curveColors.corrected || '#fb923c',
        width: 1.5,
        dash: [6, 2, 2, 2],
      });
    }
  }

  _drawSpectrumOverlay(ctx, plotLeft, plotRight) {
    const analyser = this.spectrumAnalyser;
    if (!analyser) return;

    const plotTop = this.padding.top;
    const plotBottom = this.height - this.padding.bottom;
    const binCount = analyser.frequencyBinCount;
    if (!this._spectrumData || this._spectrumData.length !== binCount) {
      this._spectrumData = new Uint8Array(binCount);
    }

    analyser.getByteFrequencyData(this._spectrumData);

    const nyquist = analyser.context.sampleRate / 2;
    const pointCount = 180;
    const points = [];
    for (let i = 0; i <= pointCount; i++) {
      const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / pointCount);
      const bin = Math.min(binCount - 1, Math.max(0, Math.round((freq / nyquist) * binCount)));
      const magnitude = Math.pow(this._spectrumData[bin] / 255, 0.85);
      const x = this.freqToX(freq);
      const y = plotBottom - magnitude * (plotBottom - plotTop);
      points.push({ x, y });
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotRight - plotLeft, plotBottom - plotTop);
    ctx.clip();

    ctx.beginPath();
    ctx.moveTo(points[0].x, plotBottom);
    for (const point of points) ctx.lineTo(point.x, point.y);
    ctx.lineTo(points[points.length - 1].x, plotBottom);
    ctx.closePath();

    const fill = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
    fill.addColorStop(0, 'rgba(0, 212, 255, 0.20)');
    fill.addColorStop(0.55, 'rgba(124, 58, 237, 0.10)');
    fill.addColorStop(1, 'rgba(236, 72, 153, 0.02)');
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Fill a semi-transparent area = (measurement − target) offset to 0 dB.
   * Positive delta above zero is tinted red (too hot); negative below is blue
   * (too dark). Clipped to the plot area.
   */
  _drawDeltaBand(ctx, measDrawn, targetDrawn, plotLeft, plotRight) {
    if (!measDrawn || !targetDrawn) return;

    // Resample target onto measurement freq grid with log-frequency interpolation.
    const tFreq = targetDrawn.freq;
    const tSpl  = targetDrawn.spl;
    const mFreq = measDrawn.freq;
    const mSpl  = measDrawn.spl;
    const n     = mFreq.length;
    const delta = new Float32Array(n);
    let ti = 0;
    for (let i = 0; i < n; i++) {
      const f = mFreq[i];
      while (ti + 1 < tFreq.length && tFreq[ti + 1] <= f) ti++;
      const a = tFreq[ti], b = tFreq[Math.min(ti + 1, tFreq.length - 1)];
      const t = (b === a) ? 0 : Math.log(f / a) / Math.log(b / a);
      const tInterp = tSpl[ti] + (tSpl[Math.min(ti + 1, tSpl.length - 1)] - tSpl[ti]) * Math.max(0, Math.min(1, t));
      delta[i] = mSpl[i] - tInterp;
    }

    const zeroY = this.dbToY(0);

    // Positive (measurement > target) — red tint
    const drawSignedArea = (sign, fillStyle, strokeStyle) => {
      ctx.save();
      ctx.fillStyle = fillStyle;
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1;
      for (let i = 0; i < n - 1; i++) {
        const d0 = delta[i];
        const d1 = delta[i + 1];
        if (Math.sign(d0 || d1) !== sign && Math.sign(d1 || d0) !== sign) continue;
        const x0 = this.freqToX(mFreq[i]);
        const x1 = this.freqToX(mFreq[i + 1]);
        if (x1 < plotLeft || x0 > plotRight) continue;
        const y0 = this.dbToY(sign > 0 ? Math.max(0, d0) : Math.min(0, d0));
        const y1 = this.dbToY(sign > 0 ? Math.max(0, d1) : Math.min(0, d1));
        ctx.beginPath();
        ctx.moveTo(x0, zeroY);
        ctx.lineTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x1, zeroY);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.restore();
    };

    drawSignedArea(1, 'rgba(239, 68, 68, 0.18)', 'rgba(239, 68, 68, 0.55)');
    drawSignedArea(-1, 'rgba(59, 130, 246, 0.16)', 'rgba(59, 130, 246, 0.5)');

    // Dashed reference line at delta = 0
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(234, 179, 8, 0.6)';
    ctx.lineWidth = 1;
    ctx.moveTo(plotLeft, zeroY);
    ctx.lineTo(plotRight, zeroY);
    ctx.stroke();
    ctx.restore();
  }

  _drawNodes(ctx) {
    for (const filter of this.filters) {
      if (!filter.enabled || !filter.frequency) continue;

      const x = this.freqToX(filter.frequency);
      const dbAtFreq = this._calcFilterResponse(filter, filter.frequency) + (this.curveOffsets.eq || 0);
      const y = this.dbToY(dbAtFreq);
      const isHovered = this.hoveredFilter === filter;
      const isDragged = this.dragFilter === filter;

      const radius = isDragged ? 9 : isHovered ? 8 : 6;

      // Glow
      if (isHovered || isDragged) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 8, 0, Math.PI * 2);
        ctx.fillStyle = (filter.color || '#00d4ff').replace(')', ', 0.15)').replace('hsl', 'hsla').replace('rgb', 'rgba');
        ctx.fill();
      }

      // Outer ring
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = this._theme().nodeFill;
      ctx.fill();
      ctx.strokeStyle = filter.color || '#00d4ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner dot
      ctx.beginPath();
      ctx.arc(x, y, radius - 3, 0, Math.PI * 2);
      ctx.fillStyle = filter.color || '#00d4ff';
      ctx.fill();

      // Label
      if (isHovered || isDragged) {
        ctx.font = '10px JetBrains Mono';
        ctx.fillStyle = filter.color || '#00d4ff';
        ctx.textAlign = 'center';
        const label = `${filter.type} ${formatFreq(filter.frequency)}`;
        ctx.fillText(label, x, y - radius - 8);
      }
    }
  }

  // Mouse handlers
  _onMouseMove(e) {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.mousePos = { x, y };

    if (this.isPanning) {
      this._panViewTo(x, y);
      this._hideTooltip();
      return;
    }

    if (this.dragFilter) {
      // Drag filter node
      const freq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, this.xToFreq(x)));
      const gain = Math.max(this.dbRange.min, Math.min(this.dbRange.max, this.yToDb(y)));

      this.dragFilter.frequency = Math.round(freq * 10) / 10;
      if (this.dragFilter.gain !== null && this.dragFilter.gain !== undefined) {
        this.dragFilter.gain = Math.round(gain * 10) / 10;
      }

      if (this.onFilterChange) this.onFilterChange(this.dragFilter);
      this.render();

      // Update tooltip
      this._showTooltip(x, y, this.dragFilter.frequency, gain);
      return;
    }

    // Check hover
    const found = this._findFilterAt(x, y, 14);

    if (found !== this.hoveredFilter) {
      this.hoveredFilter = found;
      this.overlay.style.cursor = found ? 'grab' : (this._isInsidePlot(x, y) ? 'move' : 'crosshair');
      this.render();
    } else if (!found) {
      this.overlay.style.cursor = this._isInsidePlot(x, y) ? 'move' : 'crosshair';
    }

    // Tooltip for cursor position
    if (!found && this._isInsidePlot(x, y)) {
      const freq = this.xToFreq(x);
      const db = this.yToDb(y);
      if (freq >= MIN_FREQ && freq <= MAX_FREQ) {
        this._showTooltip(x, y, freq, db);
      } else {
        this._hideTooltip();
      }
    } else if (found) {
      this._showTooltip(
        this.freqToX(found.frequency),
        this.dbToY(this._calcFilterResponse(found, found.frequency) + (this.curveOffsets.eq || 0)),
        found.frequency,
        found.gain || 0
      );
    } else {
      this._hideTooltip();
    }
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.hoveredFilter) {
      this.dragFilter = this.hoveredFilter;
      this.overlay.style.cursor = 'grabbing';
      if (this.onFilterSelect) this.onFilterSelect(this.dragFilter);
      return;
    }

    if (this._isInsidePlot(x, y)) {
      this.isPanning = true;
      this.panStart = {
        x,
        y,
        freqRange: { ...this._getFreqView() },
        dbRange: { ...this.dbRange },
      };
      this.overlay.style.cursor = 'grabbing';
      e.preventDefault();
    }
  }

  _onMouseUp(e) {
    if (this.dragFilter) {
      if (this.onFilterChange) this.onFilterChange(this.dragFilter);
    }
    this.dragFilter = null;
    this.isPanning = false;
    this.panStart = null;
    this.overlay.style.cursor = this.hoveredFilter ? 'grab' : (this._isInsidePlot(this.mousePos.x, this.mousePos.y) ? 'move' : 'crosshair');
  }

  _onMouseLeave(e) {
    this.hoveredFilter = null;
    this.dragFilter = null;
    this.isPanning = false;
    this.panStart = null;
    this.overlay.style.cursor = 'crosshair';
    this._hideTooltip();
    this.render();
  }

  _onWheel(e) {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!this._isInsidePlot(x, y)) return;

    e.preventDefault();
    const qTarget = this.hoveredFilter || this._findFilterAt(x, y, 18);
    if (qTarget && this._filterSupportsQ(qTarget) && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) {
      this._adjustFilterQ(qTarget, e.deltaY, e.shiftKey);
      return;
    }

    const factor = Math.exp(Math.sign(e.deltaY || 1) * 0.18);
    if (e.ctrlKey || e.altKey) {
      this._zoomDbAt(y, factor);
    } else {
      this._zoomFrequencyAt(x, factor);
    }
    this.render();
  }

  _onDoubleClick(e) {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!this.hoveredFilter && this._isInsidePlot(x, y)) this.resetView();
  }

  _onContextMenu(e) {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const filter = this.hoveredFilter || this._findFilterAt(x, y, 18);
    if (!filter) return;
    e.preventDefault();
    if (this.onFilterDelete) this.onFilterDelete(filter);
  }

  _findFilterAt(x, y, radius = 14) {
    if (!this.curveVisibility.eq) return null;
    for (const filter of this.filters) {
      if (!filter.enabled || !filter.frequency) continue;
      const fx = this.freqToX(filter.frequency);
      const fy = this.dbToY(this._calcFilterResponse(filter, filter.frequency) + (this.curveOffsets.eq || 0));
      const dist = Math.sqrt((x - fx) ** 2 + (y - fy) ** 2);
      if (dist < radius) return filter;
    }
    return null;
  }

  _filterSupportsQ(filter) {
    if (!filter || filter.q === null || filter.q === undefined) return false;
    return !['LP', 'HP', 'LS 6dB', 'LS 12dB', 'HS 6dB', 'HS 12dB', 'IIR'].includes(filter.type);
  }

  _adjustFilterQ(filter, deltaY, fine = false) {
    const current = Number.isFinite(Number(filter.q)) ? Number(filter.q) : 0.707;
    const step = fine ? 1.045 : 1.085;
    const direction = deltaY < 0 ? 1 : -1;
    const next = Math.max(0.01, Math.min(100, current * Math.pow(step, direction)));
    filter.q = Number(next.toFixed(3));
    if (this.onFilterSelect) this.onFilterSelect(filter);
    if (this.onFilterChange) this.onFilterChange(filter);

    const x = this.freqToX(filter.frequency);
    const y = this.dbToY(this._calcFilterResponse(filter, filter.frequency) + (this.curveOffsets.eq || 0));
    this._showTooltip(x, y, filter.frequency, filter.gain || 0, `Q ${filter.q.toFixed(3)}`);
    this.render();
  }

  _panViewTo(x, y) {
    if (!this.panStart) return;
    const plotW = Math.max(1, this.width - this.padding.left - this.padding.right);
    const plotH = Math.max(1, this.height - this.padding.top - this.padding.bottom);
    const dx = x - this.panStart.x;
    const dy = y - this.panStart.y;

    const startMinLog = Math.log10(this.panStart.freqRange.min);
    const startMaxLog = Math.log10(this.panStart.freqRange.max);
    const logSpan = startMaxLog - startMinLog;
    const logShift = -(dx / plotW) * logSpan;
    this._setFreqView(Math.pow(10, startMinLog + logShift), Math.pow(10, startMaxLog + logShift));

    const dbSpan = this.panStart.dbRange.max - this.panStart.dbRange.min;
    const dbShift = (dy / plotH) * dbSpan;
    this._setDbView(this.panStart.dbRange.min + dbShift, this.panStart.dbRange.max + dbShift);
    this.render();
  }

  _zoomFrequencyAt(x, factor) {
    const range = this._getFreqView();
    const anchor = Math.log10(this.xToFreq(x));
    const minLog = Math.log10(range.min);
    const maxLog = Math.log10(range.max);
    this._setFreqView(
      Math.pow(10, anchor + (minLog - anchor) * factor),
      Math.pow(10, anchor + (maxLog - anchor) * factor),
    );
  }

  _zoomDbAt(y, factor) {
    const anchor = this.yToDb(y);
    this._setDbView(
      anchor + (this.dbRange.min - anchor) * factor,
      anchor + (this.dbRange.max - anchor) * factor,
    );
  }

  _showTooltip(x, y, freq, db, extraText = null) {
    if (!this.tooltip) return;
    this.tooltip.style.display = 'flex';
    this.tooltip.style.left = (x + 16) + 'px';
    this.tooltip.style.top = (y - 30) + 'px';
    this.tooltip.querySelector('.tooltip-freq').textContent = formatFreq(freq);
    this.tooltip.querySelector('.tooltip-gain').textContent = extraText || `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  }

  _hideTooltip() {
    if (this.tooltip) this.tooltip.style.display = 'none';
  }

  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
  }
}

function formatFreq(f) {
  if (f >= 1000) return (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz';
  return Math.round(f) + ' Hz';
}

function formatAxisFreq(f) {
  if (f >= 1000) {
    const khz = f / 1000;
    return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)}k`;
  }
  return f >= 100 ? Math.round(f).toString() : Number(f.toFixed(1)).toString();
}

function formatAxisDb(db) {
  const rounded = Math.abs(db) < 0.001 ? 0 : db;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${rounded > 0 ? '+' : ''}${text}`;
}
