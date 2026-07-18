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

describe('frequency parsing (issue #17)', () => {
  const freqOf = (token) =>
    parseConfig(`Filter: ON PK Fc ${token} Hz Gain 1 dB Q 1`).filters[0]?.frequency;

  it('treats a single dot as the decimal separator — never thousands', () => {
    expect(freqOf('20.000')).toBe(20);
    expect(freqOf('1000.000')).toBe(1000);
    expect(freqOf('20000.000')).toBe(20000);
    expect(freqOf('105.5')).toBe(105.5);
    expect(freqOf('20.5')).toBe(20.5);
  });

  it('parses decimal commas', () => {
    expect(freqOf('1234,5')).toBe(1234.5);
    expect(freqOf('2,5')).toBe(2.5);
  });

  it('parses unambiguous grouped-thousands forms', () => {
    expect(freqOf('1.234,5')).toBe(1234.5);
    expect(freqOf('1,234.5')).toBe(1234.5);
    expect(freqOf('1.000.000')).toBe(1000000);
    expect(freqOf('1,000,000')).toBe(1000000);
  });

  it('parses plain integers and scientific notation', () => {
    expect(freqOf('1000')).toBe(1000);
    expect(freqOf('1e3')).toBe(1000);
  });
});

describe('conditional blocks (issue #13)', () => {
  const COND = `If: device == L
Filter: ON PK Fc 1000 Hz Gain 6 dB Q 1
EndIf:
Filter: ON PK Fc 2000 Hz Gain -2 dB Q 1
`;

  it('keeps guarded filters inside their If/EndIf across save', () => {
    const out = serializeConfig(parseConfig(COND));
    const lines = out.split('\n');
    const ifIdx = lines.findIndex(l => l.startsWith('If:'));
    const guardedIdx = lines.findIndex(l => l.includes('Fc 1000'));
    const endIdx = lines.findIndex(l => l.startsWith('EndIf:'));
    expect(ifIdx).toBeGreaterThanOrEqual(0);
    expect(guardedIdx).toBeGreaterThan(ifIdx);
    expect(endIdx).toBeGreaterThan(guardedIdx);
    // The unguarded filter stays outside the block.
    const freeIdx = lines.findIndex(l => l.includes('Fc 2000'));
    expect(freeIdx).toBeGreaterThan(endIdx);
  });

  it('only exposes unguarded filters to the structured editor', () => {
    const parsed = parseConfig(COND);
    expect(parsed.filters).toHaveLength(1);
    expect(parsed.filters[0].frequency).toBe(2000);
    expect(parsed.conditionalBlocks).toHaveLength(1);
  });

  it('round-trips If/ElseIf/Else and nested blocks verbatim', () => {
    const text = `If: deviceName == "Speakers"
Filter: ON PK Fc 100 Hz Gain 3 dB Q 1
If: sampleRate == 48000
Delay: 5 ms
EndIf:
ElseIf: deviceName == "Headphones"
Filter: ON PK Fc 200 Hz Gain -3 dB Q 1
Else:
Preamp: -2 dB
EndIf:
`;
    const parsed = parseConfig(text);
    expect(parsed.conditionalBlocks).toHaveLength(1);
    const out = serializeConfig(parsed);
    for (const line of text.trim().split('\n')) {
      expect(out).toContain(line);
    }
    // Stable across a second cycle.
    const out2 = serializeConfig(parseConfig(out));
    expect(out2).toBe(out);
  });
});

describe('channel preservation (issue #14)', () => {
  it('round-trips C/LFE/surround channel groups', () => {
    const text = `Channel: C
Filter 1: ON PK Fc 500 Hz Gain 3 dB Q 1
Channel: LFE
Filter 2: ON PK Fc 60 Hz Gain 4 dB Q 1
Channel: SL SR
Filter 3: ON PK Fc 2000 Hz Gain -1 dB Q 1
Channel: L
Filter 4: ON PK Fc 1000 Hz Gain 1 dB Q 1
`;
    const parsed = parseConfig(text);
    expect(parsed.filters.map(f => f.channel)).toEqual(['C', 'LFE', 'SL SR', 'L']);

    const reparsed = parseConfig(serializeConfig(parsed));
    expect(reparsed.filters.map(f => f.channel)).toEqual(['C', 'LFE', 'SL SR', 'L']);
    expect(reparsed.filters.map(f => f.frequency)).toEqual([500, 60, 2000, 1000]);
  });

  it('canonicalizes case for known channel names', () => {
    const parsed = parseConfig('Channel: lfe\nFilter: ON PK Fc 60 Hz Gain 4 dB Q 1\n');
    expect(parsed.filters[0].channel).toBe('LFE');
  });
});

describe('comments and disabled includes (issue #22)', () => {
  it('preserves user comments and disabled Include directives', () => {
    const text = `Include: active.txt
# Include: disabled.txt
# important calibration note
Filter: ON PK Fc 1000 Hz Gain 1 dB Q 1
`;
    const parsed = parseConfig(text);
    expect(parsed.includes).toEqual([
      expect.objectContaining({ file: 'active.txt', enabled: true }),
      expect.objectContaining({ file: 'disabled.txt', enabled: false }),
    ]);
    expect(parsed.comments.map(c => c.text)).toEqual(['# important calibration note']);

    const out = serializeConfig(parsed);
    expect(out).toContain('Include: active.txt');
    expect(out).toContain('# Include: disabled.txt');
    expect(out).toContain('# important calibration note');

    // And it survives a second cycle without duplication.
    const out2 = serializeConfig(parseConfig(out));
    expect(out2.match(/# important calibration note/g)).toHaveLength(1);
    expect(out2.match(/# Include: disabled\.txt/g)).toHaveLength(1);
  });

  it('does not accumulate generated section headers across cycles', () => {
    const parsed = parseConfig('Filter: ON PK Fc 1000 Hz Gain 1 dB Q 1\n');
    const out = serializeConfig(parseConfig(serializeConfig(parsed)));
    expect(out.match(/# Parametric EQ Filters/g)).toHaveLength(1);
    expect(out.match(/# Equalizer APO Configuration/g)).toHaveLength(1);
  });
});
