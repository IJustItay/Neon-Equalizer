const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, globalShortcut, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const { autoUpdater } = require('electron-updater');
const AdmZip = require('adm-zip');

const APP_NAME = 'Neon Equalizer';
const LEGACY_APP_NAMES = ['Equalizer APO Studio', 'equalizer-apo-studio'];

app.setName(APP_NAME);

let mainWindow;
let tray = null;
const isDev = !app.isPackaged;
const presetsDir = path.join(app.getPath('userData'), 'presets');
const backupDir = path.join(app.getPath('documents'), 'Neon Equalizer Backups');
const updateState = {
  status: 'idle',
  canAutoInstall: false,
  isPortable: false,
  version: app.getVersion(),
  latestVersion: null,
  message: 'Updater is starting...',
  progress: null,
  releaseUrl: 'https://github.com/IJustItay/Neon-Equalizer/releases/latest',
  error: null
};
const volatileUserDataDirs = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'ShaderCache',
  'Crashpad',
  'logs'
]);

app.commandLine.appendSwitch('enable-experimental-web-platform-features');

function getAssetPath(...segments) {
  return path.join(__dirname, '..', 'assets', ...segments);
}

function getAppIconPath(preferredFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png') {
  const preferredPath = getAssetPath(preferredFile);
  if (fs.existsSync(preferredPath)) return preferredPath;

  const fallbackPath = getAssetPath('icon.png');
  return fs.existsSync(fallbackPath) ? fallbackPath : null;
}

function createTrayIcon() {
  const iconPath = getAppIconPath();
  if (!iconPath) return nativeImage.createEmpty();

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function publishUpdateState(patch = {}) {
  Object.assign(updateState, patch);
  sendToRenderer('updater-status', { ...updateState });
  return { ...updateState };
}

function updateInfoVersion(info) {
  return info?.version || info?.tag || info?.releaseName || null;
}

function configureAutoUpdater() {
  updateState.isPortable = isPortableBuild();
  updateState.canAutoInstall = app.isPackaged && process.platform === 'win32' && !updateState.isPortable;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    publishUpdateState({
      status: 'checking',
      message: 'Checking for updates...',
      progress: null,
      error: null
    });
  });

  autoUpdater.on('update-available', (info) => {
    publishUpdateState({
      status: 'available',
      latestVersion: updateInfoVersion(info),
      releaseUrl: info?.releaseNotes ? updateState.releaseUrl : updateState.releaseUrl,
      message: `Version ${updateInfoVersion(info) || 'new'} is ready to download.`,
      progress: null,
      error: null
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    publishUpdateState({
      status: 'current',
      latestVersion: updateInfoVersion(info) || app.getVersion(),
      message: 'You are up to date.',
      progress: null,
      error: null
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)));
    publishUpdateState({
      status: 'downloading',
      message: `Downloading update... ${percent.toFixed(0)}%`,
      progress: {
        percent,
        transferred: progress?.transferred || 0,
        total: progress?.total || 0,
        bytesPerSecond: progress?.bytesPerSecond || 0
      },
      error: null
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateState({
      status: 'downloaded',
      latestVersion: updateInfoVersion(info) || updateState.latestVersion,
      message: 'Update downloaded. Restart to install it.',
      progress: { percent: 100 },
      error: null
    });
  });

  autoUpdater.on('error', (error) => {
    publishUpdateState({
      status: 'error',
      message: updateState.canAutoInstall
        ? `Updater error: ${error.message}`
        : 'Portable builds cannot install updates in-place. Use the installer build for automatic updates.',
      error: error.message,
      progress: null
    });
  });

  if (!updateState.canAutoInstall) {
    publishUpdateState({
      status: updateState.isPortable ? 'portable' : 'manual',
      message: updateState.isPortable
        ? 'Portable builds can check GitHub, but in-place installation needs the Setup build.'
        : 'Automatic installation is available in packaged Windows installer builds.',
      progress: null
    });
    return;
  }

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      publishUpdateState({
        status: 'error',
        message: `Update check failed: ${error.message}`,
        error: error.message,
        progress: null
      });
    });
  }, 2500);
}

function safeBackupName(prefix = 'Neon-Equalizer-user-data') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}.zip`;
}

function shouldSkipUserDataEntry(entryPath, userDataPath) {
  const relative = path.relative(userDataPath, entryPath);
  const first = relative.split(path.sep)[0];
  return !relative || relative.startsWith('..') || volatileUserDataDirs.has(first);
}

function addUserDataToZip(zip, entryPath, userDataPath, skipped) {
  if (shouldSkipUserDataEntry(entryPath, userDataPath)) return;
  let stat;
  try {
    stat = fs.statSync(entryPath);
  } catch (error) {
    skipped.push({ path: entryPath, reason: error.message });
    return;
  }

  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entryPath)) {
      addUserDataToZip(zip, path.join(entryPath, child), userDataPath, skipped);
    }
    return;
  }

  if (!stat.isFile()) return;

  const relative = path.relative(userDataPath, entryPath).replace(/\\/g, '/');
  try {
    zip.addFile(`userData/${relative}`, fs.readFileSync(entryPath));
  } catch (error) {
    skipped.push({ path: relative, reason: error.message });
  }
}

function createUserDataBackup(options = {}) {
  const userDataPath = app.getPath('userData');
  const targetDir = options.dirPath || backupDir;
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = options.filePath || path.join(targetDir, safeBackupName(options.prefix));
  const zip = new AdmZip();
  const skipped = [];
  const manifest = {
    app: APP_NAME,
    version: app.getVersion(),
    createdAt: new Date().toISOString(),
    reason: options.reason || 'manual',
    userDataPath,
    format: 1
  };

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  addUserDataToZip(zip, userDataPath, userDataPath, skipped);
  if (skipped.length) {
    zip.addFile('skipped-files.json', Buffer.from(JSON.stringify(skipped, null, 2), 'utf8'));
  }
  zip.writeZip(targetPath);
  return { success: true, path: targetPath, skipped: skipped.length, size: fs.statSync(targetPath).size };
}

function copyDirectoryContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function validateBackupEntries(zip) {
  for (const entry of zip.getEntries()) {
    const normalized = entry.entryName.replace(/\\/g, '/');
    if (
      normalized.startsWith('/') ||
      normalized.includes('../') ||
      normalized === '..' ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw new Error('Backup contains an unsafe path.');
    }
  }
}

function removeDirectorySafe(dirPath, expectedParent) {
  const resolved = path.resolve(dirPath);
  const parent = path.resolve(expectedParent);
  if (!resolved.startsWith(parent + path.sep)) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function performRestoreAndRelaunch(zipPath) {
  const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'neon-restore-'));
  try {
    app.isQuitting = true;
    for (const window of BrowserWindow.getAllWindows()) {
      window.destroy();
    }
    await new Promise(resolve => setTimeout(resolve, 400));

    createUserDataBackup({ prefix: 'Neon-Equalizer-before-restore', reason: 'pre-restore' });

    const zip = new AdmZip(zipPath);
    validateBackupEntries(zip);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('This is not a Neon Equalizer backup.');
    zip.extractAllTo(tempRoot, true);

    const extractedUserData = path.join(tempRoot, 'userData');
    if (!fs.existsSync(extractedUserData)) throw new Error('Backup does not contain user data.');
    copyDirectoryContents(extractedUserData, app.getPath('userData'));

    app.relaunch();
    app.quit();
  } catch (error) {
    dialog.showErrorBox('Restore failed', error.message);
    app.isQuitting = false;
  } finally {
    try { removeDirectorySafe(tempRoot, app.getPath('temp')); } catch (_) {}
  }
}

function directoryHasEntries(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
  } catch (e) {
    return false;
  }
}

function migrateLegacyPresets() {
  if (directoryHasEntries(presetsDir)) return;

  for (const legacyAppName of LEGACY_APP_NAMES) {
    const legacyPresetsDir = path.join(app.getPath('appData'), legacyAppName, 'presets');
    if (path.resolve(legacyPresetsDir) === path.resolve(presetsDir)) continue;
    if (!fs.existsSync(legacyPresetsDir)) continue;

    try {
      fs.mkdirSync(presetsDir, { recursive: true });
      for (const entry of fs.readdirSync(legacyPresetsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;

        const from = path.join(legacyPresetsDir, entry.name);
        const to = path.join(presetsDir, entry.name);
        if (!fs.existsSync(to)) {
          fs.copyFileSync(from, to);
        }
      }
      return;
    } catch (e) {
      console.warn('Preset migration skipped:', e.message);
    }
  }
}

function isTrustedAppOrigin(origin = '') {
  return origin === '' ||
    origin === 'file://' ||
    origin.startsWith('file://') ||
    origin.startsWith('http://localhost:5173') ||
    origin.startsWith('http://127.0.0.1:5173');
}

function listWindowsAudioDevices() {
  if (process.platform !== 'win32') return [];

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
  @{ Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render'; Flow = 'playback'; FlowLabel = 'Playback' },
  @{ Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture'; Flow = 'recording'; FlowLabel = 'Recording' }
)
$nameKeys = @(
  '{b3f8fa53-0004-438e-9003-51a46e139bfc},6',
  '{a45c254e-df1c-4efd-8020-67d146a850e0},14',
  '{a45c254e-df1c-4efd-8020-67d146a850e0},2'
)
$devices = foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root.Path)) { continue }
  foreach ($item in Get-ChildItem -LiteralPath $root.Path) {
    $deviceProps = Get-ItemProperty -LiteralPath $item.PSPath
    $propertyPath = Join-Path $item.PSPath 'Properties'
    if (-not (Test-Path -LiteralPath $propertyPath)) { continue }
    $props = Get-ItemProperty -LiteralPath $propertyPath
    $deviceNameProp = $props.PSObject.Properties | Where-Object { $_.Name -eq '{a45c254e-df1c-4efd-8020-67d146a850e0},2' } | Select-Object -First 1
    $connectionNameProp = $props.PSObject.Properties | Where-Object { $_.Name -eq '{b3f8fa53-0004-438e-9003-51a46e139bfc},6' } | Select-Object -First 1
    $deviceName = if ($deviceNameProp -and $deviceNameProp.Value) { [string]$deviceNameProp.Value } else { $null }
    $connectionName = if ($connectionNameProp -and $connectionNameProp.Value) { [string]$connectionNameProp.Value } else { $null }
    $name = if ($deviceName -and $connectionName -and $deviceName -notlike "*$connectionName*") { "$deviceName ($connectionName)" } elseif ($deviceName) { $deviceName } else { $connectionName }
    if (-not $name) {
      foreach ($key in $nameKeys) {
        $prop = $props.PSObject.Properties | Where-Object { $_.Name -eq $key } | Select-Object -First 1
        if ($prop -and $prop.Value) {
          $name = [string]$prop.Value
          break
        }
      }
    }
    if (-not $name) { continue }
    $guid = $null
    if ($item.PSChildName -match '\\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\}$') {
      $guid = $Matches[0]
    }
    $patternParts = @($deviceName, $connectionName, $guid) | Where-Object { $_ } | ForEach-Object { ([string]$_) -replace ';', ' ' -replace '\\s+', ' ' }
    $apoValue = ($patternParts -join ' ').Trim()
    if (-not $apoValue) { $apoValue = $name }
    [pscustomobject]@{
      id = $item.PSChildName
      name = $name
      deviceName = $deviceName
      connectionName = $connectionName
      guid = $guid
      apoValue = $apoValue
      flow = $root.Flow
      flowLabel = $root.FlowLabel
      state = [int]($deviceProps.DeviceState)
      active = ([int]($deviceProps.DeviceState) -eq 1)
    }
  }
}
$devices | Sort-Object flowLabel, name | ConvertTo-Json -Depth 4
`;

  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });

    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.warn('Audio device enumeration failed:', e.message);
    return [];
  }
}

// Auto-detect Equalizer APO config path
function getAPOConfigPath() {
  const defaultPaths = [
    'C:\\Program Files\\EqualizerAPO\\config',
    'C:\\Program Files (x86)\\EqualizerAPO\\config'
  ];

  // Try reading from registry
  try {
    const regPath = execSync(
      'reg query "HKLM\\SOFTWARE\\EqualizerAPO" /v ConfigPath',
      { encoding: 'utf8' }
    );
    const match = regPath.match(/ConfigPath\s+REG_SZ\s+(.+)/);
    if (match && fs.existsSync(match[1].trim())) {
      return match[1].trim();
    }
  } catch (e) {
    // Registry key not found, try default paths
  }

  for (const p of defaultPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    icon: getAppIconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Web device APIs: Device PEQ needs WebHID, Web Serial, and Web Bluetooth.
  const ses = mainWindow.webContents.session;
  const allowedDeviceTypes = new Set(['hid', 'serial', 'bluetooth']);
  const allowedPermissions = new Set(['hid', 'serial', 'bluetooth', 'bluetoothScanning']);

  ses.setDevicePermissionHandler((details) => (
    isTrustedAppOrigin(details.origin || '') && allowedDeviceTypes.has(details.deviceType)
  ));

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    const origin = requestingOrigin || details.securityOrigin || webContents?.getURL?.() || '';
    return isTrustedAppOrigin(origin) && allowedPermissions.has(permission);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const origin = details.requestingUrl || details.securityOrigin || webContents?.getURL?.() || '';
    callback(isTrustedAppOrigin(origin) && allowedPermissions.has(permission));
  });

  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList?.[0]?.deviceId || '');
  });

  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    callback(portList?.[0]?.portId || '');
  });

  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    callback(deviceList?.[0]?.deviceId || '');
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  migrateLegacyPresets();

  if (!fs.existsSync(presetsDir)) {
    fs.mkdirSync(presetsDir, { recursive: true });
  }

  configureAutoUpdater();

  // System Tray Setup
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  
  const updateTrayMenu = () => {
    const presets = getPresetsList();
    const presetItems = presets.map(p => ({
      label: p.name.replace('.txt', ''),
      click: () => applyPresetFromTray(p.name)
    }));
    
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show / Hide', click: () => {
         if (mainWindow.isVisible()) mainWindow.hide();
         else mainWindow.show();
      }},
      { type: 'separator' },
      { label: 'Apply Preset', submenu: presetItems.length > 0 ? presetItems : [{ label: 'No presets', enabled: false }] },
      { type: 'separator' },
      { label: 'Quit', click: () => {
          app.isQuitting = true;
          app.quit();
      }}
    ]);
    tray.setContextMenu(contextMenu);
  };
  
  updateTrayMenu();
  
  // Update tray when presets change
  fs.watch(presetsDir, () => {
    try { updateTrayMenu(); } catch(e){}
  });

  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });

  // Global Hotkey
  globalShortcut.register('CommandOrControl+Shift+E', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC Handlers
ipcMain.handle('get-apo-path', () => {
  return getAPOConfigPath();
});

ipcMain.handle('read-config', async (event, filePath) => {
  try {
    const configPath = filePath || path.join(getAPOConfigPath() || '', 'config.txt');
    if (!fs.existsSync(configPath)) {
      return { error: 'Config file not found', path: configPath };
    }
    const content = fs.readFileSync(configPath, 'utf8');
    return { content, path: configPath };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('write-config', async (event, filePath, content) => {
  try {
    const configPath = filePath || path.join(getAPOConfigPath() || '', 'config.txt');
    fs.writeFileSync(configPath, content, 'utf8');
    return { success: true, path: configPath };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('select-file', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || [
      { name: 'Audio Files', extensions: ['wav', 'flac', 'ogg', 'mp3'] },
      { name: 'Config Files', extensions: ['txt', 'cfg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('save-file', async (event, content, options) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options?.title || 'Save file',
      defaultPath: options?.defaultPath,
      filters: options?.filters || [
        { name: 'Text Files', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('fetch-url-text', async (event, url, options = {}) => {
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), options.timeout || 9000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': options.userAgent || 'Mozilla/5.0 EqualizerAPOStudio/2.0',
        'accept': 'text/plain,text/csv,application/javascript,*/*',
        ...(options.headers || {})
      },
      redirect: 'follow'
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

ipcMain.handle('list-audio-devices', async () => ({
  ok: true,
  devices: listWindowsAudioDevices()
}));

ipcMain.handle('capture-region-image', async (event, rect = {}, options = {}) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available');
    const viewport = {
      width: Math.round(rect.viewportWidth || 0),
      height: Math.round(rect.viewportHeight || 0)
    };
    if (viewport.width <= 0 || viewport.height <= 0) {
      const fallback = await mainWindow.webContents.executeJavaScript(
        '({ width: window.innerWidth, height: window.innerHeight })',
        true
      ).catch(() => null);
      viewport.width = Math.max(1, Math.round(fallback?.width || mainWindow.getContentBounds().width));
      viewport.height = Math.max(1, Math.round(fallback?.height || mainWindow.getContentBounds().height));
    }

    const requested = {
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      width: Math.round(rect.width || viewport.width),
      height: Math.round(rect.height || viewport.height)
    };
    const captureRect = {
      x: Math.max(0, Math.min(viewport.width - 1, requested.x)),
      y: Math.max(0, Math.min(viewport.height - 1, requested.y)),
      width: Math.max(1, requested.width),
      height: Math.max(1, requested.height)
    };
    captureRect.width = Math.min(captureRect.width, viewport.width - captureRect.x);
    captureRect.height = Math.min(captureRect.height, viewport.height - captureRect.y);
    if (captureRect.width < 32 || captureRect.height < 32) {
      throw new Error('Capture area is outside the visible app window');
    }

    const image = await mainWindow.webContents.capturePage(captureRect);
    if (!image || image.isEmpty()) throw new Error('Captured preview image is empty');
    clipboard.writeImage(image);

    const dir = path.join(app.getPath('temp'), 'EqualizerAPOStudio');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(options.name || 'squig-preview')
      .replace(/[^a-z0-9._ -]/gi, '_')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'squig-preview';
    const filePath = path.join(dir, `${safeName}-${Date.now()}.png`);
    fs.writeFileSync(filePath, image.toPNG());

    return { success: true, path: filePath, dataUrl: image.toDataURL(), copiedToClipboard: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-external-url', async (event, url) => {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only web URLs can be opened');
    await shell.openExternal(parsed.toString());
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('updater-get-state', () => ({ ...updateState }));

ipcMain.handle('updater-check', async () => {
  if (!updateState.canAutoInstall) {
    return publishUpdateState({
      status: updateState.isPortable ? 'portable' : 'manual',
      message: updateState.isPortable
        ? 'Portable builds cannot install updates in-place. Install the Setup build to use automatic updates.'
        : 'Automatic installation is available in packaged Windows installer builds.',
      progress: null
    });
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    return publishUpdateState({
      status: 'error',
      message: `Update check failed: ${error.message}`,
      error: error.message,
      progress: null
    });
  }
  return { ...updateState };
});

ipcMain.handle('updater-download', async () => {
  if (!updateState.canAutoInstall) {
    return publishUpdateState({
      status: updateState.isPortable ? 'portable' : 'manual',
      message: 'Use the Setup build to download and install updates automatically.',
      progress: null
    });
  }

  try {
    createUserDataBackup({ prefix: 'Neon-Equalizer-before-update', reason: 'pre-update-download' });
    publishUpdateState({ status: 'downloading', message: 'Starting update download...', progress: { percent: 0 }, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    return publishUpdateState({
      status: 'error',
      message: `Update download failed: ${error.message}`,
      error: error.message,
      progress: null
    });
  }
  return { ...updateState };
});

ipcMain.handle('updater-install', async () => {
  if (!updateState.canAutoInstall || updateState.status !== 'downloaded') {
    return publishUpdateState({
      status: updateState.status,
      message: 'No downloaded update is ready to install.',
      progress: updateState.progress
    });
  }

  try {
    createUserDataBackup({ prefix: 'Neon-Equalizer-before-install', reason: 'pre-update-install' });
    publishUpdateState({ status: 'installing', message: 'Restarting to install update...', progress: { percent: 100 }, error: null });
    app.isQuitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  } catch (error) {
    return publishUpdateState({
      status: 'error',
      message: `Update install failed: ${error.message}`,
      error: error.message,
      progress: null
    });
  }
  return { ...updateState };
});

ipcMain.handle('user-data-backup', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Neon Equalizer user data backup',
      defaultPath: path.join(backupDir, safeBackupName()),
      filters: [{ name: 'Neon Equalizer Backup', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return createUserDataBackup({ filePath: result.filePath, reason: 'manual' });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('user-data-restore', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Restore Neon Equalizer user data backup',
      properties: ['openFile'],
      filters: [{ name: 'Neon Equalizer Backup', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const zip = new AdmZip(result.filePaths[0]);
    validateBackupEntries(zip);
    const hasUserData = zip.getEntries().some(entry => entry.entryName.startsWith('userData/'));
    if (!zip.getEntry('manifest.json') || !hasUserData) {
      return { success: false, error: 'This backup does not look like a Neon Equalizer user data backup.' };
    }
    setTimeout(() => performRestoreAndRelaunch(result.filePaths[0]), 700);
    return { success: true, relaunching: true, path: result.filePaths[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('user-data-open-backups', async () => {
  fs.mkdirSync(backupDir, { recursive: true });
  const error = await shell.openPath(backupDir);
  return error ? { success: false, error } : { success: true, path: backupDir };
});

ipcMain.handle('select-config-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Equalizer APO Config Directory'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('list-config-files', async (event, dirPath) => {
  try {
    const configDir = dirPath || getAPOConfigPath();
    if (!configDir || !fs.existsSync(configDir)) return [];
    const files = fs.readdirSync(configDir)
      .filter(f => f.endsWith('.txt') || f.endsWith('.cfg'))
      .map(f => ({
        name: f,
        path: path.join(configDir, f),
        modified: fs.statSync(path.join(configDir, f)).mtime
      }));
    return files;
  } catch (e) {
    return [];
  }
});

// Window controls
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.handle('window-close', () => mainWindow.hide());

// Preset Management
function getPresetsList() {
  if (!fs.existsSync(presetsDir)) return [];
  return fs.readdirSync(presetsDir).filter(f => f.endsWith('.txt')).map(f => ({
      name: f,
      path: path.join(presetsDir, f)
  }));
}

function applyPresetFromTray(fileName) {
  const p = path.join(presetsDir, fileName);
  if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const apoPath = getAPOConfigPath();
      if (apoPath) {
          fs.writeFileSync(path.join(apoPath, 'config.txt'), content, 'utf8');
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(`loadConfigFromText(\`${content.replace(/`/g, '\\`')}\`); refreshUI();`).catch(()=>{});
      }
  }
}

ipcMain.handle('save-preset', (event, name, content) => {
  const safeName = name.replace(/[^a-z0-9א-ת \-]/gi, '_').trim() + '.txt';
  fs.writeFileSync(path.join(presetsDir, safeName), content, 'utf8');
  return true;
});

ipcMain.handle('get-presets', () => {
  return getPresetsList();
});

ipcMain.handle('read-preset', (event, name) => {
  const p = path.join(presetsDir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
});

ipcMain.handle('delete-preset', (event, name) => {
  const p = path.join(presetsDir, name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});
