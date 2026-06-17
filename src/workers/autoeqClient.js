/**
 * AutoEQ worker client
 * Thin promise-based wrapper around the AutoEQ Web Worker, with progress
 * reporting and a safe fallback to synchronous execution if a module worker
 * can't be created/loaded (e.g. some packaged file:// contexts).
 */

import { runAutoEQ } from '../components/autoEQEngine.js';

let _worker = null;
let _workerBroken = false;
let _seq = 0;
const _pending = new Map();

function rejectAll(reason) {
  for (const entry of _pending.values()) entry.reject(reason);
  _pending.clear();
}

function getWorker() {
  if (_workerBroken) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./autoeqWorker.js', import.meta.url), {
      type: 'module',
    });
    _worker.onmessage = (e) => {
      const { id, type, result, message, done, total, stage } = e.data || {};
      const entry = _pending.get(id);
      if (!entry) return;
      if (type === 'progress') {
        entry.onProgress?.(done, total, stage);
        return;
      }
      if (type === 'result') {
        entry.resolve(result);
      } else if (type === 'error') {
        entry.reject(new Error(message || 'AutoEQ worker error'));
      }
      _pending.delete(id);
    };
    _worker.onerror = () => {
      // Worker failed to load/run — mark broken so future calls use fallback.
      _workerBroken = true;
      rejectAll(new Error('AutoEQ worker crashed'));
      try { _worker?.terminate(); } catch { /* ignore */ }
      _worker = null;
    };
  } catch {
    _workerBroken = true;
    _worker = null;
  }
  return _worker;
}

/**
 * Run AutoEQ, off the main thread when possible.
 * @param {{freq:number[],spl:number[]}} measurement
 * @param {{freq:number[],spl:number[]}} target
 * @param {object} options - AutoEQ options (must be structured-clone-safe)
 * @param {{onProgress?:(done:number,total:number,stage:string)=>void}} [hooks]
 * @returns {Promise<{filters:Array,preamp:number,alignment:object|null}>}
 */
export function runAutoEQAsync(measurement, target, options = {}, hooks = {}) {
  const { onProgress } = hooks;
  const worker = getWorker();

  if (!worker) {
    // Synchronous fallback — still async-shaped so callers can await uniformly.
    return Promise.resolve().then(() => runAutoEQ(measurement, target, options));
  }

  // Functions can't be structured-cloned; progress is delivered via messages.
  const { onProgress: _omit, ...cloneable } = options;

  return new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject, onProgress });
    try {
      worker.postMessage({ id, measurement, target, options: cloneable });
    } catch (err) {
      _pending.delete(id);
      reject(err);
    }
  });
}

/** Tear down the worker (e.g. on app teardown). */
export function terminateAutoEQWorker() {
  if (_worker) {
    try { _worker.terminate(); } catch { /* ignore */ }
    _worker = null;
  }
  rejectAll(new Error('AutoEQ worker terminated'));
}
