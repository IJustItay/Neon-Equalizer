# Code Reference: `src/main.js`

`src/main.js` is the monolithic core of the Neon Equalizer frontend. At over 5800 lines, it acts as the central controller, binding together the UI components, the underlying DSP logic, configuration state, and the various external integrations (Squiglink, AutoEQ, Hardware EQ).

It is written in Vanilla JavaScript and directly manipulates the DOM, avoiding heavy frameworks to keep performance high and dependencies low.

## Core Architecture and Initialization

The entry point for the frontend is the `init()` function (line 120), which triggers on `DOMContentLoaded`.

### Initialization Sequence (`init()`)
1. **System & APO Detection (`detectAPO`)**: Checks if it's running in Electron (`window.apoAPI`) to read the current Equalizer APO configuration. If not, it falls back to "browser mode" and loads a demo config.
2. **State & Bus Setup**: `appState` holds the active configuration. `appBus` acts as a rudimentary event emitter for inter-component communication.
3. **Hardware Device Setup**: `devicePeq.init()` initializes the WebHID/Network abstraction for Moondrop/WiiM hardware EQ transfer.
4. **Surround Sound Parsing**: Initializes parsing for multi-channel setup if APO's `Copy:` commands exist for surround configuration.
5. **DOM Bindings**: A massive sequence of `init*Panel()` and `init*Controls()` functions attach event listeners to every interactive element in the app.

## Key Modules & Panels Handled in `main.js`

Due to the size of the file, functionality is grouped into initialization functions.

### 1. `initTopBar()` & Device Management
Manages the global preamp slider, Auto Preamp toggle, device selector, and config saving/reloading.
- **Auto Preamp**: When enabled, automatically adjusts the global preamp to offset the highest peak in the parametric/graphic EQ to prevent digital clipping (`applyAutoPreamp`).
- **Device Selector**: Controls whether the EQ applies to 'All Devices' or specific audio endpoints. Uses `listWindowsAudioDevices` (which currently blocks the main thread in `electron/main.js`).

### 2. Equalizer Modes (Parametric vs Graphic)
- **Parametric EQ (`initParametricEQ`)**: Binds the `ParametricEQ` class instance. Sets up adding, removing, sorting, and clearing peaking/shelving/pass filters.
- **Graphic EQ (`initGraphicEQ`)**: Binds the `GraphicEQ` class instance. Handles setting the number of bands, importing/exporting CSV frequency responses, smoothing, and normalizing.

### 3. Graph & Visualization (`initFrequencyGraph`)
- Initializes `modernGraphTool.js` (`freqGraph`), which plots the EQ response, the measurement curve, the target curve, and phase response.
- **Spectrum Analyzer**: Connects the `audioPlayer` analyser node to the graph if the spectrum overlay is enabled (`syncGraphSpectrumOverlay`).

### 4. AutoEQ & Squiglink (`initAutoEQPanel` & `initSquiglinkDBPanel`)
This is a massive section of the file providing advanced acoustic correction.
- **Squiglink Integration**: Connects to an external registry (`SquigDB`) of headphone measurements. Users can browse, search, and load raw measurements directly into the app.
- **Target Picker (`initTargetPicker`)**: Allows users to select target frequency responses (e.g., Harman, Diffuse Field, or reviewer-specific targets).
- **AutoEQ Engine (`runOptimizer`)**: Takes the selected Squiglink measurement and Target curve, and calculates a set of Parametric EQ filters to correct the headphone's response to the target. This runs asynchronously (using web workers via `runAutoEQAsync`) so it doesn't freeze the UI.

### 5. FR Tracer (`initTracePanel`)
Integrates **UsyTrace** via an iframe. Allows users to capture screenshots of frequency response graphs from the web (or the embedded squiglink preview), trace them into data points, and import them into the app as a measurement for AutoEQ.

### 6. Tools & Advanced Features
- **Convolution (`initConvolution`)**: UI for loading `.wav`/`.flac` Impulse Responses for convolution processing.
- **VST Plugins (`initVSTPlugins`)**: UI for adding VST `.dll` plugins and parameters to the APO chain.
- **Loudness Correction (`initLoudnessCorrection`)**: Implements equal-loudness contour adjustments based on a reference volume level.
- **Crossfeed & Effects**: Simple macros that insert predefined filters or `Copy:` routing commands for Bass/Treble boosts and Crossfeed.

### 7. User Profiles (`initQuickPresets` & `initAdvancedPanel`)
- **Quick Presets**: Saves snapshots of the current `appState.config` alongside UI settings into `Profiles` (backed by `localStorage` and optionally written to APO preset files).
- **A/B Testing & Snapshots**: Allows saving temporary EQ states into memory to quickly A/B compare different tuning configurations (`saveEQSnapshot`, `toggleABCompare`).

### 8. Hardware EQ Transfer (`initHIDPanel`)
- Interfaces with `devicePeq` to connect via WebHID to supported hardware DSPs (Moondrop FreeDSP, May, Dawn Pro, etc.).
- **Push/Pull**: Reads (`pull`) the parametric filters from the hardware and applies them to the UI, or pushes (`push`) the current UI filters directly to the hardware's memory slots.

## State Management (`refreshUI`)
Since the application does not use React or Vue, state updates are handled by a manual dispatch system.
- `REFRESHERS`: An object mapping specific UI zones (e.g., `REFRESH.PARAMETRIC`, `REFRESH.GRAPH`) to their respective redraw functions.
- `refresh()`: A scoped dispatcher. Calling `refresh(REFRESH.GRAPH)` only updates the canvas, avoiding the cost of tearing down and rebuilding the entire UI.
- `appState.config`: The single source of truth for the active Equalizer APO configuration. Modifying this object and calling `markDirty()` schedules an auto-save (if enabled) and updates the undo history.

## Performance Considerations & Improvements
1. **File Size**: At 5800 lines, `main.js` is incredibly difficult to maintain. It tightly couples DOM event binding, application logic, and hardware interfacing.
   - **Improvement**: Refactor into modular controllers (e.g., `controllers/AutoEQController.js`, `controllers/SquiglinkController.js`, `controllers/TargetPickerController.js`).
2. **DOM Queries**: Heavy use of `document.getElementById` and `querySelector` during render loops.
   - **Improvement**: Cache DOM references during initialization.
3. **Synchronous Fallbacks**: The AutoEQ process tries to use web workers, but falls back to synchronous processing on the main thread if it fails, which freezes the app.
4. **State Mutations**: Direct mutation of `appState.config.filters` is prevalent. Abstracting this behind getter/setter actions would prevent UI desyncs.

## Can we live without it?
No. `main.js` is the absolute core of the web application. Without it, the UI is just an inert HTML shell. However, the app would drastically benefit from breaking it apart into smaller, focused modules.
