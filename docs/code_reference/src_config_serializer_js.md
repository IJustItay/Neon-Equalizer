# Code Reference: `src/config/serializer.js`

> [!NOTE]
> This document provides an exhaustive, function-by-function breakdown of `src/config/serializer.js`.
> 
> **File Purpose:** This is the text serializer. It takes the structured JavaScript object representing the UI state and converts it back into the raw text format Equalizer APO requires (`config.txt`).
> 
> **Can we live without it?** No. Equalizer APO does not read JSON or JS objects; it only reads its specific text-based configuration syntax.

---

## 1. Constants
- **`GENERATED_COMMENT_RE`**: A massive regex containing a list of strings (`# Equalizer APO Configuration`, `# Parametric EQ Filters`, etc.). When parsing the config, the parser uses this regex to ignore headers the app generates itself, preventing the headers from duplicating infinitely every time the user saves the file.

## 2. Main Serializer: `serializeConfig(config)`
This is the core export. It takes the full state object and pushes lines of string text to an array, joining them with `\n` at the very end.
- **Headers:** Pushes standard headers (`# Equalizer APO Configuration`).
- **Global Settings:** Serializes `Device:`, `Stage:`, and global `Channel:` directives. It explicitly writes `Device: all` if no specific device is chosen, ensuring the APO engine knows to apply globally.
- **Includes & Preamp:** Serializes included files (prefixing with `#` if they are disabled) and the master `Preamp` in dB.
- **Conditionals (Issue #13 fix):** Iterates over `config.conditionalBlocks` and writes them out verbatim. This guarantees that hand-written `If/EndIf` logic in the text file is put exactly back into the text file without the UI destroying it.
- **Filters (Parametric EQ):** 
  - Groups filters by their specific channel targeting (e.g., all `L` filters together, all `R` filters together).
  - Emits `# Filters — channel L` followed by `Channel: L`, and then calls `serializeFilter()` for each filter in that group.
- **Graphic EQ:** Maps the `{frequency, gain}` objects back into a semicolon-separated string: `GraphicEQ: 20 0.00; 40 -1.00; ...`.
- **Hardware Routing:** Serializes `Convolution`, `Delay`, and `Copy` directives.
- **Plugins & Loudness:** Formats the `VSTPlugin` DLL paths (using `quoteApoArg` to handle spaces in paths) and parses out the APO built-in `LoudnessCorrection` arguments.
- **Preservation Blocks:** At the very bottom of the file, it dumps everything in `unsupportedLines` and `comments`. This is a critical design choice: even if Neon Equalizer doesn't understand a new APO command, it will not delete it from the user's config file.

## 3. Helper Functions
- **`serializeFilter(filter, num)`**: 
  - Takes a filter object and converts it to text.
  - Builds the line sequentially: `Filter: [ON/OFF] [TYPE] Fc [FREQ] Hz Gain [GAIN] dB Q [Q]`.
  - Handles edge cases for `Modal` (T60 target) and `IIR` (Order and Coefficients).
- **`serializeDelay(delay)`**: Formats the delay struct into either `Delay: 10 ms` or `Delay: 44100 samples`.
- **`quoteApoArg(value)`**: Wraps strings in double quotes if they contain spaces (e.g., VST file paths), escaping internal quotes with `""` per APO syntax.
- **`formatApoDevice(value)`**: Defaults to `all`.
- **`toApoInt` / `clampNumber` / `formatApoNumber`**: Math utilities ensuring the string output doesn't contain JavaScript anomalies like `NaN` or `Infinity` that would crash the APO engine.

## 4. Default State
- **`createDefaultConfig()`**: A simple factory function that returns an empty boilerplate config object, used when creating a completely new preset or clearing the board.

---

### Potential Improvements for `src/config/serializer.js`:
1. **Order Preservation:** Currently, user comments and unsupported lines are dumped at the *very bottom* of the generated text file. If a user put a comment `# Tweaking the bass` right above `Filter 1`, loading and saving the file moves that comment to the bottom of the file. A complete Abstract Syntax Tree (AST) approach would maintain exact line ordering, though it would be significantly harder to implement.
