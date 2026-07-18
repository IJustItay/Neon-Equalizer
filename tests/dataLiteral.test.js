import { describe, it, expect } from 'vitest';
import { parseDataLiteral } from '../src/utils/dataLiteral.js';

describe('parseDataLiteral', () => {
  it('parses the shapes real squig reviewer configs use', () => {
    const text = `[
      // Standard group
      { type: "Neutral", files: ["Harman IE 2019", 'Diffuse Field'] },
      {
        type: "∆ Preference", /* inline note */
        files: [
          { name: "Reviewer Target", file: "reviewer_target.txt" },
          { name: "5128 DF", file: "5128 DF Target" },
        ],
      },
    ]`;
    expect(parseDataLiteral(text)).toEqual([
      { type: 'Neutral', files: ['Harman IE 2019', 'Diffuse Field'] },
      {
        type: '∆ Preference',
        files: [
          { name: 'Reviewer Target', file: 'reviewer_target.txt' },
          { name: '5128 DF', file: '5128 DF Target' },
        ],
      },
    ]);
  });

  it('parses scalars, escapes, and string concatenation', () => {
    expect(parseDataLiteral('"a\\n\\"b\\u0041"')).toBe('a\n"bA');
    expect(parseDataLiteral('`tick`')).toBe('tick');
    expect(parseDataLiteral('"a" + "b" + "c"')).toBe('abc');
    expect(parseDataLiteral('-12.5e2')).toBe(-1250);
    expect(parseDataLiteral('0xFF')).toBe(255);
    expect(parseDataLiteral('true')).toBe(true);
    expect(parseDataLiteral('null')).toBe(null);
    expect(parseDataLiteral('[1,,2,]')).toEqual([1, 2]);
  });

  it.each([
    ['bare identifier', '[alert]'],
    ['call expression', '[alert(1)]'],
    ['member access', '[window.location]'],
    ['constructor access', '[{}.constructor]'],
    ['arrow function', '[() => 1]'],
    ['function expression', '[function () {}]'],
    ['new expression', '[new Date()]'],
    ['template interpolation', '[`${location}`]'],
    ['computed key', '[{ [key]: 1 }]'],
    ['object spread', '[{ ...window }]'],
    ['array spread', '[...document.scripts]'],
    ['shorthand property', '[{ foo }]'],
    ['method definition', '[{ foo() { return 1 } }]'],
    ['getter', '[{ get x() { return 1 } }]'],
    ['assignment', '[x = 1]'],
    ['arithmetic', '[1 + 2]'],
    ['comma expression trailer', '[1](2)'],
    ['keyword trailer', '[true.constructor]'],
    ['non-string concatenation', '["a" + window]'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseDataLiteral(text)).toThrow();
  });

  it('never executes embedded code', () => {
    globalThis.__pwned = false;
    try {
      expect(() => parseDataLiteral('[globalThis.__pwned = true]')).toThrow();
      expect(globalThis.__pwned).toBe(false);
    } finally {
      delete globalThis.__pwned;
    }
  });

  it('does not pollute prototypes via __proto__ keys', () => {
    const out = parseDataLiteral('{ "__proto__": { hacked: 1 }, ok: 2 }');
    expect(out.ok).toBe(2);
    expect({}.hacked).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('rejects oversized or overly nested input', () => {
    expect(() => parseDataLiteral('['.repeat(64) + ']'.repeat(64))).toThrow(/nested/);
    const big = `[${'1,'.repeat(200001)}]`;
    expect(() => parseDataLiteral(big)).toThrow(/large/);
  });

  it('rejects trailing content after the literal', () => {
    expect(() => parseDataLiteral('[1]; alert(1)')).toThrow(/trailing/);
  });
});
