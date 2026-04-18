const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, globalShortcut, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const APP_NAME = 'Neon Equalizer';
const LEGACY_APP_NAMES = ['Equalizer APO Studio', 'equalizer-apo-studio'];

app.setName(APP_NAME);

let mainWindow;
let tray = null;
const isDev = !app.isPackaged;
const presetsDir = path.join(app.getPath('userData'), 'presets');

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
