/**
 * Shared biquad DSP — the single source of truth for filter magnitude response.
 *
 * Both the frequency-response graph (src/components/frequencyGraph.js) and the
 * AutoEQ optimizer (src/components/autoEQEngine.js) consume these functions so
 * that the curve the user *sees* is computed with the exact same math the
 * optimizer *targets*. Keeping two separate implementations in sync by hand was
 * a correctness hazard; this module removes that drift.
 *
 * Coefficients follow the RBJ Audio EQ Cookbook. Magnitude is evaluated directly
 * on the unit circle (|H(e^jω)|) rather than via the phi approximation, which is
 * what Equalizer APO's own preview uses and is numerically the most faithful.
 */

export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_Q = 0.707;

// Map every app/engine filter-type alias to a canonical biquad family.
const TYPE_ALIASES = {
  PK: 'peaking', PEQ: 'peaking', MODAL: 'peaking',
  LP: 'lowpass', LPQ: 'lowpass',
  HP: 'highpass', HPQ: 'highpass',
  BP: 'bandpass',
  NO: 'notch',
  AP: 'allpass',
  LS: 'lowshelf', LSC: 'lowshelf', LSQ: 'lowshelf',
  'LS 6DB': 'lowshelf', 'LS 12DB': 'lowshelf',
  HS: 'highshelf', HSC: 'highshelf', HSQ: 'highshelf',
  'HS 6DB': 'highshelf', 'HS 12DB': 'highshelf',
};

/** Resolve a filter type string (any alias) to its canonical biquad family, or null. */
export function canonicalFilterFamily(type) {
  if (!type) return null;
  return TYPE_ALIASES[String(type).toUpperCase()] || null;
}

/**
 * Build normalized biquad coefficients (a0 == 1) for a filter.
 * Accepts the app shape ({ type, frequency, gain, q, bw }); engine callers pass
 * `frequency` explicitly.
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}|null}
 */
export function biquadCoeffs(
  { type, frequency, gain = 0, q = DEFAULT_Q, bw = null } = {},
  sampleRate = DEFAULT_SAMPLE_RATE
) {
  const family = canonicalFilterFamily(type);
  if (!family || !frequency) return null;

  // Domain guards (issue #24): reject non-finite inputs and clamp the
  // frequency strictly below Nyquist — at exactly Nyquist sin(w0) = 0 and the
  // BW-form alpha divides by it, producing NaN coefficients that poison every
  // downstream sum (graph curves, peak detection, auto-preamp).
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  if (!Number.isFinite(gain)) return null;
  if (q !== null && q !== undefined && (!Number.isFinite(q) || q < 0)) return null;
  if (bw !== null && bw !== undefined && !Number.isFinite(bw)) return null;

  const nyquist = sampleRate / 2;
  const f = Math.min(frequency, nyquist * (1 - 1e-6));

  const w0 = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const A = Math.pow(10, (gain || 0) / 40);
  const Qv = q || DEFAULT_Q;

  let alpha;
  if (bw) {
    alpha = sw * Math.sinh(((Math.log(2) / 2) * bw * w0) / sw);
  } else {
    alpha = sw / (2 * Qv);
  }
  if (!Number.isFinite(alpha)) return null;

  let b0, b1, b2, a0, a1, a2;
  switch (family) {
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'lowshelf': {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sq);
      a0 = (A + 1) + (A - 1) * cw + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sq;
      break;
    }
    case 'highshelf': {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sq);
      a0 = (A + 1) - (A - 1) * cw + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sq;
      break;
    }
    default:
      return null;
  }

  const out = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  // Every coefficient must be finite — otherwise callers treat the filter as
  // unsupported (skipped) instead of propagating NaN through response sums.
  if (!Number.isFinite(out.b0) || !Number.isFinite(out.b1) || !Number.isFinite(out.b2) ||
      !Number.isFinite(out.a1) || !Number.isFinite(out.a2)) {
    return null;
  }
  return out;
}

/**
 * Magnitude (dB) of a normalized biquad given precomputed unit-circle trig.
 * Hot path: the optimizer precomputes cos/sin per frequency once and reuses
 * them across every candidate filter.
 */
export function magnitudeDbTrig(coeffs, cw, c2w, sw, s2w) {
  if (!coeffs) return 0;
  const { b0, b1, b2, a1, a2 } = coeffs;
  const numRe = b0 + b1 * cw + b2 * c2w;
  const numIm = -(b1 * sw + b2 * s2w);
  const denRe = 1 + a1 * cw + a2 * c2w;
  const denIm = -(a1 * sw + a2 * s2w);
  const numMag = Math.hypot(numRe, numIm);
  const denMag = Math.hypot(denRe, denIm);
  if (denMag === 0) return 0;
  return 20 * Math.log10(numMag / denMag);
}

/** Magnitude (dB) of a normalized biquad at a frequency. */
export function magnitudeDb(coeffs, frequency, sampleRate = DEFAULT_SAMPLE_RATE) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  return magnitudeDbTrig(
    coeffs,
    Math.cos(w), Math.cos(2 * w),
    Math.sin(w), Math.sin(2 * w)
  );
}

/** Precompute the per-frequency trig terms magnitudeDbTrig needs. */
export function precomputeTrig(frequencies, sampleRate = DEFAULT_SAMPLE_RATE) {
  const n = frequencies.length;
  const cw = new Float64Array(n), c2w = new Float64Array(n);
  const sw = new Float64Array(n), s2w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * frequencies[i]) / sampleRate;
    cw[i] = Math.cos(w); c2w[i] = Math.cos(2 * w);
    sw[i] = Math.sin(w); s2w[i] = Math.sin(2 * w);
  }
  return { cw, c2w, sw, s2w };
}

/**
 * Convenience: gain (dB) contributed by a single app/engine filter at a
 * frequency. Returns 0 for disabled, frequency-less, or unsupported filters.
 */
export function filterGainDb(filter, frequency, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!filter || filter.enabled === false || !filter.frequency) return 0;
  const coeffs = biquadCoeffs(filter, sampleRate);
  return coeffs ? magnitudeDb(coeffs, frequency, sampleRate) : 0;
}
