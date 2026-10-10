const { contextBridge, ipcRenderer } = require('electron')

/**
 * BCIS desktop preload bridge.
 *
 * The laboratory specification requires a narrow, typed preload surface. Node
 * integration stays disabled in the renderer, so this bridge is the only path
 * from React to the operating system. It deliberately exposes a fixed list of
 * operations instead of anything generic such as `invoke(channel, ...args)`,
 * which would hand the renderer the whole IPC surface.
 *
 * Every renderer-callable capability is enumerated in `desktopBridge()` below and
 * mirrored by the `BcisBridge` interface in
 * `renderer/src/types/bridge.d.ts`, so the renderer is type-checked against
 * exactly what this file grants.
 */

function desktopBridge() {
  return {
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    isPackaged: process.env.BCIS_PACKAGED === '1',

    /**
     * Read the persisted desktop configuration. This is how the three office
     * clients learn which server to talk to, which is the single most important
     * per-PC setting in the whole system.
     */
    getConfig: () => ipcRenderer.invoke('bcis:get-config'),

    /** Merge a partial configuration and persist it to userData/config.json. */
    setConfig: (patch) => ipcRenderer.invoke('bcis:set-config', patch),

    /**
     * Every LAN address this machine serves on. The office server uses this to
     * show the other two staff the exact URL to type into their client.
     */
    getLanUrls: () => ipcRenderer.invoke('bcis:get-lan-urls'),

    /** Test an API base URL without leaving the settings screen. */
    probeApi: (apiBase) => ipcRenderer.invoke('bcis:probe-api', apiBase),

    /** Open the folder holding backups, attachments or the API log. */
    openPath: (target) => ipcRenderer.invoke('bcis:open-path', target),

    /** Native save dialog; returns the chosen path, or null if cancelled. */
    saveFile: (options) => ipcRenderer.invoke('bcis:save-file', options),

    /** Native open dialog filtered to the supplied extensions. */
    pickFile: (options) => ipcRenderer.invoke('bcis:pick-file', options),

    /** Blocking confirm dialog for irreversible financial actions. */
    confirm: (options) => ipcRenderer.invoke('bcis:confirm', options),

    /** Informational / error message box. */
    message: (options) => ipcRenderer.invoke('bcis:message', options),

    /**
     * Print the current document. `mode: 'page'` strips the application chrome
     * and the sidebar first so route sheets, statements of account and
     * remittance sheets print cleanly on their own.
     */
    print: (mode) => ipcRenderer.invoke('bcis:print', mode),

    /**
     * Render the current view to a PDF file through the native save dialog.
     * This is the "export" counterpart to printing, available on every screen.
     * Resolves to the chosen path, or null if the operator cancelled.
     */
    exportPdf: (options) => ipcRenderer.invoke('bcis:export-pdf', options),

    /** Subscribe to main-process pushes (config changed, API child exited). */
    on: (channel, handler) => {
      const allowed = ['bcis:config-changed', 'bcis:api-status', 'bcis:menu-action']
      if (!allowed.includes(channel)) {
        throw new Error(`Unsupported bridge channel: ${channel}`)
      }
      const listener = (_event, payload) => handler(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('bcis', desktopBridge())
