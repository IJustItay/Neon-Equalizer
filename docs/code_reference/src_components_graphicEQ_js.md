# Code Reference: `src/components/graphicEQ.js`

This file implements the `GraphicEQ` class, responsible for rendering and managing the Graphic Equalizer panel. Unlike the Parametric EQ, the Graphic EQ provides a fixed or custom set of frequency bands, each controlled by a single vertical slider adjusting gain.

## Core Features and Data Model

The `GraphicEQ` manages an array of `bands` (each `{ frequency, gain }`).

### Band Configuration
*   **ISO Standard Presets**: It natively supports standard 10-band, 15-band, and 31-band ISO frequency distributions (`ISO_BANDS`).
*   **Custom Bands**: Users can add, remove, duplicate, or manually type in frequencies for any band, essentially turning it into a Variable-Band Graphic EQ.
*   **Curve Preservation**: When switching between band counts (e.g., 10-band to 31-band), the `setFrequencies` method uses `_interpolateGain` to calculate the new slider positions, preserving the overall shape of the EQ curve.

### Data Manipulation Operations
The class exposes several utility methods to modify the entire curve at once:
*   `invert()`: Flips the curve upside down (multiplies all gains by -1).
*   `normalize()`: Shifts the entire curve down so that the highest peak touches 0dB. This is a crucial safety feature to prevent digital clipping when applying positive gain.
*   `normalizeAtFrequency(freq, targetGain)`: Shifts the entire curve up or down so that the interpolated gain at a specific frequency (e.g., 1000Hz) matches the target.
*   `smooth()`: Applies a simple 3-point moving average to the slider gains, softening harsh transitions between adjacent bands.

### Config Parsing & Export
*   `GraphicEQ.parseFrequencyResponse(text)`: A static utility that parses APO-formatted `GraphicEQ:` strings (e.g., `GraphicEQ: 20 -2; 50 3; 1000 0`). It uses a robust regex (`NUMBER_PATTERN`) to extract frequency-gain pairs, ignoring comments (`#`) and unparseable lines.
*   `toCSV()`: Exports the current slider configuration as a simple two-column text format.

## UI Rendering (`_render`)

The UI is built using immediate-mode DOM creation, clearing and rebuilding the `container` when bands are added/removed.
*   **Ruler**: A fixed scale (`+15`, `0`, `-15`) rendered on the left side.
*   **Slider Track**: Each band uses a native HTML `<input type="range">` oriented vertically via CSS.
*   **Visual Fill**: To make the EQ shape more readable, a custom `geq-slider-fill` `<div>` is positioned absolutely over the track. It anchors to the 0dB line and stretches up (green/positive) or down (red/negative) based on the gain.
*   **Inputs**: Each band has `<input type="number">` fields for both Frequency and Gain, allowing precise numeric entry without relying on the mouse slider.

## Event Handling
*   **Sliding**: Triggers `updateVisual` on `input` (real-time visual update) and fires `_notify` (`onChange` callback) to tell the main controller to recalculate the audio graph.
*   **Double-Click**: Double-clicking a slider instantly resets its gain to `0dB`.
*   **Right-Click**: Right-clicking a band's background deletes it.

## Limitations and Potential Improvements
*   **Fixed Gain Range**: The sliders are hardcoded to a range of `GAIN_MIN` (-15) to `GAIN_MAX` (+15). If a user imports a config with a +20dB peak, the underlying data holds +20, but the slider visual will cap at +15.
*   **DOM Performance**: Like the Parametric EQ, rebuilding the entire DOM on band insertion/deletion is inefficient, though rarely a bottleneck for 31 elements.
