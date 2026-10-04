/**
 * Session state and the permission helpers the navigation and screens use.
 *
 * Hiding a button in React is a usability affordance, never authorization. The
 * server enforces every permission independently; these helpers only decide what
 * to *offer*, so a cashier never sees a "Reverse payment" button they cannot use.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiError } from './api'
import { useConfig } from './config'

/**
 * The signed-in operator.
 *
 * This mirrors what the API actually returns rather than a tidied-up version of
 * it. Two details are deliberate:
 *
 * - `roles` is a list, because the specification allows an operator to hold more
 *   than one. Permission checks go through `permissions`, which the server
 *   expands from the roles, so the client never has to interpret a role name.
 * - `roles` is optional because `/auth/login` includes it but `/auth/me` does
 *   not. After a reload the client restores the session from `/auth/me`, and a
 *   required field would show up as `undefined` in exactly that case.
 */
export interface AuthUser {
  id: string
  username: string
  displayName: string
  email?: string
  roles?: string[]
  permissions: string[]
  mustChangePassword?: boolean
}

const TOKEN_KEY = 'bcis.session.token'
const OPERATOR_KEY = 'bcis.session.operator'

export interface LoginResult {
  ok: boolean
  message?: string
}

interface AuthValue {
  user: AuthUser | null
  /** True until the stored session has been checked against the server. */
  initialising: boolean
  signingIn: boolean
  login: (username: string, password: string) => Promise<LoginResult>
  logout: (reason?: 'expired' | 'manual') => void
  lastOperator: string
  setLastOperator: (username: string) => void
  can: (...permissions: string[]) => boolean
  canAny: (...permissions: string[]) => boolean
}

const AuthContext = createContext<AuthValue | null>(null)

function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { client, setToken, registerUnauthorizedHandler } = useConfig()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [initialising, setInitialising] = useState(true)
  const [signingIn, setSigningIn] = useState(false)
  const [lastOperator, setLastOperatorState] = useState<string>(() => {
    try {
      return window.localStorage.getItem(OPERATOR_KEY) ?? ''
    } catch {
      return ''
    }
  })

  const setLastOperator = useCallback((username: string) => {
    setLastOperatorState(username)
    try {
      window.localStorage.setItem(OPERATOR_KEY, username)
    } catch {
      /* storage unavailable; the field is a convenience only */
    }
  }, [])

  const clearSession = useCallback(() => {
    setToken(null)
    setUser(null)
    try {
      window.localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }, [setToken])

  /**
   * A 401 anywhere in the app means the session is gone. Drop it centrally so no
   * screen has to handle the case where a token expired mid-workflow.
   */
  const register = useCallback(
    (handler: () => void) => registerUnauthorizedHandler(handler),
    [registerUnauthorizedHandler]
  )
  useEffect(() => {
    register(() => {
      clearSession()
      setUser(null)
    })
  }, [register, clearSession])

  /** Validate a stored token once at startup. */
  useEffect(() => {
    const token = readToken()
    if (!token) {
      setInitialising(false)
      return
    }

    let active = true
    setToken(token)
    void (async () => {
      try {
        const me = await client.get<{ user: AuthUser }>('/auth/me')
        if (active) {
          setUser(me.user)
        }
      } catch (error) {
        if (active && !(error instanceof ApiError && error.isUnreachable)) {
          clearSession()
        }
      } finally {
        if (active) {
          setInitialising(false)
        }
      }
    })()

    return () => {
      active = false
    }
  }, [client, setToken, clearSession])

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResult> => {
      setSigningIn(true)
      try {
        const response = await client.post<{ token: string; user: AuthUser }>(
          '/auth/login',
          { username, password },
          { anonymous: true }
        )
        try {
          window.localStorage.setItem(TOKEN_KEY, response.token)
        } catch {
          /* a non-persistent session still works for this run */
        }
        setToken(response.token)
        setUser(response.user)
        setLastOperator(response.user.username)
        return { ok: true }
      } catch (error) {
        if (error instanceof ApiError) {
          return { ok: false, message: error.message }
        }
        return { ok: false, message: 'Sign-in failed. Please try again.' }
      } finally {
        setSigningIn(false)
      }
    },
    [client, setToken, setLastOperator]
  )

  const logout = useCallback(
    (reason: 'expired' | 'manual' = 'manual') => {
      if (reason === 'manual' && readToken()) {
        /*
         * `{}` rather than no body: the API refuses a POST whose content type it
         * cannot parse, and an empty body is not enough to set one. The call must
         * also be authenticated, or the server has no session to revoke.
         */
        void client.post('/auth/logout', {}).catch(() => undefined)
      }
      clearSession()
    },
    [client, clearSession]
  )

  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user])

  const can = useCallback(
    (...required: string[]) => required.every((permission) => permissions.has(permission)),
    [permissions]
  )

  const canAny = useCallback(
    (...required: string[]) => required.some((permission) => permissions.has(permission)),
    [permissions]
  )

  const value = useMemo<AuthValue>(
    () => ({ user, initialising, signingIn, login, logout, lastOperator, setLastOperator, can, canAny }),
    [user, initialising, signingIn, login, logout, lastOperator, setLastOperator, can, canAny]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider.')
  }
  return value
}

/** Render children only when the operator holds every listed permission. */
export function RequirePermission({
  permissions,
  children,
  fallback = null
}: {
  permissions: string[]
  children: ReactNode
  fallback?: ReactNode
}): React.JSX.Element | null {
  const { can } = useAuth()
  return can(...permissions) ? <>{children}</> : <>{fallback}</>
}
