import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopState } from "./types.js";
const api: DesktopAPI = {
  state: () => ipcRenderer.invoke("mypub:get"),
  chooseLibrary: () => ipcRenderer.invoke("mypub:choose"),
  retry: () => ipcRenderer.invoke("mypub:retry"),
  copyCitation: (library, publication) =>
    ipcRenderer.invoke("mypub:citation", library, publication),
  openAttachment: (library, publication, attachment) =>
    ipcRenderer.invoke("mypub:attachment", library, publication, attachment),
  openURL: (url) => ipcRenderer.invoke("mypub:url", url),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopState) =>
      callback(state);
    ipcRenderer.on("mypub:state", listener);
    return () => ipcRenderer.removeListener("mypub:state", listener);
  },
};
contextBridge.exposeInMainWorld("mypub", api);
