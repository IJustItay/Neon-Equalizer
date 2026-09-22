# Code Reference: `src/state/` Modules

The `src/state/` directory contains modules responsible for managing the application's state, persistence, event routing, and undo/redo history. It extracts these responsibilities out of the monolithic UI controllers.

## 1. `src/state/profiles.js`

This module is the unified persistence layer for the application. It handles saving, loading, and migrating EQ configurations and application settings to and from the browser's `localStorage`.

### Architecture & Unification
Prior to this module, the app had six overlapping save systems. `profiles.js` unified everything under a single declarative source of truth: the `SETTINGS_REGISTRY`.

*   **Registry**: An array defining every configurable setting (e.g., UI Zoom, Auto-save, Theme), its data type (`boolean`, `number`, `json`, `string`), its fallback default, and crucially, its **scope** (`app` vs `profile`).
*   **Scopes**:
    *   `app`: Global settings that belong to the machine/session (like UI zoom or theme). Loading an EQ profile should *never* overwrite these.
    *   `profile`: Settings that travel with the EQ configuration (like surround sound configuration or auto-save preferences).
*   **Data Models**:
    *   **Profile**: A full JSON object capturing the EQ config + `profile`-scoped settings.
    *   **Device Profiles**: The exact same schema as a Profile, but bound to a specific Windows Audio Device name. This ensures that when the user switches hardware, the app restores their preferred EQ *and* settings for that device.

### Core Methods
*   `getSetting(id)`, `setSetting(id, value)`: Typed getters/setters that read/write from `localStorage` based on the registry definition.
*   `saveProfile()`, `getProfile()`, `listProfiles()`, `deleteProfile()`: CRUD operations for user-named profiles.
*   `setDeviceProfile()`, `getDeviceProfiles()`: CRUD operations for hardware-bound automatic profiles.
*   `summarizeProfile(profile)`: An important UI helper. Instead of showing an opaque "Profile Saved" text, this generates a human-readable summary (e.g., `12 filters (10 on) · graphic EQ 15-band · preamp -4.0 dB`) describing exactly what is captured in the profile.

---

## 2. `src/state/store.js`

This file provides lightweight, observable store primitives. It replaces the need for heavy state-management libraries like Redux while still keeping state changes decoupled from DOM updates.

### `Emitter` (Pub/Sub)
A minimal synchronous event emitter (`appBus`).
*   Components can subscribe (`appBus.on('event', callback)`) and publish (`appBus.emit('event', payload)`).
*   Used primarily to broadcast state changes across isolated UI components without tightly coupling them together.

### `History` (Undo/Redo)
A generic, bounded undo/redo stack (`history`).
*   Configured with a maximum limit (default 50 steps) to prevent memory leaks.
*   It operates on opaque snapshots. In `main.js`, whenever the EQ is modified, the app pushes `JSON.stringify(appState.config)` to `history.push()`. Undo pops the string and `JSON.parse`s it back into state.

### `createRefresher` (Scoped Rendering)
Since the app uses vanilla DOM manipulation instead of React, updating the UI safely and performantly is critical.
*   `REFRESH`: An enum defining canonical "refresh zones" (e.g., `PARAMETRIC`, `GRAPHIC`, `GRAPH`, `PREAMP`).
*   `createRefresher(refreshersMap)`: Builds a dispatcher function.
*   **Usage**: Instead of a monolithic `render()` that tears down the entire DOM, the app calls `refresh(REFRESH.GRAPH)` to only redraw the `<canvas>`, or `refresh(REFRESH.ALL)` to tear down and rebuild everything. This significantly improves UI responsiveness.
