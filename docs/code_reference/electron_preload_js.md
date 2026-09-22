# Code Reference: `electron/preload.js`

> [!NOTE]
> This document provides an exhaustive breakdown of `electron/preload.js`.
> 
> **File Purpose:** This is the IPC (Inter-Process Communication) bridge. Because the main window is sandboxed (`nodeIntegration: false`), the frontend cannot require `fs`, `path`, or `child_process`. This file safely exposes specific backend methods to the frontend under global window objects.
> 
> **Can we live without it?** No. Without this bridge, the secure web frontend cannot read/write configurations or communicate with the OS.

---

## 1. Context Bridge Initialization
- **Line 1:** Imports `contextBridge` and `ipcRenderer` from Electron.

## 2. API Namespace: `window.apoAPI`
- **Lines 3-32:** Exposes backend features securely to the renderer under the `window.apoAPI` object. The frontend can call these asynchronous methods to ask the main process to do work.
  - **APO Integration:** `getAPOPath`, `readConfig`, `writeConfig`, `selectConfigDir`, `listConfigFiles`.
  - **File Operations:** `selectFile`, `saveFile`.
  - **Network & Fetch:** `fetchText` (the SSRF guarded web fetcher), `lanDeviceRequest` (the guarded local hardware connector).
  - **Hardware / External:** `listAudioDevices` (triggers the PowerShell script), `openExternalUrl`.
  - **Updater:** `getUpdaterState`, `checkForUpdates`, `downloadUpdate`, `installUpdate`, and `onUpdaterStatus` (which sets up an event listener to push progress bars to the UI).
  - **Backups:** `backupUserData`, `restoreUserData`, `openBackupFolder`.
  - **Presets:** `savePreset`, `getPresets`, `readPreset`, `deletePreset`.

## 3. API Namespace: `window.windowAPI`
- **Lines 34-38:** Exposes standard window controls.
  - `minimize`, `maximize`, `close`.
  - These map directly to IPC handles in `main.js` that control the bounds and visibility of the `BrowserWindow`.

---

### Potential Improvements for `electron/preload.js`:
1. **TypeScript Definitions:** Exposing these via `contextBridge` makes them available as `window.apoAPI`, but modern IDEs won't know the exact arguments or return types (e.g., `listAudioDevices()` returns an object with `{ok, devices}`). Generating an `index.d.ts` alongside this file would make frontend development significantly safer and more robust.
