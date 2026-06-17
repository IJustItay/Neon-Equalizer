import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config/parser.js';
import { serializeConfig } from '../src/config/serializer.js';

const SAMPLE = `# Equalizer APO Configuration
Preamp: -6.0 dB
Filter 1: ON PK Fc 1000 Hz Gain 3.0 dB Q 1.000
Filter 2: ON LSC Fc 105 Hz Gain 2.5 dB Q 0.700
Filter 3: ON HSC Fc 8000 Hz Gain -2.0 dB Q 0.700
`;

const pick = (f) => ({
  type: f.type,
  frequency: f.frequency,
  gain: f.gain,
  q: f.q,
});

describe('parser ↔ serializer round-trip', () => {
  it('preserves preamp and filters through parse → serialize → parse', () => {
    const first = parseConfig(SAMPLE);
    const second = parseConfig(serializeConfig(first));

    expect(second.preamp).toBeCloseTo(first.preamp, 3);
    expect(second.filters).toHaveLength(first.filters.length);

    first.filters.forEach((f, i) => {
      const g = second.filters[i];
      expect(g.type).toBe(f.type);
      expect(g.frequency).toBeCloseTo(f.frequency, 3);
      expect(g.gain).toBeCloseTo(f.gain, 3);
      expect(g.q).toBeCloseTo(f.q, 3);
    });
  });

  it('is idempotent (serialize is stable across a second cycle)', () => {
    const once = serializeConfig(parseConfig(SAMPLE));
    const twice = serializeConfig(parseConfig(once));
    expect(serializeConfig(parseConfig(twice))).toBe(twice);
  });

  it('round-trips per-channel (L/R) filter groups', () => {
    const text = `Preamp: 0.0 dB
Channel: L
Filter 1: ON PK Fc 500 Hz Gain 2.0 dB Q 1.000
Channel: R
Filter 2: ON PK Fc 500 Hz Gain -2.0 dB Q 1.000
`;
    const parsed = parseConfig(text);
    expect(parsed.filters.map(pick)).toEqual([
      { type: 'PK', frequency: 500, gain: 2, q: 1 },
      { type: 'PK', frequency: 500, gain: -2, q: 1 },
    ]);
    expect(parsed.filters[0].channel).toBe('L');
    expect(parsed.filters[1].channel).toBe('R');

    const reparsed = parseConfig(serializeConfig(parsed));
    expect(reparsed.filters[0].channel).toBe('L');
    expect(reparsed.filters[1].channel).toBe('R');
  });

  it('preserves graphic EQ bands', () => {
    const text = 'GraphicEQ: 20 -3.0; 1000 0.0; 20000 4.0\n';
    const parsed = parseConfig(text);
    expect(parsed.graphicEQ.bands).toHaveLength(3);
    const reparsed = parseConfig(serializeConfig(parsed));
    expect(reparsed.graphicEQ.bands.map(b => [b.frequency, b.gain])).toEqual([
      [20, -3], [1000, 0], [20000, 4],
    ]);
  });
});
