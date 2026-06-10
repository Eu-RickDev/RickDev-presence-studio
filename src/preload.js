const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("presenceAPI", {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  connect: (config) => ipcRenderer.invoke("presence:connect", config),
  update: (config) => ipcRenderer.invoke("presence:update", config),
  disconnect: () => ipcRenderer.invoke("presence:disconnect"),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  onStatus: (callback) => ipcRenderer.on("presence:status", (_event, data) => callback(data))
});
