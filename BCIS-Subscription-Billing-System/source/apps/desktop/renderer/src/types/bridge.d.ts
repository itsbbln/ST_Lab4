/**
 * Type declarations for the Electron preload bridge.
 *
 * The renderer is sandboxed with `contextIsolation`, so `window.bcis` is the
 * only path to the operating system. These declarations mirror `preload.js`
 * exactly: if the bridge ever grows a capability, the renderer cannot see it
 * until it is declared here, and this file is type-checked on every build.
 */

export interface BcisConfig {
  /** Origin this client sends every API request to, e.g. `http://192.168.1.20:3001`. */
  apiBase: string
  /** Start the API as a child process of this app (office-server role only). */
  launchApiLocally: boolean
  apiPort: number
  /** Extra renderer origins the locally launched API should accept. */
  corsOrigins: string[]
  /** Restore the last signed-in operator's username on the login screen. */
  rememberOperator: boolean
}

export type ConfigPatch = Partial<BcisConfig>

export interface ProbeResult {
  ok: boolean
  status: number
  apiBase: string
  error?: string
}

export interface PickedFile {
  name: string
  path: string
  size: number
  dataBase64: string
}

export interface ConfirmOptions {
  message: string
  detail?: string
  confirmLabel?: string
  danger?: boolean
}

export interface MessageOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
}

export interface SaveFileOptions {
  defaultPath: string
  dataBase64: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface PickFileOptions {
  filters?: Array<{ name: string; extensions: string[] }>
  multiple?: boolean
}

/** `page` strips the sidebar and top bar; `window` prints whatever is on screen. */
export type PrintMode = 'page' | 'window'

export interface ApiStatus {
  state: 'running' | 'exited'
  code?: number
  line?: string
}

export type BcisMenuAction =
  | 'print'
  | 'print-page'
  | 'settings'
  | `navigate:${string}`

export interface BcisBridge {
  platform: string
  versions: { electron: string; chrome: string; node: string }
  isPackaged: boolean
  getConfig(): Promise<BcisConfig>
  setConfig(patch: ConfigPatch): Promise<BcisConfig>
  getLanUrls(): Promise<string[]>
  probeApi(apiBase: string): Promise<ProbeResult>
  openPath(target: 'userData' | 'logs' | 'backups'): Promise<string>
  saveFile(options: SaveFileOptions): Promise<string | null>
  pickFile(options: PickFileOptions): Promise<PickedFile[] | null>
  confirm(options: ConfirmOptions): Promise<boolean>
  message(options: MessageOptions): Promise<boolean>
  print(mode: PrintMode): Promise<boolean>
  on(channel: 'bcis:config-changed', handler: (config: BcisConfig) => void): () => void
  on(channel: 'bcis:api-status', handler: (status: ApiStatus) => void): () => void
  on(channel: 'bcis:menu-action', handler: (action: BcisMenuAction) => void): () => void
}

declare global {
  interface Window {
    bcis: BcisBridge
    /**
     * Installed by the app shell so the main process can mark the printable
     * region before invoking `print()`. Declared here because the main process
     * calls it through `executeJavaScript`.
     */
    __bcisBeforePrint?: () => void
  }
}

export {}
