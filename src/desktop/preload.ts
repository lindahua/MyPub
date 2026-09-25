import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DesktopState } from "./types.js";
const api: DesktopAPI = {
  state: () => ipcRenderer.invoke("mypub:get"),
  chooseLibrary: () => ipcRenderer.invoke("mypub:choose"),
  quit: () => ipcRenderer.invoke("mypub:quit"),
  retry: () => ipcRenderer.invoke("mypub:retry"),
  copyCitation: (library, publication) =>
    ipcRenderer.invoke("mypub:citation", library, publication),
  openAttachment: (library, publication, attachment) =>
    ipcRenderer.invoke("mypub:attachment", library, publication, attachment),
  loadPaperPdf: (library, publication, attachment) =>
    ipcRenderer.invoke("mypub:paper-pdf", library, publication, attachment),
  openURL: (url) => ipcRenderer.invoke("mypub:url", url),
  addTodo: (library, title, publication) => ipcRenderer.invoke("mypub:todo-add", library, title, publication),
  setTodoCompleted: (library, id, completed) => ipcRenderer.invoke("mypub:todo-set", library, id, completed),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopState) =>
      callback(state);
    ipcRenderer.on("mypub:state", listener);
    return () => ipcRenderer.removeListener("mypub:state", listener);
  },
};
contextBridge.exposeInMainWorld("mypub", api);
