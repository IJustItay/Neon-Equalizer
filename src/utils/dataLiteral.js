/**
 * Data-only JavaScript literal parser.
 *
 * Parses the subset of JS syntax that squig.link / modernGraphTool reviewer
 * configs actually use for their `targets` arrays: strings, numbers, booleans,
 * null/undefined, arrays, and plain object literals (bare or quoted keys,
 * trailing commas, comments, string concatenation with `+`).
 *
 * Everything executable is rejected: identifiers as values, calls, member
 * access, computed keys, spreads, template interpolation, operators. This
 * replaces the old `Function(...)` evaluation, which was both a remote-code
 * hazard in dev and blocked by the production CSP (no 'unsafe-eval').
 */

const MAX_DEPTH = 32;
const MAX_NODES = 100000;

const KEYWORDS = new Map([
  ['true', true],
  ['false', false],
  ['null', null],
  ['undefined', undefined],
]);

class LiteralParser {
  constructor(text) {
    this.text = String(text);
    this.pos = 0;
    this.nodes = 0;
  }

  error(msg) {
    return new Error(`${msg} at position ${this.pos}`);
  }

  countNode() {
    if (++this.nodes > MAX_NODES) throw this.error('literal too large');
  }

  skipWs() {
    const t = this.text;
    while (this.pos < t.length) {
      const ch = t[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ') {
        this.pos++;
      } else if (ch === '/' && t[this.pos + 1] === '/') {
        const nl = t.indexOf('\n', this.pos);
        this.pos = nl === -1 ? t.length : nl + 1;
      } else if (ch === '/' && t[this.pos + 1] === '*') {
        const end = t.indexOf('*/', this.pos + 2);
        if (end === -1) throw this.error('unterminated comment');
        this.pos = end + 2;
      } else {
        break;
      }
    }
  }

  peek() {
    this.skipWs();
    return this.text[this.pos];
  }

  expect(ch) {
    if (this.peek() !== ch) throw this.error(`expected '${ch}'`);
    this.pos++;
  }

  parseString() {
    const t = this.text;
    const quote = t[this.pos];
    this.pos++;
    let out = '';
    while (this.pos < t.length) {
      const ch = t[this.pos];
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        const next = t[this.pos + 1];
        this.pos += 2;
        switch (next) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case '0': out += '\0'; break;
          case 'u': {
            const hex = t.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          case 'x': {
            const hex = t.slice(this.pos, this.pos + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw this.error('bad \\x escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 2;
            break;
          }
          case undefined: throw this.error('unterminated string');
          default: out += next;
        }
        continue;
      }
      if (quote === '`' && ch === '$' && t[this.pos + 1] === '{') {
        throw this.error('template interpolation not allowed');
      }
      if (quote !== '`' && (ch === '\n' || ch === '\r')) {
        throw this.error('unterminated string');
      }
      out += ch;
      this.pos++;
    }
    throw this.error('unterminated string');
  }

  parseNumber() {
    const re = /-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m) throw this.error('invalid number');
    this.pos = re.lastIndex;
    const num = Number(m[0]);
    if (!Number.isFinite(num)) throw this.error('non-finite number');
    return num;
  }

  parseIdentifier() {
    const re = /[A-Za-z_$][A-Za-z0-9_$]*/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m) throw this.error('expected identifier');
    this.pos = re.lastIndex;
    return m[0];
  }

  /** String literal, optionally followed by `+ <string>` concatenations. */
  parseStringExpr() {
    let out = this.parseString();
    while (this.peek() === '+') {
      this.pos++;
      const ch = this.peek();
      if (ch !== '"' && ch !== "'" && ch !== '`') {
        throw this.error('can only concatenate string literals');
      }
      out += this.parseString();
    }
    return out;
  }

  parseValue(depth) {
    if (depth > MAX_DEPTH) throw this.error('literal too deeply nested');
    this.countNode();
    const ch = this.peek();
    if (ch === undefined) throw this.error('unexpected end of input');

    if (ch === '[') return this.parseArray(depth);
    if (ch === '{') return this.parseObject(depth);
    if (ch === '"' || ch === "'" || ch === '`') return this.parseStringExpr();
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return this.parseNumber();

    if (/[A-Za-z_$]/.test(ch)) {
      const start = this.pos;
      const ident = this.parseIdentifier();
      if (KEYWORDS.has(ident)) {
        // `true.foo`, `null(…)` etc. would change meaning — reject any trailer.
        const trail = this.peek();
        if (trail === '.' || trail === '(' || trail === '[') {
          this.pos = start;
          throw this.error('expressions are not allowed');
        }
        return KEYWORDS.get(ident);
      }
      this.pos = start;
      throw this.error(`identifier '${ident}' is not allowed`);
    }

    throw this.error(`unexpected character '${ch}'`);
  }

  parseArray(depth) {
    this.expect('[');
    const out = [];
    for (;;) {
      let ch = this.peek();
      if (ch === ']') { this.pos++; return out; }
      if (ch === ',') { this.pos++; continue; }          // elisions / trailing commas
      if (ch === '.' && this.text.startsWith('...', this.pos)) {
        throw this.error('spread is not allowed');
      }
      out.push(this.parseValue(depth + 1));
      ch = this.peek();
      if (ch === ',') { this.pos++; continue; }
      if (ch === ']') { this.pos++; return out; }
      throw this.error("expected ',' or ']'");
    }
  }

  parseObject(depth) {
    this.expect('{');
    const out = {};
    for (;;) {
      let ch = this.peek();
      if (ch === '}') { this.pos++; return out; }
      if (ch === ',') { this.pos++; continue; }
      if (ch === '.' && this.text.startsWith('...', this.pos)) {
        throw this.error('spread is not allowed');
      }
      if (ch === '[') throw this.error('computed keys are not allowed');

      let key;
      if (ch === '"' || ch === "'" || ch === '`') key = this.parseString();
      else if (ch === '-' || (ch >= '0' && ch <= '9')) key = String(this.parseNumber());
      else key = this.parseIdentifier();

      // Reject shorthand ({foo}), methods ({foo(){}}), getters ({get x(){}}).
      this.expect(':');
      const value = this.parseValue(depth + 1);
      // Guard against prototype pollution of the result object.
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        out[key] = value;
      }
      ch = this.peek();
      if (ch === ',') { this.pos++; continue; }
      if (ch === '}') { this.pos++; return out; }
      throw this.error("expected ',' or '}'");
    }
  }
}

/**
 * Parse a pure-data JavaScript literal (array/object/string/number/…).
 * Throws on anything executable or otherwise outside the literal subset.
 */
export function parseDataLiteral(text) {
  const parser = new LiteralParser(text);
  const value = parser.parseValue(0);
  parser.skipWs();
  if (parser.pos < parser.text.length) {
    throw parser.error('unexpected trailing content');
  }
  return value;
}
