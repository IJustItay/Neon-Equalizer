# Features Added from modernGraphTool

This document summarizes the new features added to Neon Equalizer v2.0.0, inspired by the modern audio equalization tooling in [modernGraphTool](https://github.com/potatosalad775/modernGraphTool).

## 1. Audio Preview Player

**Location:** Bottom of the **Parametric EQ** tab  
**Files:** `src/components/audioPlayer.js` (670 lines)

A complete Web Audio API-based audio player with real-time EQ preview.

### Features:
- **Audio Sources:**
  - Pink noise (psychoacoustic testing)
  - White noise (reference)
  - Tone generator (20 Hz – 20,000 Hz, logarithmic scale)
  - Uploaded audio files (.wav, .mp3, .ogg, etc.)

- **Playback Controls:**
  - Play / Pause / Stop buttons
  - Volume slider (0–100%)
  - Mute indicator icon

- **EQ Integration:**
  - Real-time biquad filter chain from parametric EQ
  - Automatic preamp gain from main slider
  - Toggle to bypass EQ for A/B comparison
  - Refreshes automatically when filters change

- **Spectrum Analyser:**
  - Live 64-bar frequency spectrum display
  - Cyan-to-purple gradient visualization
  - 4096-point FFT resolution
  - Updates 60 FPS during playback

### Implementation:
- No external dependencies (native Web Audio API)
- Supports all parametric filter types (PK, LP, HP, BP, LS, HS, etc.)
- Pink noise using Kellet's algorithm for realistic spectral content
- Responsive UI with device pixel ratio scaling

---

## 2. Target Customizer

**Location:** Top of the **AutoEQ & Headphones** tab  
**Files:** Added UI to `index.html`, wiring in `src/main.js`

Interactive target curve customization with real-time graph updates.

### Sliders:
1. **Tilt** (−3 to +3 dB/octave)
   - Linear slope in log-frequency space
   - Pivot at 1 kHz (0 dB reference)
   - For brightening/darkening entire frequency response

2. **Bass** (±12 dB)
   - Smooth low-shelf below 300 Hz
   - First-order shelving response
   - For warmth or lean bass

3. **Treble** (±12 dB)
   - Smooth high-shelf above 4 kHz
   - First-order shelving response
   - For presence or smoothness

### Presets:
- **Neutral** — Flat response (0 dB all)
- **Harman 2019** — Harman target curve approximation (+6 dB bass, −2 dB treble)
- **Warm** — Elevated lows, reduced highs (−0.5 tilt, +3 bass, −3 treble)
- **Bright / Analytical** — Reduced lows, elevated highs (+0.5 tilt, −2 bass, +3 treble)

### Behavior:
- All adjustments are applied to the loaded headphone measurement curve
- Changes update the target overlay on the frequency graph in real-time
- Stored in `tcState` object for persistence across panel switches
- Base measurement data cached when headphone is selected, allowing proper reset

---

## 3. Preference Bounds Overlay

**Location:** Graph controls (new **◈** button)  
**Files:** `src/components/frequencyGraph.js`, wiring in `src/main.js`

Shaded region on the frequency response graph showing audio preference boundaries.

### Features:
- **Harman-Inspired Bounds:**
  - Upper boundary: boosted bass (up to +8 dB @ 20 Hz) transitioning to treble roll-off
  - Lower boundary: flatter bass with more aggressive treble reduction
  - Smooth interpolation across frequency range

- **Visual Design:**
  - Semi-transparent golden fill (8% opacity)
  - Dashed boundary lines (35% opacity)
  - Automatically appears in graph legend when toggled on
  - Non-intrusive styling compatible with existing visualization

- **Interaction:**
  - Toggle on/off with ◈ button in graph controls
  - Persists as long as user hasn't changed the bounds setting
  - Auto-loads standard Harman bounds on first click

### Use Case:
Guides users toward "acceptable" frequency response ranges for headphone EQ. Shows that the goal isn't necessarily flat, but within an auditorily-preferred envelope.

---

## Technical Implementation

### New Files:
- `src/components/audioPlayer.js` — Complete Web Audio implementation

### Modified Files:
- `src/main.js` — Added initialization and wiring for all three features
- `index.html` — Added UI for Audio Player and Target Customizer, graph button
- `src/components/frequencyGraph.js` — Added preference bounds drawing logic
- `src/index.css` — ~150 lines of styling for new components

### Integration Points:
1. **Audio Player ↔ Parametric EQ:** Real-time filter chain updates via `refreshEQ()` callback
2. **Target Customizer ↔ Frequency Graph:** Direct `setTargetData()` calls with custom adjustments
3. **Preference Bounds ↔ Graph:** Toggle state tracked in `freqGraph.prefBoundsVisible`

### Data Flow:
```
[Filter Change] → parametricEQ.onChange() → audioPlayer.refreshEQ()
                                         → freqGraph.setFilters()
                                         → [Graph Updates]

[Target Adjustment] → rebuildCustomTarget() → freqGraph.setTargetData()
                   → [Graph Updates]

[Bounds Toggle] → freqGraph.togglePrefBounds() → [Bounds Drawn on Graph]
```

---

## Performance Considerations

- **Audio Player:** Spectrum analyser uses `requestAnimationFrame` for 60 FPS updates without blocking
- **Target Customizer:** Lazy calculation only when sliders move (no polling)
- **Preference Bounds:** Simple SVG path rendering, negligible overhead (~1 ms per frame)
- **Web Audio:** Uses native biquad filters (hardware-optimized on most systems)

---

## Browser Compatibility

- **Web Audio API:** All modern browsers (Chrome 25+, Firefox 35+, Safari 12+, Edge 79+)
- **Tested:** Windows 11 with Electron 33.0.0

---

## Future Enhancements

Ideas for extending these features:

1. **Audio Player:**
   - Spectrum frequency/phase display
   - Adjustable analysis window
   - Record output to file

2. **Target Customizer:**
   - Custom preset save/load
   - Per-frequency adjustment curves (vs. global tilt/shelf)
   - Comparison with industry standards (Harman, IEC, ISO)

3. **Preference Bounds:**
   - User-editable bounds curves
   - Multiple bound sets (headphone type, listening preference)
   - Historical measurement database overlay

---

## Credits

Features inspired by [modernGraphTool](https://github.com/potatosalad775/modernGraphTool) by @potatosalad775 — a complete re-engineering of professional audio equalization visualization and control.
