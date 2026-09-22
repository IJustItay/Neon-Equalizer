# Neon-Equalizer Comprehensive Documentation

> [!NOTE]
> Neon-Equalizer is a powerful, modern Windows GUI designed to sit on top of **Equalizer APO**, which traditionally relies on text-file configuration. It bridges the gap between text-based DSP routing and visual EQ editing.

---

## 1. Project Overview & Architecture

Neon-Equalizer is built using an **Electron** framework with a **Vanilla JavaScript (Vite)** frontend. It avoids heavy frontend frameworks like React or Vue in favor of raw performance and DOM manipulation, which is critical for real-time DSP plotting and fast AutoEQ optimization.

### Architecture Breakdown

- **Electron Main Process (`electron/main.js`)**: 
  - Manages the native OS integration: System tray icons, global keyboard shortcuts, listing Windows audio devices using PowerShell, detecting the Equalizer APO installation path, reading/writing to `config.txt`, and managing user-data backups via ZIP.
  - Exposes an IPC bridge (`electron/preload.js`) to allow the sandboxed renderer to safely read/write config files and fetch remote target data.
  
- **Vite/Vanilla Renderer (`src/main.js`)**:
  - The single-page application handling the entire user interface. 
  - Orchestrates several vanilla JS classes (`FrequencyGraph`, `ParametricEQ`, `GraphicEQ`) to manage the DOM and HTML canvas drawing.

- **DSP Core (`src/dsp/biquad.js`)**:
  - The single source of truth for filter math. Both the UI graph and the AutoEQ optimizer use the exact same math to calculate the magnitude response, ensuring what you see is exactly what is generated.

- **AutoEQ Web Worker (`src/workers/`)**:
  - AutoEQ calculations are extremely heavy. They are offloaded to a Web Worker (`autoeqWorker.js`) so the main UI thread never freezes during calculation, providing real-time progress updates.

---

## 2. Features and Tools

The application is heavily feature-packed, categorized into five main tabs in the UI:

### 1. Equalizer (`tab-eq`)
- **Parametric EQ**: Unlimited bands supporting peaking, high/low shelf, high/low pass, notch, band-pass, and all-pass filters. 
- **Graphic EQ**: Standard fixed-band sliders for broader tonal shaping.
- **Channel Routing**: Filters can target 'All', 'L', 'R', 'C', 'LFE', etc., maintaining compatibility with APO's internal routing.
- **Auto Preamp**: Prevents clipping automatically when adding boost filters.

### 2. AutoEQ & Headphones (`tab-autoeq`)
- **Squig.link Browser**: Directly integrates with the Squig.link database, allowing the user to search thousands of IEM/Headphone measurements.
- **Target Customizer**: Adjust the tilt, bass, treble, and ear-gain of a target curve before matching.
- **AutoEQ Engine**: Matches a loaded headphone measurement to a chosen target curve automatically, generating the exact Parametric EQ filters needed to fix the frequency response.

### 3. Hardware & Tools (`tab-tools`)
- **Device PEQ Transfer**: Pushes parametric filters directly into hardware (USB DACs like JDS Labs, Bluetooth earbuds, network streamers).
- **Surround Sound Setup**: Per-channel gain and delay configuration.
- **Loudness Correction & VSTs**: Manages Equalizer APO's internal loudness and external VST plugins.

### 4. Advanced (`tab-advanced`)
- **Raw Config Editor**: A two-way text editor. Allows users to view the raw Equalizer APO `config.txt` generated, or paste in a raw config and have Neon-Equalizer parse it visually into the UI.
- **Data Backup**: Export/import the entire state (snapshots, presets) into a ZIP file.

### 5. FR Tracer (`tab-trace`)
- Captures an image of a frequency response graph and traces it into usable mathematical measurement data for AutoEQ.

---

## 3. Directory Breakdown & Core Code Review

### `electron/` (Main Process)
- **`main.js`**: The core of the desktop app. 
  - *Key Functions:* `listWindowsAudioDevices()` (Uses PowerShell to find devices), `readMainConfigText()` / `writeMainConfigText()` (Interacts with APO). 
  - *Necessity:* **Critical.** Without it, the app cannot communicate with Windows OS, tray, or files.
- **`preload.js`**: 
  - *Key Functions:* Exposes `apoAPI` using `contextBridge`. 
  - *Necessity:* **Critical.** Required for Electron security to safely allow frontend JS to invoke backend OS commands.

### `src/config/` (Parser/Serializer)
- **`parser.js`**: 
  - *Purpose:* Reads a text block of Equalizer APO syntax and converts it into a structured JavaScript object (`{ filters: [], preamp: 0, etc }`).
  - *Key Features:* Preserves user comments and conditional `If/EndIf` blocks (it won't delete them if the user manually added them in the text file).
  - *Necessity:* **Critical.** This is the core engine bridging the visual UI with APO's text-based reality.
- **`serializer.js`**: 
  - *Purpose:* The exact reverse of `parser.js`. Takes the JS object and writes it cleanly back to APO syntax.

### `src/dsp/`
- **`biquad.js`**: 
  - *Purpose:* Implements the Robert Bristow-Johnson (RBJ) Audio EQ Cookbook formulas.
  - *Key Functions:* `biquadCoeffs` (calculates normalized coefficients a0/b0/etc.), `magnitudeDb` (calculates the magnitude of the filter at a specific frequency).
  - *Necessity:* **Critical.** The backbone of the entire visual and optimization engine.

### `src/components/`
- **`frequencyGraph.js`**: 
  - *Purpose:* Renders the interactive HTML Canvas graph. 
  - *Key Features:* Handles zooming, panning, dragging filter dots to change frequency/gain, and rendering the combined EQ response curve.
  - *Improvements:* Could potentially be migrated to a WebGL context or a specialized graphing library if performance with hundreds of nodes ever drops, though vanilla Canvas is generally fast enough.
- **`autoEQEngine.js`**: 
  - *Purpose:* The mathematical optimizer that matches a measurement curve to a target curve.
  - *Key Functions:* `autoEQ()` (The main loop utilizing coordinate descent refinement to find the best Q, Gain, and Freq for a set of shelf and peaking filters).
  - *Necessity:* **Critical** for the AutoEQ feature.
- **`parametricEQ.js`**: 
  - *Purpose:* Manages the DOM inputs (number boxes, dropdowns) for the parametric filters, binding them to the underlying state.

### `src/workers/`
- **`autoeqWorker.js` & `autoeqClient.js`**: 
  - *Purpose:* Wraps `autoEQEngine.js` in a Web Worker to prevent the main thread (UI) from locking up while crunching thousands of math operations.

---

## 4. Can We Improve It?

Overall, Neon-Equalizer is an exceptionally well-architected Vanilla JS application. It intentionally avoids React/Vue to maintain a tiny footprint and fast performance. 

**Potential Improvements:**
1. **TypeScript Migration:** As the project scales (specifically data passing between `main.js`, `frequencyGraph`, and `autoEQEngine`), migrating from pure JavaScript to TypeScript would greatly reduce bugs related to mismatched object schemas (e.g., ensuring a filter object always has `{ type, frequency, gain, q }`).
2. **State Management:** Currently, `src/main.js` orchestrates a lot of state manually. Moving to a more robust reactive store pattern (even a vanilla one like a Proxy-based state manager) could clean up the massive `src/main.js` file and decouple components further.
3. **Graphing Performance:** If users load incredibly high-resolution measurements, calculating the combined biquad response for thousands of pixels on every mouse move might stutter. Implementing WebGL or OffscreenCanvas for `frequencyGraph.js` could yield 144hz+ drawing smoothness regardless of data size.
