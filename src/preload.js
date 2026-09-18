const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capcut', {
  status: () => ipcRenderer.invoke('status'),
  thumbnail: (mode, id, itemPath) => ipcRenderer.invoke('thumbnail', mode, id, itemPath),
  chooseRoot: () => ipcRenderer.invoke('choose-root'),
  choosePresetRoot: () => ipcRenderer.invoke('choose-preset-root'),
  openRoot: () => ipcRenderer.invoke('open-root'),
  openPresetRoot: () => ipcRenderer.invoke('open-preset-root'),
  revealLast: () => ipcRenderer.invoke('reveal-last'),
  exportProject: (name, format) => ipcRenderer.invoke('export-project', name, format),
  importProject: () => ipcRenderer.invoke('import-project'),
  exportPreset: (name, format) => ipcRenderer.invoke('export-preset', name, format),
  importPreset: () => ipcRenderer.invoke('import-preset'),
  libraryGet: () => ipcRenderer.invoke('library-get'),
  libraryAddClient: (input) => ipcRenderer.invoke('library-add-client', input),
  libraryAddFolder: (clientId, folder) => ipcRenderer.invoke('library-add-folder', clientId, folder),
  libraryAddPresetFolder: (folder) => ipcRenderer.invoke('library-add-preset-folder', folder),
  libraryDeletePresetFolder: (folder) => ipcRenderer.invoke('library-delete-preset-folder', folder),
  libraryDeleteClient: (id) => ipcRenderer.invoke('library-delete-client', id),
  libraryDeleteFolder: (clientId, folder) => ipcRenderer.invoke('library-delete-folder', clientId, folder),
  libraryUpdateItem: (id, patch) => ipcRenderer.invoke('library-update-item', id, patch),
  libraryUpdateItems: (ids, patch) => ipcRenderer.invoke('library-update-items', ids, patch),
  renameProject: (id, name) => ipcRenderer.invoke('rename-project', id, name),
  restartCapCut: () => ipcRenderer.invoke('restart-capcut'),
  recycleDelete: (id) => ipcRenderer.invoke('recycle-delete', id),
  onProgress: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on('operation-progress', listener); return () => ipcRenderer.removeListener('operation-progress', listener); },
  fontInfo: (mode, id) => ipcRenderer.invoke('font-info', mode, id),
  exportDetectedFonts: (mode, id) => ipcRenderer.invoke('export-detected-fonts', mode, id)
  ,driveStatus: () => ipcRenderer.invoke('drive-status')
  ,driveConnect: () => ipcRenderer.invoke('drive-connect')
  ,driveDisconnect: () => ipcRenderer.invoke('drive-disconnect')
  ,driveSetFolder: (value) => ipcRenderer.invoke('drive-set-folder', value)
  ,driveSyncSet: (mode, id, enabled, format) => ipcRenderer.invoke('drive-sync-set', mode, id, enabled, format)
  ,driveSyncNow: (mode, id) => ipcRenderer.invoke('drive-sync-now', mode, id)
  ,driveOpenFile: (id) => ipcRenderer.invoke('drive-open-file', id)
  ,onDriveComplete: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on('drive-sync-complete', listener); return () => ipcRenderer.removeListener('drive-sync-complete', listener); }
  ,onDriveError: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on('drive-sync-error', listener); return () => ipcRenderer.removeListener('drive-sync-error', listener); }
});
