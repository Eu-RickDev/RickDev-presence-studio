const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("presenceAPI", {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  exportProfiles: () => ipcRenderer.invoke("profiles:export"),
  importProfiles: () => ipcRenderer.invoke("profiles:import"),
  lookupApplication: (clientId) => ipcRenderer.invoke("application:lookup", clientId),
  connect: (config) => ipcRenderer.invoke("presence:connect", config),
  disconnect: () => ipcRenderer.invoke("presence:disconnect"),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  watchMusic: (enabled) => ipcRenderer.invoke("music:watch", enabled),
  onStatus: (callback) => ipcRenderer.on("presence:status", (_event, data) => callback(data)),
  onMusicState: (callback) => ipcRenderer.on("music:state", (_event, data) => callback(data)),
  onProfileSelected: (callback) => ipcRenderer.on("profiles:selected", (_event, index) => callback(index)),
  onUpdateAvailable: (callback) => ipcRenderer.on("update:available", (_event, data) => callback(data))
});
