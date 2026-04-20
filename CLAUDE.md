# Neon Equalizer — AI Agent Context

Everything an AI agent needs to work on this codebase safely without breaking things.

---

## What This App Is

**Neon Equalizer** is a Windows desktop GUI for [Equalizer APO](https://sourceforge.net/projects/equalizerapo/). It is an Electron app (no React, no Vue — vanilla JavaScript + Vite).

Users use it to:
- Edit parametric/graphic EQ filters and save them to Equalizer APO's `config.txt`
- Load AutoEQ headphone targets and generate matching filters automatically
- Browse Squiglink measurements and headphone frequency responses
- Use VST plugins, convolution, loudness correction, hardware PEQ transfer

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 41 |
| Bundler | Vite 6 |
| UI | Vanilla JavaScript (no framework) |
| Styling | Plain CSS with custom properties |
| Build output | Windows `.exe` (portable + NSIS installer) |
| Package manager | npm |

**There is no React, Vue, Angular, or TypeScript.** Do not introduce them.

---

## Project Structure

```
electron/
  main.js          Main process — window creation, IPC handlers, file I/O, APO detection, auto-updater
  preload.js       Context bridge — exposes apoAPI and windowAPI to renderer

src/
  main.js          Renderer entry point — ALL UI logic (~4600 lines)
  index.css        Design system + all component styles (~2900 lines)
  components/
    frequencyGraph.js    Canvas-based FR graph — drag bands, zoom, pan, curves (~1700 lines)
    parametricEQ.js      Parametric filter table — renders rows, handles input
    graphicEQ.js         Graphic EQ sliders
    autoEQEngine.js      AutoEQ optimizer — generates PEQ filters from target + measurement
    audioPlayer.js       Live EQ preview player (pink noise, white noise, file)
    targetLoader.js      Loads and parses EQ target curves
    targetAdjustments.js Bass/treble/tilt sliders applied before AutoEQ
    squiglink.js         Squiglink embedded browser panel
    squiglinkDB.js       Squiglink headphone database search
    hidDevice.js         Hardware PEQ USB/network transfer
    devicePeq/           Device-specific PEQ protocol handlers

  config/
    parser.js      Parses Equalizer APO config.txt text → JS object
    serializer.js  Serializes JS config object → Equalizer APO config.txt text

public/
  targets/         Bundled EQ target curve files (.txt)

assets/
  icon.svg         Logo source (edit this to change the icon)
  icon.ico/.png    Generated — do NOT edit manually, run `npm run icons`

docs/
  images/          README screenshots
  USAGE.md         Usage guide

scripts/
  generate-icons.mjs    Generates icon assets from icon.svg using sharp
  take-screenshots.ps1  Helper to auto-capture screenshots of the running app
```

---

## IPC Bridge (renderer ↔ main process)

The renderer calls main-process functions via two bridges exposed in `electron/preload.js`:

```javascript
window.apoAPI.readConfig(filePath)        // Read a file from disk
window.apoAPI.writeConfig(filePath, text) // Write a file to disk
window.apoAPI.getAPOPath()                // Detect Equalizer APO config dir
window.apoAPI.selectFile(options)         // Open file picker dialog
window.apoAPI.saveFile(content, options)  // Save file dialog
window.apoAPI.selectConfigDir()           // Pick config folder
window.apoAPI.listConfigFiles(dir)        // List files in a directory
window.apoAPI.fetchText(url, options)     // HTTP fetch (bypasses CORS)
window.apoAPI.listAudioDevices()          // List audio output devices
window.apoAPI.captureRegionImage(rect)    // Screenshot a screen region
window.apoAPI.openExternalUrl(url)        // Open URL in browser
window.apoAPI.getUpdaterState()           // Auto-updater state
window.apoAPI.checkForUpdates()
window.apoAPI.downloadUpdate()
window.apoAPI.installUpdate()
window.apoAPI.onUpdaterStatus(listener)   // Subscribe to updater events
window.apoAPI.backupUserData()            // Export user data zip
window.apoAPI.restoreUserData()           // Restore from zip

window.windowAPI.minimize()
window.windowAPI.maximize()
window.windowAPI.close()
```

**Never call `require('electron')` or `require('fs')` from `src/` files** — they run in the renderer process and must use the bridge.

---

## Central Patterns — READ BEFORE TOUCHING ANYTHING

### markDirty() — the hub for all EQ changes

Every time the EQ state changes (filter added/edited/removed, preamp moved, etc.) you **must** call `markDirty()`. It does three things:
1. Sets `appState.dirty = true`
2. Schedules auto-save to APO (if auto-save mode is on)
3. Schedules an auto-snapshot (debounced 8 s)

Do **not** call `updateStatus`, `scheduleAutoSnapshot`, or `scheduleAutoApply` directly — always go through `markDirty()`.

### saveConfig() — saving to APO

`async function saveConfig(options = {})` at line ~3453 in `src/main.js`.  
- Serializes the current config via `src/config/serializer.js`
- Writes the result to the APO `config.txt` via `window.apoAPI.writeConfig`
- Called by the Save button, `Ctrl+S`, and auto-save timer

### Undo/Redo stack

`undo()` and `redo()` in `src/main.js`. The stack entry is the full serialized config string. Push a snapshot before any multi-step operation. `markDirty()` does NOT push undo automatically — the individual edit handlers do.

### applyConfigObject(config, rawText)

Pushes the current state to undo stack, sets global config, re-renders all UI components, redraws the graph. Call this when loading a preset or restoring a snapshot.

---

## CSP Constraint — CRITICAL

Electron's Content Security Policy **blocks inline event handlers** set via `innerHTML`. This means:

```javascript
// ❌ BROKEN — onclick in innerHTML is silently ignored
container.innerHTML = `<button onclick="doThing()">Click</button>`;

// ✅ CORRECT — data attribute + delegated listener
container.innerHTML = `<button class="my-btn" data-value="${val}">Click</button>`;
container.addEventListener('click', e => {
  const btn = e.target.closest('.my-btn');
  if (btn) doThing(btn.dataset.value);
});
```

**Delegated listeners must be registered once in an `initXxx()` function**, not inside a render function that runs repeatedly — otherwise the listener accumulates on every render.

---

## Design System (CSS)

### Tokens (`:root` in `src/index.css`)

```css
/* Backgrounds (dark theme, darkest to lightest) */
--bg0: #030307    /* body background */
--bg1: #07070f    /* topbar, audio player */
--bg2: #0c0c18    /* panel area, tab strip */
--bg3: #111120    /* toolbar, filter header, cards */
--bg4: #161626
--bg-surface: #1a1a2c   /* inputs, selects */
--bg-hover: #202038     /* hover state */
--bg-border: rgba(255,255,255,0.075)
--bg-border-h: rgba(255,255,255,0.145)  /* hover border */

/* Accent colors */
--cyan: #00d4ff      /* primary accent — active, focus, brand */
--purple: #7c3aed    /* secondary accent */
--green: #10b981     /* success, connected, ready */
--red: #ef4444       /* error, danger, delete */
--orange: #f59e0b    /* warning */
--yellow: #eab308

/* Text */
--text-primary: #e6eaf4
--text-secondary: #8892a4
--text-muted: #50596a
--text-accent: var(--cyan)

/* Gradients */
--grad-brand: linear-gradient(135deg, var(--cyan) 0%, var(--purple) 100%)

/* Shadows / glows */
--shadow-sm / --shadow-md / --shadow-float
--glow-cyan / --glow-cyan-sm

/* Radii */
--radius-xs: 3px  --radius-sm: 5px  --radius-md: 8px  --radius-lg: 12px

/* Fonts */
--font-ui: 'Outfit', -apple-system, sans-serif
--font-mono: 'JetBrains Mono', monospace

/* Timing */
--t-fast: 130ms   --t-mid: 210ms
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)
```

### Color semantics — DO NOT BREAK

| Color | Use for | Never use for |
|-------|---------|---------------|
| `--cyan` | Active state, focused inputs, brand accent, interactive highlights | Static/neutral labels |
| `--green` | Connected, success, ready | Decorative or kicker text |
| `--red` | Error, danger, delete hover | |
| `--orange` | Warning | |
| `--text-muted` | Section labels, subtitles, neutral badges | |

### Standard control heights

All inputs, selects, and button-height controls: **28 px**. Do not introduce 27px or 30px variants.

### Button classes

| Class | Use |
|-------|-----|
| `.btn-save` | Primary "Save to APO" (gradient, prominent glow) |
| `.btn-primary` | Gradient brand button — primary action in a card/section |
| `.btn-accent` | Cyan tinted — secondary accent action |
| `.btn-ghost` | Neutral border — tertiary or list actions |
| `.icon-btn` | Square icon-only button (30×30) |

### Filter rows

`.filter-row` has `border: 1px solid transparent`. On hover: shows faint border. When `.selected`: cyan background + cyan border. Do NOT use `box-shadow: inset` alone for selected state — the border is required.

---

## Performance Rules

### frequencyGraph.js

- `_interpolateSplAt(data, freq)` uses **binary search** (O(log n)). Do NOT revert to a linear scan — the Comp Target mode calls this on every animation frame and a linear scan causes visible lag at 1000+ point measurement curves.
- `_smoothCurve(data)` uses a **WeakMap cache** keyed on the data object. If smoothing hasn't changed, it returns the cached result instantly. Do not remove this cache.
- Always call `freqGraph.render()` (not the canvas draw methods directly) — it checks `dirty` flags and skips redraws when nothing changed.

---

## Auto-Snapshot System

```
AUTO_SNAPSHOT_DELAY_MS = 8000   // 8 seconds after last change
AUTO_SNAPSHOT_MAX = 5            // max auto-snapshots kept per EQ mode
```

Auto-snapshots are prefixed with `🔄 Auto`. Manual snapshots are kept separately. When saving auto-snapshots, manual ones are never deleted. The auto list is capped at `AUTO_SNAPSHOT_MAX` (oldest dropped).

---

## EQ Modes

Three EQ modes exist, each with its own filter set and snapshot store:

| Mode key | Display name |
|----------|-------------|
| `'parametric'` | Parametric EQ |
| `'graphic'` | Graphic EQ |
| `'peq'` | Device PEQ (hardware) |

`currentEQMode` in `src/main.js` tracks the active mode. The snapshot history bar and auto-snapshot system both scope to `currentEQMode`.

---

## Build & Release Workflow

### Build

```bash
npm run dist        # generates Portable.exe + Setup.exe + Setup.exe.blockmap + latest.yml
```

Output in `release/`:
- `Neon-Equalizer-{version}-Portable.exe`
- `Neon-Equalizer-{version}-Setup.exe`
- `Neon-Equalizer-{version}-Setup.exe.blockmap`
- `latest.yml`

### Version bump

Edit `"version"` in `package.json` before building.

### Commit & push

**Always commit directly to `main`. Never create `release/vX.Y.Z` branches.**

```bash
git add <files>
git commit -m "vX.Y.Z: short description"
git push origin main
```

### GitHub release

```bash
# Copy latest.yml to a temp path so gh uploads it with the correct filename
cp release/latest.yml /tmp/latest.yml

gh release create "vX.Y.Z" \
  "release/Neon-Equalizer-X.Y.Z-Portable.exe" \
  "release/Neon-Equalizer-X.Y.Z-Setup.exe" \
  "release/Neon-Equalizer-X.Y.Z-Setup.exe.blockmap" \
  --latest \
  --title "Neon Equalizer vX.Y.Z — tagline" \
  --notes "..."

gh release upload "vX.Y.Z" /tmp/latest.yml --clobber
```

**The `latest.yml` file MUST be uploaded as exactly `latest.yml`** — the auto-updater (`electron-updater`) fetches this exact filename. Uploading it with any other name (e.g. `latest-2.0.17.yml`) breaks auto-updates silently.

### Auto-updater requirements per release

Every release that should support auto-update needs ALL of:
1. `latest.yml` — version manifest fetched by running app
2. `*-Setup.exe` — full installer
3. `*-Setup.exe.blockmap` — enables delta/differential downloads
4. The `latest.yml` inside the **latest** release is what ALL running app instances check against

---

## Known Issues / Past Mistakes to Avoid

| Mistake | What happened | Fix |
|---------|--------------|-----|
| Inline `onclick` in `innerHTML` | Silently ignored by Electron CSP — button does nothing | Use `data-*` attributes + delegated listener in `initXxx()` |
| Registering delegated listener inside a render function | Listener multiplies on every render, fires N times | Move listener registration to `initXxx()`, called once on DOMContentLoaded |
| Linear scan in `_interpolateSplAt` | O(n²) per frame with Comp Target → entire app lags | Binary search, already fixed — do not revert |
| Uploading `latest.yml` with a versioned name | Auto-updater cannot find it | Always upload as `latest.yml` exactly |
| Creating `release/vX.Y.Z` branches | Accumulates stale branches | Commit directly to `main` |
| Force-pushing `main` | Blocked by GitHub branch protection | Use PR or rebase+push |
| Adding `{ once: true }` to delegated listener | Fires once then disappears | Never use `{ once: true }` on delegated container listeners |
| Calling `require('fs')` or `require('electron')` in `src/` | Renderer process — no Node access | Use `window.apoAPI.*` bridge instead |

---

## UI Zoom System

Zoom levels: `[0.80, 0.88, 0.94, 1.00, 1.07, 1.15, 1.25]` (index 3 = 100% default).  
Applied as `document.documentElement.style.zoom = value`.  
Persisted in `localStorage` under key `'neonEqUiZoom'`.  
Buttons: `#btn-zoom-out` / `#btn-zoom-in` in the titlebar.  
Keyboard: `Ctrl+−` zoom out, `Ctrl++` zoom in, `Ctrl+0` reset.

---

## App-Level State

Key globals in `src/main.js`:

```javascript
appState = {
  dirty: false,          // unsaved changes exist
  configPath: null,      // path to active config.txt
  configDir: null,       // Equalizer APO config directory
  ...
}
currentEQMode            // 'parametric' | 'graphic' | 'peq'
autoSnapshotTimer        // setTimeout handle for auto-snapshot debounce
autoApplyTimer           // setTimeout handle for auto-save to APO debounce
```

---

## Dos and Don'ts

**Do:**
- Call `markDirty()` after any EQ state change
- Use CSS custom properties — never hardcode colors or sizes
- Use event delegation + `data-*` attributes for dynamically rendered lists
- Test that the Vite build passes (`npm run build`) before building the exe
- Bump `package.json` version before `npm run dist`
- Upload `latest.yml` as exactly `latest.yml` to GitHub releases

**Don't:**
- Introduce React, Vue, TypeScript, or any new runtime dependencies without discussing first
- Add inline `onclick`/`oninput` attributes in `innerHTML` strings
- Revert the binary search in `_interpolateSplAt` or remove the WeakMap cache in `_smoothCurve`
- Create `release/vX.Y.Z` branches — commit directly to `main`
- Hardcode pixel values that don't use `--radius-*`, `--t-*`, or `--font-*` tokens
- Use `var(--green)` for decorative/label text — green means connected/success only
- Use `var(--cyan)` as a neutral label color — cyan means active/accent
- Call `require('electron')` or `require('fs')` from any file under `src/`
