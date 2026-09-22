# Code Reference: `src/components/autoEQEngine.js`

`src/components/autoEQEngine.js` contains the `AutoEQEngine` class. This is a pure-JavaScript port of the Equalizer class from `modernGraphTool`, adapted to run efficiently within Neon Equalizer either on the main thread or within a Web Worker.

It is responsible for calculating a set of Parametric EQ filters (peaking and shelving) that correct a given headphone frequency response (measurement) to match a desired target curve.

## Core Optimization Algorithm

The engine uses a multi-step heuristic process rather than a pure gradient descent, making it robust against local minima common in acoustic filter optimization.

1.  **Resolution Normalization (`_normalizeResolution`)**:
    *   Before optimizing, it resamples both the measurement and target curves onto a standard 1/48-octave logarithmic frequency grid.
    *   It applies a fractional-octave smoothing (default 1/12 octave) to prevent the optimizer from chasing narrow, high-Q resonance peaks/dips in the raw measurement which are often measurement artifacts.
    *   It vertically aligns the target to the measurement at a specific reference frequency (usually 1kHz) or by matching the average energy across a midrange band (300Hz - 3000Hz).
2.  **Shelf Pre-analysis (`_analyzeShelfOpportunities` / `_optimizeShelfFilter`)**:
    *   The engine first checks if there is a massive broadband discrepancy in the sub-bass (<200Hz) or upper-treble (>8000Hz).
    *   If so, it assigns a Low-Shelf (`LSQ`) or High-Shelf (`HSQ`) filter and runs a coarse binary-search optimization to fix the bulk of the error before committing precious peaking filters to the task.
3.  **Candidate Search (`_searchCandidates` / `_scoreCandidates`)**:
    *   The engine scans the remaining error curve (difference between current EQ'd measurement and target) looking for contiguous regions where the error exceeds a threshold.
    *   For each region, it proposes a "candidate" peaking filter (`PK`) placed at the center of the error region, with its Q-factor and Gain roughly estimated from the region's width and depth.
    *   It scores candidates based on how much they reduce the global Root-Mean-Square (RMS) error and picks the best one.
4.  **Coordinate-Descent Refinement (`_optimize`)**:
    *   With a new filter added to the pool, the engine runs a coordinate-descent algorithm over *all* current filters.
    *   For each filter, it tweaks Frequency, Q, and Gain by small deltas (`stepDF`, `stepDQ`, `stepDG`). If a tweak reduces the total error, it keeps it and repeats.
    *   This is done in multiple passes with progressively finer step sizes (configured in `OptimizeDeltas`).
5.  **Pruning (`_pruneIneffectiveFilters`)**:
    *   After the maximum number of filters is reached, it tests removing each filter one by one. If removing a filter increases the global error by less than 0.1dB, the filter is discarded to keep the final EQ profile clean and minimal.

## Shared DSP Math

Crucially, `AutoEQEngine` does *not* use its own internal filter math. It imports `biquadCoeffs`, `magnitudeDbTrig`, and `precomputeTrig` from `src/dsp/biquad.js`.

This guarantees that the predicted response curve seen by the optimizer during coordinate descent is **mathematically identical** to the curve drawn on the canvas by `FrequencyGraph`, and identical to the actual audio processing if the user enables a browser-based preview.

To make the coordinate descent fast enough to run in JavaScript, the engine precomputes trigonometric tables (`_getTrig`) for the 1/48-octave frequency grid, avoiding thousands of expensive `Math.cos` calls during the optimization loop.

## Integration (`runAutoEQ`)

The file exports a top-level helper `runAutoEQ` that bridges the gap between the application's data format and the engine's internal math arrays.
*   It handles `intensity` scaling (scaling the gain of all resulting filters if the user wants less than 100% AutoEQ).
*   It handles the `subBassRollOff` option (adding a fixed low-shelf cut to prevent bass distortion).
*   It calculates the required `preamp` to prevent digital clipping by finding the highest positive peak in the generated filter response.
*   It maps internal `PK`, `LSQ`, `HSQ` types back to Equalizer APO syntax (`PK`, `LS`, `HS`).

## Worker Portability

While this file executes synchronously when imported normally, Neon Equalizer uses it within a Web Worker (`src/workers/autoeq.worker.js`). The code is written purely functionally without any DOM dependencies to ensure it can be bundled into a background thread.
