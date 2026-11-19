const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("presenceAPI", {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  exportProfile: (index) => ipcRenderer.invoke("profiles:export", index),
  importProfile: (index) => ipcRenderer.invoke("profiles:import", index),
  lookupApplication: (clientId) => ipcRenderer.invoke("application:lookup", clientId),
  connect: (config) => ipcRenderer.invoke("presence:connect", config),
  disconnect: () => ipcRenderer.invoke("presence:disconnect"),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  watchMusic: (enabled) => ipcRenderer.invoke("music:watch", enabled),
  listProcesses: () => ipcRenderer.invoke("automation:processes"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  ready: () => ipcRenderer.send("ui:ready"),
  onStatus: (callback) => ipcRenderer.on("presence:status", (_event, data) => callback(data)),
  onMusicState: (callback) => ipcRenderer.on("music:state", (_event, data) => callback(data)),
  onProfileSelected: (callback) => ipcRenderer.on("profiles:selected", (_event, data) => callback(data)),
  onUpdateAvailable: (callback) => ipcRenderer.on("update:available", (_event, data) => callback(data)),
  onUpdateProgress: (callback) => ipcRenderer.on("update:progress", (_event, data) => callback(data))
});
