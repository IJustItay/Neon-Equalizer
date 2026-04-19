const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apoAPI', {
  getAPOPath: () => ipcRenderer.invoke('get-apo-path'),
  readConfig: (filePath) => ipcRenderer.invoke('read-config', filePath),
  writeConfig: (filePath, content) => ipcRenderer.invoke('write-config', filePath, content),
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  saveFile: (content, options) => ipcRenderer.invoke('save-file', content, options),
  selectConfigDir: () => ipcRenderer.invoke('select-config-dir'),
  listConfigFiles: (dirPath) => ipcRenderer.invoke('list-config-files', dirPath),
  fetchText: (url, options) => ipcRenderer.invoke('fetch-url-text', url, options),
  listAudioDevices: () => ipcRenderer.invoke('list-audio-devices'),
  captureRegionImage: (rect, options) => ipcRenderer.invoke('capture-region-image', rect, options),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  getUpdaterState: () => ipcRenderer.invoke('updater-get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater-check'),
  downloadUpdate: () => ipcRenderer.invoke('updater-download'),
  installUpdate: () => ipcRenderer.invoke('updater-install'),
  onUpdaterStatus: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on('updater-status', listener);
    return () => ipcRenderer.removeListener('updater-status', listener);
  },
  backupUserData: () => ipcRenderer.invoke('user-data-backup'),
  restoreUserData: () => ipcRenderer.invoke('user-data-restore'),
  openBackupFolder: () => ipcRenderer.invoke('user-data-open-backups'),
  savePreset: (name, content) => ipcRenderer.invoke('save-preset', name, content),
  getPresets: () => ipcRenderer.invoke('get-presets'),
  readPreset: (name) => ipcRenderer.invoke('read-preset', name),
  deletePreset: (name) => ipcRenderer.invoke('delete-preset', name)
});

contextBridge.exposeInMainWorld('windowAPI', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close')
});
