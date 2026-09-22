# Code Reference: `src/config/parser.js`

> [!NOTE]
> This document provides an exhaustive, function-by-function breakdown of `src/config/parser.js`.
> 
> **File Purpose:** This is the text parser that converts raw Equalizer APO `config.txt` strings into structured JavaScript objects (`{ filters: [], preamp: 0, etc. }`) that the UI can render.
> 
> **Can we live without it?** Absolutely not. Equalizer APO relies entirely on text files. Without this parser, the visual UI would have no way to understand what filters currently exist on the user's system.

---

## 1. Constants
- **`FILTER_TYPES`**: An array of all Equalizer APO filter types supported by the app (`PK`, `Modal`, `PEQ`, `LP`, `LPQ`, `HP`, `HPQ`, `BP`, `LS`, `LSC`, `LS 6dB`, `LS 12dB`, `HS`, `HSC`, `HS 6dB`, `HS 12dB`, `NO`, `AP`, `IIR`).
- **`CHANNEL_NAMES`**: Standard channel mappings (`L`, `R`, `C`, `LFE`, `RL`, `RR`, `SL`, `SR`, `RC`).
- **`APO_NUMBER_RE`**: A robust regex designed to match numbers in various locales (e.g., `1,000.5` vs `1.000,5`) and scientific notations (`1e-5`).

## 2. Main Parser: `parseConfig(text)`
This is the core export. It loops over every line of the provided text string.
- **Initialization:** Creates a blank `config` object containing arrays for `filters`, `delays`, `vstPlugins`, `comments`, `conditionalBlocks`, `unsupportedLines`, etc.
- **Looping (`lines[i]`):**
  - **Comments (`#`)**: If a line starts with `#`, it checks if it's a commented-out APO command (like `# VSTPlugin:`). If so, it parses it but sets `enabled: false`. If it's the app's own generated UI comments (`# == Neon Equalizer ==`), it ignores them to prevent duplication on save. Otherwise, it stores it as a regular user comment.
  - **Conditionals (`If` ... `EndIf`)**: (Issue #13 fix) If a line starts with `If`, the parser blindly consumes every line until it hits the matching `EndIf`. It stores this as an opaque `conditionalBlock`. This is critical: if a user hand-wrote a complex `If` statement, the UI won't break it, it just won't render it in the visual editor, preserving it safely for the serializer to write back later.
  - **Filters (`Filter N:`)**: Uses regex to match filter definitions, pushing the results of `parseFilter()` into `config.filters`.
  - **Directives Switch Case:** Checks the command part (`Preamp`, `Device`, `Channel`, `GraphicEQ`, `Convolution`, `Delay`, `Copy`, `VSTPlugin`, `LoudnessCorrection`, `Eval`). It delegates parsing to specific helper functions. Unrecognized commands are pushed to `unsupportedLines`.

## 3. Helper Functions
- **`normalizeChannelSpec(params)`**: Maps a channel string to the canonical list, allowing routing (e.g., `Channel: L R`).
- **`parsePreamp(params)`**: Extracts the dB value from a `Preamp: -5 dB` string.
- **`parseFilter(params, index, color)`**: 
  - Extracts the `ON` / `OFF` state to set the `enabled` boolean.
  - Uses a sorted regex match against `FILTER_TYPES` to find the type of filter.
  - Calls `extractParam()` repeatedly to grab `Fc` (Frequency), `Gain`, `Q`, and `BW`.
  - Handles specialized parsing for `IIR` filters (which have raw `Order` and `Coefficients` arrays) and `Modal` filters (which have `T60` targets).
  - Returns a unified JavaScript object representing that single filter node.
- **`extractParam(str, name, unit)`**: A regex utility that dynamically builds a search string (e.g., matching `Fc [number] Hz` or `Gain [number] dB`).
- **`parseGraphicEQ(params)`**: Extracts all number pairs using `extractNumberPairs()`, converting the string of values into an array of `{ frequency, gain }` objects.
- **`parseDelay(params)`**: Parses delay values, supporting both `ms` and raw audio `samples`.

## 4. Number & Locale Parsing (Crucial Fixes)
- **`parseApoNumber(value)`**: Equalizer APO users live worldwide, meaning decimals might be written as `1.5` or `1,5`. This function normalizes the string, replacing commas with dots if no dots exist, ensuring JavaScript's `Number()` parses it correctly.
- **`parseApoFrequency(value)`**: (Fixes Issue #17) A highly complex parsing function. It analyzes strings to determine if a dot or comma is a thousand-separator or a decimal. 
  - E.g., `1.234,5` -> Dots are thousands, comma is decimal -> `1234.5`.
  - E.g., `1,234.5` -> Commas are thousands, dot is decimal -> `1234.5`.
  - E.g., `20.000` -> A single dot is treated as a decimal -> `20` Hz (not 20,000 Hz).

## 5. Sub-directive Parsers
- **`parseCopy(params)`**: Parses `Copy: L=R` into `{ target: 'L', expression: 'R' }`.
- **`parseVSTPlugin(params, line)`**: Extracts the `.dll` path and the chunk data for external VSTs.
- **`parseLoudnessCorrection(params, line)`**: Extracts `ReferenceLevel`, `ReferenceOffset`, and `Attenuation` for APO's built-in loudness feature.

## 6. UI Helpers
- **`generateFilterColors(count)`**: Generates visually distinct `hsl()` color codes for every parametric EQ filter so they appear cleanly separated in the graph canvas.

---

### Potential Improvements for `src/config/parser.js`:
1. **Error Boundaries:** If `parseConfig` throws an error due to an insanely malformed regex match, the entire UI fails to load the file. Wrapping specific directive parsers in `try/catch` blocks and pushing failures to `unsupportedLines` would make the parser completely crash-proof.
2. **Regex Performance:** `parseFilter` dynamically builds `new RegExp` objects in a loop for every single filter (and `extractParam` does the same for every parameter of every filter). For configs with 10,000+ filters (which AutoEQ can generate if not pruned), this causes noticeable CPU spikes. The regexes for `Fc`, `Gain`, and `Q` should be statically compiled at the top of the file.
