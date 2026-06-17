import { describe, it, expect } from 'vitest';
import {
  biquadCoeffs,
  magnitudeDb,
  filterGainDb,
  canonicalFilterFamily,
} from '../src/dsp/biquad.js';

const SR = 48000;
const dbAt = (filter, freq) => filterGainDb(filter, freq, SR);

describe('canonicalFilterFamily', () => {
  it('maps every alias to its biquad family', () => {
    expect(canonicalFilterFamily('PK')).toBe('peaking');
    expect(canonicalFilterFamily('PEQ')).toBe('peaking');
    expect(canonicalFilterFamily('Modal')).toBe('peaking');
    expect(canonicalFilterFamily('LS')).toBe('lowshelf');
    expect(canonicalFilterFamily('LSC')).toBe('lowshelf');
    expect(canonicalFilterFamily('LSQ')).toBe('lowshelf');
    expect(canonicalFilterFamily('HS')).toBe('highshelf');
    expect(canonicalFilterFamily('HSQ')).toBe('highshelf');
    expect(canonicalFilterFamily('BP')).toBe('bandpass');
  });

  it('returns null for unknown types', () => {
    expect(canonicalFilterFamily('IIR')).toBeNull();
    expect(canonicalFilterFamily('')).toBeNull();
    expect(canonicalFilterFamily(undefined)).toBeNull();
  });
});

describe('biquadCoeffs', () => {
  it('returns null without a valid type or frequency', () => {
    expect(biquadCoeffs({ type: 'PK', frequency: 0, gain: 3, q: 1 }, SR)).toBeNull();
    expect(biquadCoeffs({ type: 'IIR', frequency: 1000, gain: 3, q: 1 }, SR)).toBeNull();
  });

  it('normalizes to a0 = 1 (returns b0,b1,b2,a1,a2 only)', () => {
    const c = biquadCoeffs({ type: 'PK', frequency: 1000, gain: 6, q: 1 }, SR);
    expect(c).toHaveProperty('b0');
    expect(c).toHaveProperty('a1');
    expect(c).not.toHaveProperty('a0');
  });
});

describe('peaking filter magnitude', () => {
  it('equals the set gain at the center frequency', () => {
    expect(dbAt({ type: 'PK', frequency: 1000, gain: 6, q: 1, enabled: true }, 1000)).toBeCloseTo(6, 2);
    expect(dbAt({ type: 'PK', frequency: 3000, gain: -8, q: 2, enabled: true }, 3000)).toBeCloseTo(-8, 2);
  });

  it('decays toward 0 dB far from center', () => {
    const f = { type: 'PK', frequency: 1000, gain: 10, q: 3, enabled: true };
    expect(Math.abs(dbAt(f, 20))).toBeLessThan(0.5);
    expect(Math.abs(dbAt(f, 20000))).toBeLessThan(0.5);
  });
});

describe('shelf filter magnitude', () => {
  it('low shelf reaches full gain below the corner and ~0 above', () => {
    const ls = { type: 'LSC', frequency: 200, gain: 6, q: 0.7, enabled: true };
    expect(dbAt(ls, 20)).toBeCloseTo(6, 1);
    expect(Math.abs(dbAt(ls, 15000))).toBeLessThan(0.5);
  });

  it('high shelf reaches full gain above the corner and ~0 below', () => {
    const hs = { type: 'HSC', frequency: 6000, gain: -5, q: 0.7, enabled: true };
    expect(dbAt(hs, 19000)).toBeCloseTo(-5, 1);
    expect(Math.abs(dbAt(hs, 100))).toBeLessThan(0.5);
  });
});

describe('disabled filters', () => {
  it('contribute no gain', () => {
    expect(dbAt({ type: 'PK', frequency: 1000, gain: 6, q: 1, enabled: false }, 1000)).toBe(0);
  });
});

describe('magnitudeDb', () => {
  it('matches filterGainDb for the same filter', () => {
    const filter = { type: 'PK', frequency: 1000, gain: 4, q: 1.5 };
    const coeffs = biquadCoeffs(filter, SR);
    expect(magnitudeDb(coeffs, 1000, SR)).toBeCloseTo(filterGainDb(filter, 1000, SR), 6);
  });
});
