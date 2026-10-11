// Sandboxed preload: the page's whole view of the desktop shell (the DesktopBridge in contract.ts).
const { contextBridge, ipcRenderer } = require('electron');

// The two channel names in contract.ts; a sandboxed preload cannot import it.
const DESKTOP_INVOKE_CHANNEL = 'desktop:invoke';
const DESKTOP_STATE_CHANNEL = 'desktop:state';

contextBridge.exposeInMainWorld('terraceDesktop', {
  invoke(method, ...args) {
    return ipcRenderer.invoke(DESKTOP_INVOKE_CHANNEL, method, ...args);
  },
  onState(listener) {
    // Main announces a change without a payload; the state this page may see is asked for.
    const handler = () => {
      void ipcRenderer.invoke(DESKTOP_INVOKE_CHANNEL, 'state').then(listener);
    };
    ipcRenderer.on(DESKTOP_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DESKTOP_STATE_CHANNEL, handler);
  },
});
