/**
 * Desktop configuration and the configured API client.
 *
 * The server address is the one setting that differs on every machine, so it is
 * read from the Electron bridge, kept in React state, and injected into the API
 * client through a resolver. That means changing the server in Settings takes
 * effect immediately, without reloading the window.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiClient } from './api'
import type { BcisConfig, ConfigPatch, ProbeResult } from '../types/bridge'

/** Used when the preload bridge is unavailable, e.g. a plain `vite dev` browser tab. */
const FALLBACK_CONFIG: BcisConfig = {
  apiBase: 'http://127.0.0.1:3001',
  launchApiLocally: false,
  apiPort: 3001,
  corsOrigins: [],
  rememberOperator: true
}

function bridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.bcis?.getConfig === 'function'
}

interface ConfigValue {
  config: BcisConfig
  client: ApiClient
  ready: boolean
  lanUrls: string[]
  /** Server-side status when this machine is hosting the API. */
  apiStatus: 'running' | 'exited' | 'unknown'
  saveConfig: (patch: ConfigPatch) => Promise<BcisConfig>
  probe: (apiBase: string) => Promise<ProbeResult>
  refreshLanUrls: () => Promise<void>
  /** Publish the signed-in session token to the client. Owned by the auth provider. */
  setToken: (token: string | null) => void
  /** Set by the auth provider so the client can drop a stale session. */
  onUnauthorized: () => void
  registerUnauthorizedHandler: (handler: () => void) => void
}

const ConfigContext = createContext<ConfigValue | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [config, setConfig] = useState<BcisConfig>(FALLBACK_CONFIG)
  const [ready, setReady] = useState(false)
  const [lanUrls, setLanUrls] = useState<string[]>([])
  const [apiStatus, setApiStatus] = useState<'running' | 'exited' | 'unknown'>('unknown')
  const [unauthorizedHandler, setUnauthorizedHandler] = useState<() => void>(() => () => {})

  /**
   * The session token is held in a ref rather than React state so the API client
   * can be created once and still read the current value on every request.
   */
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!bridgeAvailable()) {
      setReady(true)
      return
    }

    let active = true
    void (async () => {
      const loaded = await window.bcis.getConfig()
      if (active) {
        setConfig(loaded)
        setReady(true)
      }
      setLanUrls(await window.bcis.getLanUrls())
    })()

    const offConfig = window.bcis.on('bcis:config-changed', (next) => setConfig(next))
    const offStatus = window.bcis.on('bcis:api-status', (status) => setApiStatus(status.state))
    return () => {
      active = false
      offConfig()
      offStatus()
    }
  }, [])

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: () => config.apiBase,
        token: () => tokenRef.current,
        onUnauthorized: () => unauthorizedHandler()
      }),
    [config.apiBase, unauthorizedHandler]
  )

  const setToken = useCallback((token: string | null) => {
    tokenRef.current = token
  }, [])

  const saveConfig = useCallback(async (patch: ConfigPatch) => {
    if (!bridgeAvailable()) {
      const next = { ...config, ...patch }
      setConfig(next)
      return next
    }
    const saved = await window.bcis.setConfig(patch)
    setConfig(saved)
    setLanUrls(await window.bcis.getLanUrls())
    return saved
  }, [config])

  const probe = useCallback(
    async (apiBase: string) => {
      if (!bridgeAvailable()) {
        try {
          const response = await fetch(`${apiBase}/health`)
          return { ok: response.ok, status: response.status, apiBase }
        } catch {
          return { ok: false, status: 0, apiBase, error: 'Cannot reach that address.' }
        }
      }
      return window.bcis.probeApi(apiBase)
    },
    []
  )

  const refreshLanUrls = useCallback(async () => {
    if (bridgeAvailable()) {
      setLanUrls(await window.bcis.getLanUrls())
    }
  }, [])

  const registerUnauthorizedHandler = useCallback((handler: () => void) => {
    setUnauthorizedHandler(() => handler)
  }, [])

  const value = useMemo<ConfigValue>(
    () => ({
      config,
      client,
      ready,
      lanUrls,
      apiStatus,
      saveConfig,
      probe,
      refreshLanUrls,
      setToken,
      onUnauthorized: () => unauthorizedHandler(),
      registerUnauthorizedHandler
    }),
    [
      config,
      client,
      ready,
      lanUrls,
      apiStatus,
      saveConfig,
      probe,
      refreshLanUrls,
      setToken,
      unauthorizedHandler,
      registerUnauthorizedHandler
    ]
  )

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
}

export function useConfig(): ConfigValue {
  const value = useContext(ConfigContext)
  if (!value) {
    throw new Error('useConfig must be used inside ConfigProvider.')
  }
  return value
}

export function useClient(): ApiClient {
  return useConfig().client
}
