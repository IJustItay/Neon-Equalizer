import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as serial from '../src/components/devicePeq/connectors/serial.js';

/**
 * Mock Web Serial port (issue #15 regression tests).
 * `enqueue(text)` feeds device→host bytes; reads resolve in enqueue order and
 * otherwise stay pending forever — exactly like a silent CDC device.
 */
function makeFakePort({ usbVendorId = 0x152a } = {}) {
  const encoder = new TextEncoder();
  const chunkQueue = [];
  const waiters = [];
  let cancelled = false;

  const reader = {
    read() {
      if (cancelled) return Promise.resolve({ value: undefined, done: true });
      if (chunkQueue.length) return Promise.resolve(chunkQueue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    cancel() {
      cancelled = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
      return Promise.resolve();
    },
    releaseLock() {},
  };

  const written = [];
  const writer = {
    write(bytes) { written.push(new TextDecoder().decode(bytes)); return Promise.resolve(); },
    releaseLock() {},
  };

  const port = {
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getInfo: () => ({ usbVendorId }),
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
  };

  const enqueue = (text) => {
    const chunk = { value: encoder.encode(text), done: false };
    if (waiters.length) waiters.shift()(chunk);
    else chunkQueue.push(chunk);
  };

  const closeStream = () => {
    const chunk = { value: undefined, done: true };
    if (waiters.length) waiters.shift()(chunk);
    else chunkQueue.push(chunk);
  };

  return { port, enqueue, closeStream, written };
}

let fake;

beforeEach(async () => {
  fake = makeFakePort();
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { requestPort: () => Promise.resolve(fake.port) } },
    configurable: true,
  });
  await serial.connect();
});

afterEach(async () => {
  await serial.disconnect();
  delete globalThis.navigator;
});

describe('serial connector timeouts (issue #15)', () => {
  it('rejects instead of hanging when the device stays silent', async () => {
    const start = Date.now();
    await expect(serial.pull()).rejects.toThrow(/timeout/i);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('rejects on a partial line followed by silence', async () => {
    const p = serial.pull();
    fake.enqueue('{"FiiR": {"FiiR": {"Bands"');   // never completes the line
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it('skips banner/non-JSON lines and returns the JSON response', async () => {
    const p = serial.pull();
    fake.enqueue('JDS Labs Element IV ready\n');
    fake.enqueue('not json either\n');
    fake.enqueue(JSON.stringify({
      FiiR: { FiiR: { preamp: -2, Bands: [{ type: 'PK', freq: 100, gain: 3, q: 1.2 }] } },
    }) + '\n');
    const result = await p;
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].frequency).toBe(100);
    expect(result.globalGain).toBe(-2 + 12);
  });

  it('rejects when the stream closes mid-command', async () => {
    const p = serial.pull();
    fake.closeStream();
    await expect(p).rejects.toThrow(/closed/i);
  });

  it('handles a response split across many chunks', async () => {
    const p = serial.pull();
    const payload = JSON.stringify({
      FiiR: { FiiR: { preamp: 0, Bands: [{ type: 'PK', freq: 250, gain: -1, q: 2 }] } },
    }) + '\n';
    for (const ch of payload) fake.enqueue(ch);
    const result = await p;
    expect(result.filters[0].frequency).toBe(250);
  });

  it('serializes concurrent commands — one reader, ordered responses', async () => {
    const respond = (freq) => JSON.stringify({
      FiiR: { FiiR: { preamp: 0, Bands: [{ type: 'PK', freq, gain: 0, q: 1 }] } },
    }) + '\n';

    const first = serial.pull();
    const second = serial.pull();
    // The device answers each command as it arrives; because commands are
    // serialized, the first response belongs to the first pull.
    fake.enqueue(respond(111));
    const r1 = await first;
    fake.enqueue(respond(222));
    const r2 = await second;
    expect(r1.filters[0].frequency).toBe(111);
    expect(r2.filters[0].frequency).toBe(222);
    // Both commands were actually written to the device.
    expect(fake.written).toHaveLength(2);
  });

  it('recovers after a timed-out command — the next command still works', async () => {
    await expect(serial.pull()).rejects.toThrow(/timeout/i);
    const p = serial.pull();
    fake.enqueue(JSON.stringify({
      FiiR: { FiiR: { preamp: 1, Bands: [{ type: 'PK', freq: 500, gain: 2, q: 1 }] } },
    }) + '\n');
    const result = await p;
    expect(result.filters[0].frequency).toBe(500);
  });
});
