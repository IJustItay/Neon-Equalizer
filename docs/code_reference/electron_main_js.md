# Code Reference: `electron/main.js`

> [!NOTE]
> This document provides an exhaustive, function-by-function breakdown of `electron/main.js`. 
> 
> **File Purpose:** This is the entry point for the Electron Main Process. It handles system-level integrations (Tray, Global Shortcuts, Audio Device detection via PowerShell) and acts as the bridge between the sandboxed renderer (`src/main.js`) and the OS filesystem (reading/writing `config.txt`).
> 
> **Can we live without it?** No. Electron apps require a main process, and Neon-Equalizer specifically needs it to bypass browser sandboxes to interact with Equalizer APO config directories and local Windows audio devices.

---

## 1. App Initialization & Single Instance Lock
- **Lines 13-20:** Sets the app name (`Neon Equalizer`) and requests a single instance lock (`app.requestSingleInstanceLock()`). If another instance of the app is already running, this second instance immediately quits.

## 2. Global Variables & Constants
- `mainWindow`, `tray`, `trayMenuRefreshTimer`: Store the window and tray instances.
- `updateState`: Tracks the current state of `electron-updater` (status, version, download progress).
- `QUICK_EQ_PROFILES`: An array defining built-in quick EQ settings (Flat, Bass Boost, Treble Boost, Vocal Enhance, V-Shape, Loudness) along with their global keyboard shortcuts (`CommandOrControl+Alt+1`, etc.).

## 3. Window Creation (`createWindow`)
- **`createWindow()`**: Initializes the `BrowserWindow`. 
  - Sets up the `preload.js` script.
  - Implements strict security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  - Configures the `session` permissions to handle WebHID, Web Serial, and Web Bluetooth safely, verifying that the requesting origin is the trusted app origin.
  - **Navigation Hardening:** Listens to `will-navigate` and `setWindowOpenHandler` to prevent the Electron window from loading external URLs, forcing external links to open in the user's default browser (`shell.openExternal`).

## 4. Tray & Shortcuts
- **`createTrayIcon()`**: Helper to get the correct icon for the tray.
- **`buildDeviceTrayItems()`**: Calls the PowerShell audio device enumeration and builds a submenu for the tray allowing users to quickly switch the APO target device.
- **`updateTrayMenu()`**: Rebuilds the tray context menu, populating it with Quick EQs, Presets, Preamp controls (Raise/Lower), Target Devices, and basic app controls (Show/Hide, Quit).
- **`registerGlobalShortcuts()`**: Registers system-wide hotkeys (e.g., `Ctrl+Alt+Up` to raise preamp globally).
- **`setupWindowsUserTasks()`**: Uses `app.setUserTasks` to add jump list tasks to the Windows taskbar icon (e.g., right-click the taskbar icon to apply "Bass Boost" without fully opening the app).
- **`handleCommandArgs(argv)`**: Processes command-line arguments (like `--quick-eq=bass-boost`) allowing the app to run headlessly to apply a profile and exit.

## 5. OS Integration & Audio Devices
- **`listWindowsAudioDevices()`**: 
  - **Purpose:** A massive PowerShell script executed via `execFileSync`.
  - **Details:** It queries the Windows Registry (`HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render`) to find active and disabled audio playback/recording devices. It matches device names with their GUIDs and Connection Names to build strings that perfectly match Equalizer APO's `Device:` selection syntax.
  - **Improvement:** Spawning `powershell.exe` synchronously blocks the main thread. This could be migrated to `execFile` asynchronously, or written as a native C++ Node extension to significantly boost performance.

## 6. Config I/O (APO Interactions)
- **`getAPOConfigPath()`**: Checks default paths (`C:\Program Files\EqualizerAPO\config`) and the Registry to find where APO is installed.
- **`readMainConfigText()`** & **`writeMainConfigText(content, message)`**: Reads and writes to `config.txt`. `writeMainConfigText` also calls `refreshRendererConfig()` to ensure if the file is changed from the tray, the main UI window updates live.
- **`extractDeviceTarget()` / `extractPreamp()` / `upsertDirectiveLine()`**: Small string parsers that allow the Tray menu to modify *just* the Preamp or *just* the Device line of the `config.txt` file without breaking the rest of the user's filters.

## 7. Updater & Backups
- **`configureAutoUpdater()`**: Uses `electron-updater` to check GitHub releases. Maps events (`checking-for-update`, `update-available`, `download-progress`) into state updates that are pushed to the renderer via IPC (`sendToRenderer('updater-status')`).
- **`createUserDataBackup()`**: Uses `adm-zip` to recursively zip the Electron `userData` directory (skipping volatile caches like `GPUCache`), saving presets and settings.
- **`performRestoreAndRelaunch()`**: Unzips a backup to a temp directory, replaces the `userData` folder, and force-relaunches the application.

## 8. Security & Fetch Proxy
- **`isPrivateIp(address)`** & **`publicOnlyLookup()`**: Security functions preventing Server-Side Request Forgery (SSRF). When the app fetches a target curve from an external URL, this ensures the DNS resolution only hits public IPs, completely blocking malicious requests to `localhost`, `127.0.0.1`, or local LAN IPs (like `192.168.x.x`).
- **`lanOnlyLookup()`**: The inverse of the above, used specifically for hardware PEQ pushing (WiiM devices), ensuring the app ONLY talks to devices on the local network.
- **`guardedHttpText()`**: A custom, highly defensive HTTP request function that follows redirects manually, checking every hop against the DNS filters to prevent DNS rebinding attacks.

## 9. IPC Handlers
- Hundreds of lines defining `handleApp('channel-name')`. These handlers map the secure `preload.js` API calls to the main process functions defined above (e.g., `get-apo-path`, `read-config`, `write-config`, `select-file`, `save-file`, `fetch-url-text`, `capture-region-image`).
- Notably, `handleApp` wraps standard `ipcMain.handle` with an `isAppSender()` check to ensure the IPC call is coming exactly from our trusted `index.html` and not an injected frame.

---

### Potential Improvements for `electron/main.js`:
1. **File Splitting:** The file is monolithic (1500+ lines). Logic related to the SSRF HTTP proxy, the Auto Updater, and the PowerShell audio device fetcher should be broken out into separate modules (e.g., `electron/network.js`, `electron/updater.js`, `electron/audio-devices.js`).
2. **Async PowerShell:** The `listWindowsAudioDevices` blocks the main thread. It should be refactored to be completely asynchronous.
