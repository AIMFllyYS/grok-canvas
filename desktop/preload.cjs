const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokDesktop", {
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
});
