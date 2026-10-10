const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { URL } = require('node:url')

/**
 * BCIS desktop main process.
 *
 * The deployment model in the specification is one office server holding the
 * database, plus two client machines. A client therefore has to be told which
 * server to talk to, and that value must be configurable per PC rather than
 * compiled into the bundle. It is persisted in `userData/config.json` and is
 * changeable at runtime from the client's Settings screen.
 */

const WINDOW_TITLE = 'BCIS Subscription Billing and Collection System'
const CONFIG_FILE = 'config.json'

const DEFAULT_CONFIG = {
  /** Where this client sends API requests. */
  apiBase: 'http://127.0.0.1:3001',
  /** Start the API as a child of this app (office-server role only). */
  launchApiLocally: false,
  apiPort: 3001,
  /** Extra origins the API should accept, for the LAN clients. */
  corsOrigins: [],
  /** Remember the signed-in operator between restarts. */
  rememberOperator: true
}

const configPath = () => path.join(app.getPath('userData'), CONFIG_FILE)

let config = { ...DEFAULT_CONFIG }
let apiProcess = null
let mainWindow = null

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      config = { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[bcis] config.json unreadable, falling back to defaults:', error.message)
    }
    config = { ...DEFAULT_CONFIG }
  }
  return config
}

function writeConfig() {
  return fsp.mkdir(path.dirname(configPath()), { recursive: true }).then(() =>
    fsp.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
  )
}

/**
 * Normalise whatever the user typed into a usable origin. Tolerant on purpose:
 * a cashier pasting `192.168.1.20:3001` should not have to know about schemes.
 */
function normalizeApiBase(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Server address is required.')
  }
  const withScheme = /^https?:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`
  const parsed = new URL(withScheme)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Server address must be http:// or https://')
  }
  if (!parsed.hostname) {
    throw new Error('Server address is missing a host name.')
  }
  return `${parsed.protocol}//${parsed.host}`
}

/** Every non-internal IPv4 address, so the server can show staff a usable URL. */
function lanUrls(port) {
  const urls = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`)
      }
    }
  }
  return [...new Set(urls)]
}

function probeApi(apiBase) {
  const base = normalizeApiBase(apiBase)
  return new Promise((resolve) => {
    const request = http.get(`${base}/health`, { timeout: 4000 }, (response) => {
      response.resume()
      resolve({ ok: response.statusCode === 200, status: response.statusCode, apiBase: base })
    })
    request.on('timeout', () => {
      request.destroy()
      resolve({ ok: false, status: 0, apiBase: base, error: 'Timed out. Is the BCIS server running?' })
    })
    request.on('error', (error) => {
      resolve({ ok: false, status: 0, apiBase: base, error: error.message })
    })
  })
}

/**
 * Start the API in-process as a child of the desktop app. Only the office
 * server does this; the two client machines never spawn a server.
 */
function startApiChild() {
  if (apiProcess || !config.launchApiLocally) {
    return
  }

  const candidates = [
    path.join(__dirname, '..', '..', '..', 'api', 'dist', 'server.js'),
    path.join(__dirname, '..', 'api', 'dist', 'server.js')
  ]
  const entry = candidates.find((candidate) => fs.existsSync(candidate))

  if (!entry) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'BCIS server',
      message: 'The bundled API build was not found.',
      detail: 'Run "npm run build" in the source folder, or turn off "Run the BCIS server on this computer" if this machine is a client only.'
    })
    config.launchApiLocally = false
    writeConfig()
    return
  }

  /*
   * `null` is the Origin a packaged renderer sends: it loads over file://, which
   * gives the page an opaque origin. Without this the client can reach the API
   * but the browser refuses to hand it the response, so every screen fails with
   * a CORS error while the server log looks healthy.
   */
  const corsOrigins = [
    'null',
    ...(config.corsOrigins ?? []),
    'http://127.0.0.1:4173',
    'http://localhost:4173'
  ]

  apiProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      /*
       * Under Electron, `process.execPath` is electron.exe, not node.exe, so
       * spawning it would start a second copy of the desktop app instead of the
       * API. This variable tells the same binary to behave as plain Node.
       */
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      API_PORT: String(config.apiPort),
      API_HOST: '0.0.0.0',
      CORS_ORIGINS: corsOrigins.join(',')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const forward = (stream, level) => {
    stream?.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) {
        console.log(`[api:${level}] ${text}`)
        mainWindow?.webContents.send('bcis:api-status', { state: 'running', line: text })
      }
    })
  }
  forward(apiProcess.stdout, 'out')
  forward(apiProcess.stderr, 'err')

  apiProcess.on('exit', (code) => {
    apiProcess = null
    mainWindow?.webContents.send('bcis:api-status', { state: 'exited', code })
    if (code !== 0 && !app.isQuitting) {
      dialog.showErrorBox('BCIS server stopped', `The API process exited with code ${code}.`)
    }
  })
}

function buildMenu() {
  const send = (action) => mainWindow?.webContents.send('bcis:menu-action', action)

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Print Current View', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { label: 'Print Without Navigation', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('print-page') },
        { type: 'separator' },
        { label: 'Export Current View to PDF', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send('navigate:dashboard') },
        { label: 'Subscribers', accelerator: 'CmdOrCtrl+2', click: () => send('navigate:subscribers') },
        { label: 'Receive Payment', accelerator: 'CmdOrCtrl+3', click: () => send('navigate:receive-payment') },
        { label: 'Collections', accelerator: 'CmdOrCtrl+4', click: () => send('navigate:collections') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
        {
          label: 'BCIS Documentation',
          click: () => shell.openPath(path.join(__dirname, '..', '..', '..', '..', 'docs'))
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  nativeTheme.themeSource = 'light'

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#f4f6fb',
    title: WINDOW_TITLE,
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  /**
   * Refuse to navigate anywhere except the bundled app. The renderer only ever
   * talks to the API over XHR/fetch, so any attempt to open an external page is
   * either a bug or a mistake worth stopping.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl && url.startsWith(devUrl)) {
      return
    }
    if (url.startsWith('file://')) {
      return
    }
    event.preventDefault()
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    /**
     * Resolve the built renderer relative to this file rather than assuming a
     * working directory, so the same code works from source, from `electron
     * .`, and from inside a packaged asar archive.
     */
    const candidates = [
      path.join(__dirname, 'renderer', 'dist', 'index.html'),
      path.join(__dirname, '..', 'renderer', 'dist', 'index.html')
    ]
    const indexHtml = candidates.find((candidate) => fs.existsSync(candidate))

    if (!indexHtml) {
      dialog.showErrorBox(
        'BCIS client',
        'The desktop interface has not been built yet.\n\nRun "npm run build" in the source folder, then start the app again.'
      )
      app.quit()
      return
    }

    mainWindow.loadFile(indexHtml)
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function registerIpc() {
  ipcMain.handle('bcis:get-config', () => config)

  ipcMain.handle('bcis:set-config', async (_event, patch = {}) => {
    if (typeof patch.apiBase === 'string' && patch.apiBase.trim() !== '') {
      config.apiBase = normalizeApiBase(patch.apiBase)
    }
    if (typeof patch.apiPort === 'number' && Number.isInteger(patch.apiPort) && patch.apiPort > 0) {
      config.apiPort = patch.apiPort
    }
    if (typeof patch.launchApiLocally === 'boolean') {
      config.launchApiLocally = patch.launchApiLocally
      if (config.launchApiLocally) {
        startApiChild()
      } else if (apiProcess) {
        apiProcess.kill()
        apiProcess = null
      }
    }
    if (Array.isArray(patch.corsOrigins)) {
      config.corsOrigins = patch.corsOrigins
        .map((origin) => String(origin).trim())
        .filter((origin) => origin !== '')
    }
    if (typeof patch.rememberOperator === 'boolean') {
      config.rememberOperator = patch.rememberOperator
    }

    await writeConfig()
    mainWindow?.webContents.send('bcis:config-changed', config)
    return config
  })

  ipcMain.handle('bcis:get-lan-urls', () => lanUrls(config.apiPort))

  ipcMain.handle('bcis:probe-api', (_event, apiBase) => probeApi(apiBase))

  ipcMain.handle('bcis:open-path', async (_event, target) => {
    const allowed = {
      userData: app.getPath('userData'),
      logs: path.join(app.getPath('userData'), 'logs'),
      backups: path.join(process.cwd(), 'var', 'backups')
    }
    const key = typeof target === 'string' ? target : 'userData'
    const resolved = allowed[key] ?? allowed.userData

    await fsp.mkdir(resolved, { recursive: true }).catch(() => {})
    const errorMessage = await shell.openPath(resolved)
    if (errorMessage) {
      throw new Error(errorMessage)
    }
    return resolved
  })

  ipcMain.handle('bcis:save-file', async (_event, options = {}) => {
    const { defaultPath, dataBase64, filters } = options
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath,
      filters: filters ?? [{ name: 'All files', extensions: ['*'] }]
    })
    if (canceled || !filePath) {
      return null
    }
    await fsp.writeFile(filePath, Buffer.from(dataBase64, 'base64'))
    return filePath
  })

  ipcMain.handle('bcis:pick-file', async (_event, options = {}) => {
    const { filters, multiple } = options
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: filters ?? [{ name: 'All files', extensions: ['*'] }]
    })
    if (canceled || filePaths.length === 0) {
      return null
    }

    return Promise.all(
      filePaths.map(async (filePath) => {
        const data = await fsp.readFile(filePath)
        return {
          name: path.basename(filePath),
          path: filePath,
          size: data.byteLength,
          dataBase64: data.toString('base64')
        }
      })
    )
  })

  ipcMain.handle('bcis:confirm', async (_event, options = {}) => {
    const { message, detail, confirmLabel = 'Confirm', danger = false } = options
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: danger ? 'warning' : 'question',
      buttons: [confirmLabel, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message,
      detail,
      noLink: true
    })
    return response === 0
  })

  ipcMain.handle('bcis:message', async (_event, options = {}) => {
    const { type = 'info', message, detail } = options
    await dialog.showMessageBox(mainWindow, { type, message, detail, noLink: true })
    return true
  })

  ipcMain.handle('bcis:print', async (_event, mode = 'page') => {
    if (!mainWindow) {
      return false
    }
    /**
     * The renderer marks the printable region before asking us to print, so a
     * route sheet or statement of account never carries the sidebar with it.
     */
    await new Promise((resolve) => mainWindow.webContents.executeJavaScript('window.__bcisBeforePrint && window.__bcisBeforePrint()', true).then(resolve, resolve))
    mainWindow.webContents.print({ silent: false, printBackground: true })
    return true
  })

  /**
   * Render the current view to a PDF file and hand it to the native save dialog.
   *
   * This is the file counterpart to printing: an operator who needs to keep or
   * email a route sheet, statement of account or report gets a PDF on disk
   * instead of only a page on a printer. The renderer marks the printable region
   * first, exactly as printing does, so the navigation is stripped from the file.
   */
  ipcMain.handle('bcis:export-pdf', async (_event, options = {}) => {
    if (!mainWindow) {
      return null
    }
    const { defaultPath = 'bcis-view.pdf' } = options
    await new Promise((resolve) =>
      mainWindow.webContents
        .executeJavaScript('window.__bcisBeforePrint && window.__bcisBeforePrint()', true)
        .then(resolve, resolve)
    )
    try {
      const data = await mainWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath,
        filters: [{ name: 'PDF document', extensions: ['pdf'] }]
      })
      if (canceled || !filePath) {
        return null
      }
      await fsp.writeFile(filePath, data)
      return filePath
    } finally {
      // printToPDF fires no `afterprint` event, so the renderer's chrome has to
      // be restored explicitly or the sidebar would stay hidden after export.
      await mainWindow.webContents
        .executeJavaScript('window.__bcisAfterPrint && window.__bcisAfterPrint()', true)
        .catch(() => {})
    }
  })
}

app.on('before-quit', () => {
  app.isQuitting = true
})

app.whenReady().then(() => {
  readConfig()
  process.env.BCIS_PACKAGED = app.isPackaged ? '1' : '0'
  registerIpc()
  buildMenu()
  createWindow()
  startApiChild()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (apiProcess) {
    apiProcess.kill()
    apiProcess = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
