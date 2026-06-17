import { describe, it, expect } from 'vitest';
import {
  AutoEQEngine,
  runAutoEQ,
  splToPoints,
  appFiltersToEngineFilters,
} from '../src/components/autoEQEngine.js';

// Log-spaced frequency grid, 20 Hz → 20 kHz.
function logFreqs(n = 200) {
  const lo = Math.log10(20), hi = Math.log10(20000);
  return Array.from({ length: n }, (_, i) => 10 ** (lo + (hi - lo) * (i / (n - 1))));
}

// A measurement that's flat except a +6 dB Gaussian bump centered at 3 kHz.
function bumpyMeasurement() {
  const freq = logFreqs();
  const spl = freq.map((f) => {
    const d = Math.log2(f / 3000);
    return 6 * Math.exp(-(d * d) / (2 * 0.5 * 0.5));
  });
  return { freq, spl };
}

function flatTarget(freq) {
  return { freq, spl: freq.map(() => 0) };
}

function rmsError(points, target) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const d = points[i][1] - target[i][1];
    sum += d * d;
  }
  return Math.sqrt(sum / points.length);
}

describe('runAutoEQ', () => {
  it('produces filters that reduce the error toward the target', () => {
    const measurement = bumpyMeasurement();
    const target = flatTarget(measurement.freq);

    const { filters, preamp } = runAutoEQ(measurement, target, { maxFilters: 5 });
    expect(filters.length).toBeGreaterThan(0);
    expect(Number.isFinite(preamp)).toBe(true);

    const engine = new AutoEQEngine();
    const src = splToPoints(measurement);
    const tgt = splToPoints(target);
    const engineFilters = appFiltersToEngineFilters(filters);

    const before = rmsError(src, tgt);
    const after = rmsError(engine.applyFilters(src, engineFilters), tgt);

    // The bump (~6 dB) should be corrected to a fraction of its size.
    expect(after).toBeLessThan(before * 0.5);
  });

  it('targets a correction near the 3 kHz bump', () => {
    const measurement = bumpyMeasurement();
    const target = flatTarget(measurement.freq);
    const { filters } = runAutoEQ(measurement, target, { maxFilters: 5 });

    // At least one cut (negative gain) should land in the bump's octave.
    const nearBump = filters.filter(
      (f) => f.frequency >= 1500 && f.frequency <= 6000 && f.gain < 0
    );
    expect(nearBump.length).toBeGreaterThan(0);
  });

  it('returns empty result for empty input', () => {
    expect(runAutoEQ({ freq: [], spl: [] }, { freq: [], spl: [] })).toEqual({
      filters: [],
      preamp: 0,
    });
  });
});
