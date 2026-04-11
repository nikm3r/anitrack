const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showItemInFolder: (filePath) => ipcRenderer.invoke("show-item-in-folder", filePath),

  // MAL OAuth
  startMalAuth: (clientId, codeVerifier) => ipcRenderer.invoke("mal:start-auth", { clientId, codeVerifier }),
  onMalAuthCode: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("mal:auth-code", listener);
    return () => ipcRenderer.removeListener("mal:auth-code", listener);
  },

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke("updater:check"),
  updaterInstall: () => ipcRenderer.invoke("updater:install"),
  onUpdaterEvent: (callback) => {
    const events = [
      "updater:checking",
      "updater:available",
      "updater:not-available",
      "updater:progress",
      "updater:downloaded",
      "updater:error",
    ];
    const listeners = events.map(event => {
      const listener = (_e, data) => callback(event, data);
      ipcRenderer.on(event, listener);
      return { event, listener };
    });
    // Return cleanup function
    return () => listeners.forEach(({ event, listener }) => ipcRenderer.removeListener(event, listener));
  },
});
