/**
 * AutoEQ Engine
 * Pure-JavaScript port of the Equalizer class from modernGraphTool
 * (https://github.com/IJustItay/modernGraphTool).
 *
 * The optimizer matches a measurement to a target by iteratively choosing
 * shelf + peaking biquad filters that minimize weighted RMS error, then
 * running coordinate-descent refinement and pruning ineffective bands.
 */

export class AutoEQEngine {
  constructor() {
    this.config = {
      DefaultSampleRate: 48000,
      AutoEQRange: [20, 16000],
      OptimizeQRange: [0.4, 4],
      OptimizeGainRange: [-16, 16],
      OptimizeDeltas: [
        [10, 10, 10, 5, 0.1, 0.5],
        [10, 10, 10, 2, 0.1, 0.2],
        [10, 10, 10, 1, 0.1, 0.1],
      ],
    };
  }

  // ── Biquad coefficient builders (RBJ cookbook) ────────────────
  _lowshelf(freq, q, gain) {
    freq = freq / this.config.DefaultSampleRate;
    freq = Math.max(1e-6, Math.min(freq, 1));
    q = Math.max(1e-4, Math.min(q, 1000));
    gain = Math.max(-40, Math.min(gain, 40));

    const w0 = 2 * Math.PI * freq;
    const sin = Math.sin(w0);
    const cos = Math.cos(w0);
    const a = Math.pow(10, gain / 40);
    const alpha = sin / (2 * q);
    const alphamod = (2 * Math.sqrt(a) * alpha) || 0;

    const a0 = ((a + 1) + (a - 1) * cos + alphamod);
    const a1 = -2 * ((a - 1) + (a + 1) * cos);
    const a2 = ((a + 1) + (a - 1) * cos - alphamod);
    const b0 = a * ((a + 1) - (a - 1) * cos + alphamod);
    const b1 = 2 * a * ((a - 1) - (a + 1) * cos);
    const b2 = a * ((a + 1) - (a - 1) * cos - alphamod);

    return [1.0, a1 / a0, a2 / a0, b0 / a0, b1 / a0, b2 / a0];
  }

  _highshelf(freq, q, gain) {
    freq = freq / this.config.DefaultSampleRate;
    freq = Math.max(1e-6, Math.min(freq, 1));
    q = Math.max(1e-4, Math.min(q, 1000));
    gain = Math.max(-40, Math.min(gain, 40));

    const w0 = 2 * Math.PI * freq;
    const sin = Math.sin(w0);
    const cos = Math.cos(w0);
    const a = Math.pow(10, gain / 40);
    const alpha = sin / (2 * q);
    const alphamod = (2 * Math.sqrt(a) * alpha) || 0;

    const a0 = ((a + 1) - (a - 1) * cos + alphamod);
    const a1 = 2 * ((a - 1) - (a + 1) * cos);
    const a2 = ((a + 1) - (a - 1) * cos - alphamod);
    const b0 = a * ((a + 1) + (a - 1) * cos + alphamod);
    const b1 = -2 * a * ((a - 1) + (a + 1) * cos);
    const b2 = a * ((a + 1) + (a - 1) * cos - alphamod);

    return [1.0, a1 / a0, a2 / a0, b0 / a0, b1 / a0, b2 / a0];
  }

  _peaking(freq, q, gain) {
    freq = freq / this.config.DefaultSampleRate;
    freq = Math.max(1e-6, Math.min(freq, 1));
    q = Math.max(1e-4, Math.min(q, 1000));
    gain = Math.max(-40, Math.min(gain, 40));

    const w0 = 2 * Math.PI * freq;
    const sin = Math.sin(w0);
    const cos = Math.cos(w0);
    const alpha = sin / (2 * q);
    const a = Math.pow(10, gain / 40);

    const a0 = 1 + alpha / a;
    const a1 = -2 * cos;
    const a2 = 1 - alpha / a;
    const b0 = 1 + alpha * a;
    const b1 = -2 * cos;
    const b2 = 1 - alpha * a;

    return [1.0, a1 / a0, a2 / a0, b0 / a0, b1 / a0, b2 / a0];
  }

  _filtersToCoeffs(filters) {
    return filters.map(f => {
      if (!f.freq || f.gain === undefined || f.gain === null || !f.q) return null;
      if (f.type === 'LSQ') return this._lowshelf(f.freq, f.q, f.gain);
      if (f.type === 'HSQ') return this._highshelf(f.freq, f.q, f.gain);
      if (f.type === 'PK') return this._peaking(f.freq, f.q, f.gain);
      return null;
    }).filter(f => f);
  }

  _calculateGains(freqs, coeffs) {
    const gains = new Array(freqs.length).fill(0);
    for (let i = 0; i < coeffs.length; ++i) {
      const [a0, a1, a2, b0, b1, b2] = coeffs[i];
      for (let j = 0; j < freqs.length; ++j) {
        const w = 2 * Math.PI * freqs[j] / this.config.DefaultSampleRate;
        const phi = 4 * Math.pow(Math.sin(w / 2), 2);
        const c = (
          10 * Math.log10(Math.pow(b0 + b1 + b2, 2) +
            (b0 * b2 * phi - (b1 * (b0 + b2) + 4 * b0 * b2)) * phi) -
          10 * Math.log10(Math.pow(a0 + a1 + a2, 2) +
            (a0 * a2 * phi - (a1 * (a0 + a2) + 4 * a0 * a2)) * phi));
        gains[j] += c;
      }
    }
    return gains;
  }

  applyFilters(fr, filters) {
    const freqs = fr.map(p => p[0]);
    const coeffs = this._filtersToCoeffs(filters);
    const gains = this._calculateGains(freqs, coeffs);
    return freqs.map((f, i) => [f, fr[i][1] + gains[i]]);
  }

  // ── Interpolation ─────────────────────────────────────────────
  _interpolate(fv, fr) {
    let i = 0;
    return fv.map(f => {
      for (; i < fr.length - 1; ++i) {
        const [f0, v0] = fr[i];
        const [f1, v1] = fr[i + 1];
        if (i === 0 && f < f0) return [f, v0];
        if (f >= f0 && f < f1) {
          const v = v0 + (v1 - v0) * (f - f0) / (f1 - f0);
          return [f, v];
        }
      }
      return [f, fr[fr.length - 1][1]];
    });
  }

  _interpolatePoints(freqs, points) {
    if (!points || points.length === 0) return freqs.map(f => [f, 0]);
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    return freqs.map(f => {
      let i = 0;
      while (i < sorted.length - 1 && sorted[i + 1][0] < f) i++;
      if (i >= sorted.length - 1) return [f, sorted[sorted.length - 1][1]];
      if (i < 0 || f <= sorted[0][0]) return [f, sorted[0][1]];
      const [f0, v0] = sorted[i];
      const [f1, v1] = sorted[i + 1];
      const ratio = Math.log(f / f0) / Math.log(f1 / f0);
      return [f, v0 + ratio * (v1 - v0)];
    });
  }

  _median(values) {
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return NaN;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  }

  _smoothLogPoints(points, fraction = 12) {
    if (!points?.length || !fraction) return points;
    const halfWindowOctaves = 0.5 / Math.max(1, fraction);
    return points.map(([freq, spl]) => {
      let weighted = 0;
      let weightSum = 0;
      for (const [f, value] of points) {
        const distance = Math.abs(Math.log2(f / freq));
        if (distance > halfWindowOctaves) continue;
        const weight = 1 - (distance / halfWindowOctaves);
        weighted += value * weight;
        weightSum += weight;
      }
      return [freq, weightSum > 0 ? weighted / weightSum : spl];
    });
  }

  _targetAlignmentOffset(source, target, frequencies, options = {}) {
    const requestedMode = options.normalizationMode || options.normalization || 'ref';
    const mode = requestedMode === 'demean' ? 'midband' : requestedMode;

    if (mode === 'midband') {
      const [lo, hi] = options.alignmentRange || [300, 3000];
      const deltas = [];
      for (let i = 0; i < frequencies.length; i++) {
        const f = frequencies[i];
        if (f < lo || f > hi) continue;
        const delta = source[i]?.[1] - target[i]?.[1];
        if (Number.isFinite(delta)) deltas.push(delta);
      }
      const offset = this._median(deltas);
      if (Number.isFinite(offset)) {
        return {
          offset,
          mode: 'midband',
          range: [lo, hi],
          pointCount: deltas.length,
        };
      }
    }

    const refFreq = Math.max(20, Math.min(20000, options.referenceFreq || 1000));
    let refIdx = frequencies.findIndex(f => f >= refFreq);
    if (refIdx < 0) refIdx = frequencies.length - 1;
    const offset = source[refIdx][1] - target[refIdx][1];
    return {
      offset: Number.isFinite(offset) ? offset : 0,
      mode: 'ref',
      referenceFreq: frequencies[refIdx],
      pointCount: 1,
    };
  }

  _normalizeResolution(source, target, options = {}) {
    const frequencies = [20];
    const step = Math.pow(2, 1 / 48);
    while (frequencies[frequencies.length - 1] < 20000) {
      frequencies.push(frequencies[frequencies.length - 1] * step);
    }
    let normalizedSource = this._interpolatePoints(frequencies, source);
    let normalizedTarget = this._interpolatePoints(frequencies, target);
    if (options.smooth !== false) {
      const fraction = options.smoothingFraction || 12;
      normalizedSource = this._smoothLogPoints(normalizedSource, fraction);
      normalizedTarget = this._smoothLogPoints(normalizedTarget, fraction);
    }

    const alignment = this._targetAlignmentOffset(
      normalizedSource,
      normalizedTarget,
      frequencies,
      options
    );
    this.lastAlignment = alignment;
    const alignedTarget = normalizedTarget.map(p => [p[0], p[1] + alignment.offset]);
    return { source: normalizedSource, target: alignedTarget };
  }

  // ── Error metrics & candidate search ──────────────────────────
  _calculateDistance(fr1, fr2) {
    let d = 0;
    for (let i = 0; i < fr1.length; ++i) {
      const a = Math.abs(fr1[i][1] - fr2[i][1]);
      d += (a >= 0.1 ? a : 0);
    }
    return d / fr1.length;
  }

  _calculateWeightedError(fr1, fr2) {
    let err = 0;
    for (let i = 0; i < fr1.length; ++i) {
      const diff = Math.abs(fr1[i][1] - fr2[i][1]);
      err += diff * diff;
    }
    return Math.sqrt(err / fr1.length);
  }

  _searchCandidates(fr, frTarget, threshold) {
    let state = 0;
    let startIndex = -1;
    const candidates = [];
    const [minFreq, maxFreq] = this.config.AutoEQRange;

    for (let i = 0; i < fr.length; ++i) {
      const [f, v0] = fr[i];
      const v1 = frTarget[i][1];
      const delta = v0 - v1;
      const deltaAbs = Math.abs(delta);
      const nextState = (deltaAbs < threshold) ? 0 : (delta / deltaAbs);
      if (nextState === state) continue;

      if (startIndex >= 0) {
        if (state !== 0) {
          const start = fr[startIndex][0];
          const end = f;
          const center = Math.sqrt(start * end);
          const gain = (
            this._interpolate([center], frTarget.slice(startIndex, i))[0][1] -
            this._interpolate([center], fr.slice(startIndex, i))[0][1]);
          const q = center / (end - start);
          if (center >= minFreq && center <= maxFreq) {
            candidates.push({ type: 'PK', freq: center, q, gain });
          }
        }
        startIndex = -1;
      } else {
        startIndex = i;
      }
      state = nextState;
    }
    return candidates;
  }

  _scoreCandidates(fr, frTarget, candidates) {
    const originalError = this._calculateWeightedError(fr, frTarget);
    return candidates.map(c => {
      const newFR = this.applyFilters(fr, [c]);
      const newError = this._calculateWeightedError(newFR, frTarget);
      return { ...c, score: originalError - newError };
    }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  }

  // ── Shelf analysis & optimization ─────────────────────────────
  _analyzeShelfOpportunities(fr, frTarget) {
    const [minFreq, maxFreq] = this.config.AutoEQRange;
    const shelves = [];

    const lowFr = fr.filter(p => p[0] >= minFreq && p[0] <= 200);
    const lowTg = frTarget.filter(p => p[0] >= minFreq && p[0] <= 200);
    if (lowFr.length && lowTg.length) {
      let sum = 0;
      for (let i = 0; i < lowFr.length; i++) sum += lowTg[i][1] - lowFr[i][1];
      const avg = sum / lowFr.length;
      if (Math.abs(avg) > 1.5) {
        let shelfFreq = 100;
        for (let i = lowFr.length - 1; i >= 0; i--) {
          const delta = lowTg[i][1] - lowFr[i][1];
          if (Math.sign(delta) === Math.sign(avg) && Math.abs(delta) > 1) shelfFreq = lowFr[i][0];
          else break;
        }
        shelves.push({ type: 'LSQ', freq: Math.max(shelfFreq, 50), q: 0.7, gain: avg });
      }
    }

    const hiFr = fr.filter(p => p[0] >= 8000 && p[0] <= maxFreq);
    const hiTg = frTarget.filter(p => p[0] >= 8000 && p[0] <= maxFreq);
    if (hiFr.length && hiTg.length) {
      let sum = 0;
      for (let i = 0; i < hiFr.length; i++) sum += hiTg[i][1] - hiFr[i][1];
      const avg = sum / hiFr.length;
      if (Math.abs(avg) > 1.5) {
        let shelfFreq = 8000;
        for (let i = 0; i < hiFr.length; i++) {
          const delta = hiTg[i][1] - hiFr[i][1];
          if (Math.sign(delta) === Math.sign(avg) && Math.abs(delta) > 1) { shelfFreq = hiFr[i][0]; break; }
        }
        shelves.push({ type: 'HSQ', freq: Math.min(shelfFreq, 12000), q: 0.7, gain: avg });
      }
    }
    return shelves;
  }

  _optimizeShelfFilter(fr, frTarget, filter) {
    const isLow = filter.type === 'LSQ';
    const [minGain, maxGain] = this.config.OptimizeGainRange;
    let best = { ...filter };
    let bestErr = this._calculateWeightedError(this.applyFilters(fr, [filter]), frTarget);

    const freqSteps = isLow
      ? [30, 50, 70, 100, 120, 150, 200, 250, 300]
      : [4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000];
    const qSteps = [0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5];

    for (const freq of freqSteps) {
      for (const q of qSteps) {
        let lo = minGain, hi = maxGain;
        while (hi - lo > 0.2) {
          const mid = (lo + hi) / 2;
          const t1 = { type: filter.type, freq, q, gain: mid - 0.5 };
          const t2 = { type: filter.type, freq, q, gain: mid + 0.5 };
          const e1 = this._calculateWeightedError(this.applyFilters(fr, [t1]), frTarget);
          const e2 = this._calculateWeightedError(this.applyFilters(fr, [t2]), frTarget);
          if (e1 < e2) hi = mid; else lo = mid;
        }
        const gain = (lo + hi) / 2;
        const test = { type: filter.type, freq, q, gain };
        const err = this._calculateWeightedError(this.applyFilters(fr, [test]), frTarget);
        if (err < bestErr) { best = test; bestErr = err; }
      }
    }
    return best;
  }

  // ── Coordinate-descent refinement ─────────────────────────────
  _freqUnit(freq) {
    if (freq < 100) return 1;
    if (freq < 1000) return 10;
    if (freq < 10000) return 100;
    return 1000;
  }

  _stripFilters(filters) {
    const [minQ, maxQ] = this.config.OptimizeQRange;
    const [minGain, maxGain] = this.config.OptimizeGainRange;
    return filters.map(f => ({
      type: f.type,
      freq: Math.floor(f.freq - f.freq % this._freqUnit(f.freq)),
      q: Math.min(Math.max(f.q, minQ), maxQ),
      gain: Math.min(Math.max(f.gain, minGain), maxGain)
    }));
  }

  _optimize(fr, frTarget, filters, iteration, dir = false) {
    filters = this._stripFilters(filters);
    const [minFreq, maxFreq] = this.config.AutoEQRange;
    const [minQ, maxQ] = this.config.OptimizeQRange;
    const [minGain, maxGain] = this.config.OptimizeGainRange;
    const [maxDF, maxDQ, maxDG, stepDF, stepDQ, stepDG] = this.config.OptimizeDeltas[iteration];
    const [begin, end, step] = dir ? [filters.length - 1, -1, -1] : [0, filters.length, 1];

    for (let i = begin; i !== end; i += step) {
      let f = filters[i];
      const fr1 = this.applyFilters(fr, filters.filter((_, fi) => fi !== i));
      let bestFilter = f;
      let bestDistance = this._calculateDistance(this.applyFilters(fr1, [f]), frTarget);

      const isShelf = f.type === 'LSQ' || f.type === 'HSQ';
      const effMinFreq = isShelf ? (f.type === 'LSQ' ? 20 : 4000) : minFreq;
      const effMaxFreq = isShelf ? (f.type === 'LSQ' ? 400 : 16000) : maxFreq;
      const effMinQ = isShelf ? 0.3 : minQ;
      const effMaxQ = isShelf ? 1.5 : maxQ;

      const testNewFilter = (df, dq, dg) => {
        const freq = f.freq + df * this._freqUnit(f.freq) * stepDF;
        const q = f.q + dq * stepDQ;
        const gain = f.gain + dg * stepDG;
        if (freq < effMinFreq || freq > effMaxFreq ||
            q < effMinQ || q > effMaxQ ||
            gain < minGain || gain > maxGain) return false;
        const nf = { type: f.type, freq, q, gain };
        const newFR = this.applyFilters(fr1, [nf]);
        const newDist = this._calculateDistance(newFR, frTarget);
        if (newDist < bestDistance) {
          bestFilter = nf;
          bestDistance = newDist;
          return true;
        }
        return false;
      };

      let improved = true;
      let iterCount = 0;
      while (improved && iterCount < 50) {
        improved = false;
        iterCount++;
        for (let df = -maxDF; df <= maxDF && !improved; df++) {
          if (df !== 0 && testNewFilter(df, 0, 0)) { f = bestFilter; improved = true; }
        }
        for (let dq = -maxDQ; dq <= maxDQ && !improved; dq++) {
          if (dq !== 0 && testNewFilter(0, dq, 0)) { f = bestFilter; improved = true; }
        }
        for (let dg = -maxDG; dg <= maxDG && !improved; dg++) {
          if (dg !== 0 && testNewFilter(0, 0, dg)) { f = bestFilter; improved = true; }
        }
      }

      for (let df = -maxDF; df <= maxDF; ++df) {
        for (let dq = maxDQ; dq >= -maxDQ; --dq) {
          for (let dg = 0; dg <= maxDG; ++dg) {
            if (!testNewFilter(df, dq, dg)) break;
          }
          for (let dg = 0; dg >= -maxDG; --dg) {
            if (!testNewFilter(df, dq, dg)) break;
          }
        }
      }
      filters[i] = bestFilter;
    }
    return filters.sort((a, b) => a.freq - b.freq);
  }

  _iterativeBatchOptimization(fr, frTarget, initialFilters, maxFilters) {
    let filters = [...initialFilters];
    let currentFR = this.applyFilters(fr, filters);

    while (filters.length < maxFilters) {
      const candidates = this._searchCandidates(currentFR, frTarget, 0.3);
      if (!candidates.length) break;
      const scored = this._scoreCandidates(currentFR, frTarget, candidates);
      if (!scored.length) break;

      const best = scored[0];
      filters.push({ type: best.type, freq: best.freq, q: best.q, gain: best.gain });

      for (let i = 0; i < this.config.OptimizeDeltas.length; i++) {
        filters = this._optimize(fr, frTarget, filters, i);
        filters = this._optimize(fr, frTarget, filters, i, true);
      }
      currentFR = this.applyFilters(fr, filters);
      if (this._calculateWeightedError(currentFR, frTarget) < 0.5) break;
    }
    return filters;
  }

  _pruneIneffectiveFilters(fr, frTarget, filters) {
    const baseline = this._calculateWeightedError(this.applyFilters(fr, filters), frTarget);
    return filters.filter((filter, index) => {
      const without = filters.filter((_, i) => i !== index);
      const err = this._calculateWeightedError(this.applyFilters(fr, without), frTarget);
      return err - baseline > 0.1;
    });
  }

  _round(value, decimals = 1) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  /**
   * Run AutoEQ optimization.
   * @param {Array<[number,number]>} source Measurement points [freq, dB].
   * @param {Array<[number,number]>} target Target points [freq, dB].
   * @param {Object} options
   * @param {number} [options.maxFilters=8]
   * @param {[number,number]} [options.freqRange=[20,15000]]
   * @param {[number,number]} [options.qRange=[0.5,2]]
   * @param {[number,number]} [options.gainRange=[-12,12]]
   * @param {boolean} [options.useShelfFilter=true]
   * @param {boolean} [options.smooth=true]
   * @param {number} [options.smoothingFraction=12]
   * @param {'ref'|'midband'} [options.normalizationMode='ref']
   * @param {[number,number]} [options.alignmentRange=[300,3000]]
   * @returns {Array<{type:string,freq:number,q:number,gain:number}>}
   */
  autoEQ(source, target, options = {}) {
    const maxFilters = options.maxFilters || 8;
    const freqRange = options.freqRange || this.config.AutoEQRange;
    const qRange = options.qRange || this.config.OptimizeQRange;
    const gainRange = options.gainRange || this.config.OptimizeGainRange;
    const useShelfFilter = options.useShelfFilter !== false;

    this.config.AutoEQRange = freqRange;
    this.config.OptimizeQRange = qRange;
    this.config.OptimizeGainRange = gainRange;

    const { source: normSrc, target: normTgt } = this._normalizeResolution(source, target, options);
    const fr = normSrc.filter(p => p[0] >= freqRange[0] && p[0] <= freqRange[1]);
    const frTarget = normTgt.filter(p => p[0] >= freqRange[0] && p[0] <= freqRange[1]);

    const initialFilters = [];
    let remaining = maxFilters;

    if (useShelfFilter) {
      const shelves = this._analyzeShelfOpportunities(fr, frTarget);
      for (const shelf of shelves) {
        if (remaining <= 2) break;
        const opt = this._optimizeShelfFilter(fr, frTarget, shelf);
        const withShelf = this.applyFilters(fr, [...initialFilters, opt]);
        const without = this.applyFilters(fr, initialFilters);
        const improvement = this._calculateWeightedError(without, frTarget) -
                            this._calculateWeightedError(withShelf, frTarget);
        if (improvement > 0.3) {
          initialFilters.push(opt);
          remaining--;
        }
      }
    }

    let all = this._iterativeBatchOptimization(fr, frTarget, initialFilters, maxFilters);
    for (let i = 0; i < this.config.OptimizeDeltas.length; i++) {
      all = this._optimize(fr, frTarget, all, i);
      all = this._optimize(fr, frTarget, all, i, true);
    }
    all = this._pruneIneffectiveFilters(fr, frTarget, all);

    return all.map(f => ({
      type: f.type,
      freq: this._round(f.freq, 0),
      q: this._round(f.q, 2),
      gain: this._round(f.gain, 1),
    })).sort((a, b) => a.freq - b.freq);
  }

  /** Preamp value so filtered response never exceeds the original. */
  calculatePreamp(source, filters) {
    const out = this.applyFilters(source, filters);
    let maxGain = -Infinity;
    for (let i = 0; i < source.length; ++i) {
      maxGain = Math.max(maxGain, out[i][1] - source[i][1]);
    }
    return -maxGain;
  }
}

// ── App-format bridge ─────────────────────────────────────────
// App uses { type: 'PK'|'LS'|'HS', frequency, gain, q, enabled } etc.
// Engine uses { type: 'PK'|'LSQ'|'HSQ', freq, gain, q }.

/** Convert app-style {freq,spl}[] measurement into engine [freq,dB][] pairs. */
export function splToPoints(data) {
  if (!data || !data.freq) return [];
  return data.freq.map((f, i) => [f, data.spl[i]]);
}

const APP_TO_ENGINE_TYPE = { PK: 'PK', PEQ: 'PK', LS: 'LSQ', LSC: 'LSQ', HS: 'HSQ', HSC: 'HSQ' };
const ENGINE_TO_APP_TYPE = { PK: 'PK', LSQ: 'LS', HSQ: 'HS' };

export function engineFiltersToAppFilters(filters, colorsPalette) {
  const COLORS = colorsPalette || ['#00d4ff', '#7c3aed', '#ec4899', '#10b981', '#f59e0b', '#ef4444', '#60a5fa', '#a78bfa', '#34d399', '#fb923c', '#22d3ee', '#d946ef'];
  const now = Date.now();
  return filters.map((f, i) => ({
    id: `aeq_${now}_${i}`,
    enabled: true,
    type: ENGINE_TO_APP_TYPE[f.type] || 'PK',
    frequency: f.freq,
    gain: f.gain,
    q: f.q,
    isEffect: false,
    color: COLORS[i % COLORS.length],
    index: i,
  }));
}

export function appFiltersToEngineFilters(filters) {
  return (filters || [])
    .filter(f => f && f.enabled !== false && f.frequency)
    .map(f => ({
      type: APP_TO_ENGINE_TYPE[f.type] || 'PK',
      freq: f.frequency,
      q: f.q || 0.707,
      gain: f.gain || 0,
    }));
}

/**
 * Convenience top-level helper. Returns app-format filters plus preamp suggestion.
 * @param {{freq:number[], spl:number[]}} measurementData
 * @param {{freq:number[], spl:number[]}} targetData
 * @param {Object} options
 */
export function runAutoEQ(measurementData, targetData, options = {}) {
  const engine = new AutoEQEngine();
  const src = splToPoints(measurementData);
  const tgt = splToPoints(targetData);
  if (!src.length || !tgt.length) return { filters: [], preamp: 0 };

  const engineFilters = engine.autoEQ(src, tgt, options);
  const appFilters = engineFiltersToAppFilters(engineFilters);
  const preamp = engine.calculatePreamp(src, engineFilters);
  return { filters: appFilters, preamp, alignment: engine.lastAlignment || null };
}
