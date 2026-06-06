const { ipcRenderer } = require('electron');

// Direct window assignment (works with nodeIntegration: true, contextIsolation: false)
window.api = {
  chatAdd: (payload) => ipcRenderer.invoke('chat:add', payload),
  chatGetRecent: (payload) => ipcRenderer.invoke('chat:get-recent', payload),
  chatGetCount: (payload) => ipcRenderer.invoke('chat:get-count', payload),
  chatGetSinceRound: (payload) => ipcRenderer.invoke('chat:get-since-round', payload),
  ltmSave: (record) => ipcRenderer.invoke('ltm:save', record),
  ltmSearch: (query) => ipcRenderer.invoke('ltm:search', query),
  ltmGetPreload: (payload) => ipcRenderer.invoke('ltm:get-preload', payload),
  ltmGetLatest: (payload) => ipcRenderer.invoke('ltm:get-latest', payload),
  configGet: (key) => ipcRenderer.invoke('config:get', key),
  configSet: (payload) => ipcRenderer.invoke('config:set', payload),
  configGetAll: () => ipcRenderer.invoke('config:get-all'),
  stateGet: (key) => ipcRenderer.invoke('state:get', key),
  stateSet: (payload) => ipcRenderer.invoke('state:set', payload),
  ping: () => ipcRenderer.invoke('coco:ping'),
  // First-run setup: save config.json from dialog (dmg users)
  initSaveConfig: (config) => ipcRenderer.invoke('init:save-config', config),
  getDataRoot: () => ipcRenderer.invoke('app:get-data-root'),
  configWriteFile: () => ipcRenderer.invoke('config:write-file'),
};