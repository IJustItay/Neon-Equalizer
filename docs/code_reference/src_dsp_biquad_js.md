# Code Reference: `src/dsp/biquad.js`

> [!NOTE]
> This document provides an exhaustive, function-by-function breakdown of `src/dsp/biquad.js`.
> 
> **File Purpose:** This is the core Digital Signal Processing (DSP) mathematical engine. It calculates the magnitude response of biquad filters.
> 
> **Architecture Decision:** By keeping this math in a standalone module, *both* the visual UI graph (`frequencyGraph.js`) and the mathematical optimizer (`autoEQEngine.js`) use the exact same formulas. This guarantees that the curve you see on the screen is mathematically identical to the curve the AutoEQ engine is trying to minimize against.
> 
> **Can we live without it?** No. Without this, the application cannot draw curves or run AutoEQ.

---

## 1. Constants & Aliases
- **`DEFAULT_SAMPLE_RATE`**: 48000 Hz. The standard sample rate used to calculate the discrete-time coefficients.
- **`DEFAULT_Q`**: 0.707 (Butterworth Q).
- **`TYPE_ALIASES`**: Maps Equalizer APO's specific syntax strings (like `PK`, `PEQ`, `Modal`) down to the canonical mathematical filter families (`peaking`, `lowpass`, `highpass`, `bandpass`, `notch`, `allpass`, `lowshelf`, `highshelf`).

## 2. Core DSP Functions

### `biquadCoeffs({ type, frequency, gain, q, bw }, sampleRate)`
The most critical function in the file. It takes human-readable parameters (Gain, Q, Frequency) and converts them into the 5 feed-forward/feed-back coefficients (`b0, b1, b2, a1, a2`) that define a digital IIR filter.
- **Implementation:** It uses the exact formulas from the **Robert Bristow-Johnson (RBJ) Audio EQ Cookbook**, which is the industry standard for mapping analog EQ curves into the digital domain.
- **Domain Guards:** Includes rigorous checks (Issue #24). It rejects non-finite inputs. Crucially, it clamps the frequency strictly below the Nyquist frequency (`sampleRate / 2`). If a frequency hits exactly Nyquist, `sin(w0)` becomes 0, causing a division by zero that results in `NaN` coefficients. These `NaN`s would propagate and destroy the entire graph curve rendering.
- **Normalization:** It divides `b0`, `b1`, `b2`, `a1`, and `a2` by `a0`, returning the normalized coefficients.

### `magnitudeDbTrig(coeffs, cw, c2w, sw, s2w)`
Calculates the magnitude response (in Decibels) of the filter at a specific frequency on the unit circle (`|H(e^jω)|`).
- **Optimization:** Notice the arguments `cw, c2w, sw, s2w` instead of a frequency number. These are pre-calculated Cosine and Sine values. Because AutoEQ iterates thousands of candidate filters across the exact same frequency bins, calculating `Math.cos()` inside the loop would destroy performance. Passing pre-computed trig values makes this function blazing fast.
- **Math:** Evaluates the transfer function formula: 
  `H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)` 
  by separating it into Real (`numRe`, `denRe`) and Imaginary (`numIm`, `denIm`) parts, then using `Math.hypot` to find the magnitudes, and finally converting the ratio to dB using `20 * Math.log10()`.

### `precomputeTrig(frequencies, sampleRate)`
Generates the lookup arrays for `cw` (cos w), `c2w` (cos 2w), `sw` (sin w), and `s2w` (sin 2w) for an array of frequencies. Used by `autoEQEngine.js` before starting the coordinate-descent loop.

### `magnitudeDb(coeffs, frequency, sampleRate)`
A convenience wrapper for `magnitudeDbTrig`. It calculates the `Math.cos` and `Math.sin` values on the fly for a single frequency. Used primarily by the visual UI graph which doesn't need the extreme loop optimization of AutoEQ.

### `filterGainDb(filter, frequency, sampleRate)`
The top-level wrapper. Pass it a raw UI filter object (`{ type: 'PK', frequency: 100, gain: 5, q: 1 }`) and a test frequency, and it returns the dB gain.
- **Logic:** It checks if the filter is enabled. If so, it calls `biquadCoeffs` to get the coefficients, then passes them to `magnitudeDb`.

---

### Potential Improvements for `src/dsp/biquad.js`:
1. **WebAssembly (WASM):** While `magnitudeDbTrig` is highly optimized JavaScript, calculating this function millions of times during AutoEQ coordinate-descent is still the primary CPU bottleneck of the application. Rewriting `biquadCoeffs` and `magnitudeDbTrig` in AssemblyScript or Rust -> WASM could yield a massive performance boost for the AutoEQ engine.
