import { AutoEQEngine } from './autoEQEngine.js';

export const TARGET_ADJUSTMENT_DEFAULTS = Object.freeze({
  tilt: 0,
  bass: 0,
  treble: 0,
  earGain: 0,
});

export const TARGET_ADJUSTMENT_FILTERS = Object.freeze({
  bass: { type: 'LSQ', freq: 105, q: 0.707 },
  treble: { type: 'HSQ', freq: 2500, q: 0.42 },
  earGain: { type: 'PK', freq: 3500, q: 2.0 },
});

function cleanNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function normalizeTargetAdjustments(adjustments = {}) {
  return {
    tilt: cleanNumber(adjustments.tilt),
    bass: cleanNumber(adjustments.bass),
    treble: cleanNumber(adjustments.treble),
    earGain: cleanNumber(adjustments.earGain),
  };
}

export function isTargetAdjusted(adjustments = {}) {
  const next = normalizeTargetAdjustments(adjustments);
  return Math.abs(next.tilt) > 0.001 ||
    Math.abs(next.bass) > 0.001 ||
    Math.abs(next.treble) > 0.001 ||
    Math.abs(next.earGain) > 0.001;
}

export function formatTargetAdjustmentLabel(adjustments = {}) {
  const next = normalizeTargetAdjustments(adjustments);
  const parts = [];
  if (Math.abs(next.tilt) > 0.001) {
    parts.push(`Tilt: ${next.tilt >= 0 ? '+' : ''}${next.tilt.toFixed(1)}dB/oct`);
  }
  if (Math.abs(next.bass) > 0.001) {
    parts.push(`Bass: ${next.bass >= 0 ? '+' : ''}${next.bass.toFixed(1)}dB`);
  }
  if (Math.abs(next.treble) > 0.001) {
    parts.push(`Treble: ${next.treble >= 0 ? '+' : ''}${next.treble.toFixed(1)}dB`);
  }
  if (Math.abs(next.earGain) > 0.001) {
    parts.push(`Ear: ${next.earGain >= 0 ? '+' : ''}${next.earGain.toFixed(1)}dB`);
  }
  return parts.length ? parts.join(', ') : null;
}

export function applyTargetAdjustments(data, adjustments = {}) {
  if (!data?.freq?.length || !data?.spl?.length) return data;
  const next = normalizeTargetAdjustments(adjustments);
  let points = data.freq.map((freq, i) => [freq, data.spl[i]]);

  // ModernGraphTool target customizer applies tilt as dB/oct around 1 kHz.
  if (Math.abs(next.tilt) > 0.001) {
    points = points.map(([freq, spl]) => [
      freq,
      spl + next.tilt * Math.log2(Math.max(1e-6, freq) / 1000),
    ]);
  }

  const filters = [];
  if (Math.abs(next.bass) > 0.001) {
    filters.push({ ...TARGET_ADJUSTMENT_FILTERS.bass, gain: next.bass });
  }
  if (Math.abs(next.treble) > 0.001) {
    filters.push({ ...TARGET_ADJUSTMENT_FILTERS.treble, gain: next.treble });
  }
  if (Math.abs(next.earGain) > 0.001) {
    filters.push({ ...TARGET_ADJUSTMENT_FILTERS.earGain, gain: next.earGain });
  }
  if (filters.length) {
    points = new AutoEQEngine().applyFilters(points, filters);
  }

  return {
    freq: points.map(p => p[0]),
    spl: points.map(p => p[1]),
  };
}
