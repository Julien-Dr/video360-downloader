const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  toolsStatus: () => ipcRenderer.invoke("tools:status"),
  installYtdlp: () => ipcRenderer.invoke("tools:installYtdlp"),
  updateYtdlp: () => ipcRenderer.invoke("tools:updateYtdlp"),
  onInstallProgress: (cb) => ipcRenderer.on("tools:installProgress", (_e, d) => cb(d)),
  analyze: (opts) => ipcRenderer.invoke("video:analyze", opts),
  download: (opts) => ipcRenderer.invoke("video:download", opts),
  cancel: (jobId) => ipcRenderer.invoke("video:cancel", jobId),
  onProgress: (cb) => ipcRenderer.on("video:progress", (_e, d) => cb(d)),
  chooseFolder: (current) => ipcRenderer.invoke("dialog:chooseFolder", current),
  defaultFolder: () => ipcRenderer.invoke("app:defaultFolder"),
  showItem: (p) => ipcRenderer.invoke("shell:showItem", p),
  openExternal: (u) => ipcRenderer.invoke("shell:openExternal", u),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  openVideo: () => ipcRenderer.invoke("dialog:openVideo"),
  fileUrl: (p) => ipcRenderer.invoke("video:fileUrl", p),
});
