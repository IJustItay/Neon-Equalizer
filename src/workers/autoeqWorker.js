/**
 * AutoEQ Web Worker
 * Runs the (CPU-heavy) coordinate-descent optimizer off the UI thread so the
 * app stays responsive — and so optimization can report progress and be
 * cancelled. Communicates with src/workers/autoeqClient.js.
 */

import { runAutoEQ } from '../components/autoEQEngine.js';

self.onmessage = (e) => {
  const { id, measurement, target, options } = e.data || {};
  try {
    const onProgress = (done, total, stage) => {
      self.postMessage({ id, type: 'progress', done, total, stage });
    };
    const result = runAutoEQ(measurement, target, { ...options, onProgress });
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
