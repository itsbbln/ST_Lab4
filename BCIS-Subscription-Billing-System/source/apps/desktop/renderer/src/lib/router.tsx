/**
 * A minimal hash router.
 *
 * The packaged client is loaded from `file://`, where the History API cannot
 * push state and a reload would try to fetch a path from disk. Hash routing is
 * the only approach that works identically in development and in a packaged
 * installer, and it needs no extra dependency.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export interface RouteMatch {
  /** Path with a leading slash and no trailing slash, e.g. `/subscribers/abc`. */
  path: string
  segments: string[]
  query: URLSearchParams
}

interface RouterValue extends RouteMatch {
  navigate: (to: string, options?: { replace?: boolean }) => void
}

const RouterContext = createContext<RouterValue | null>(null)

function parseHash(): RouteMatch {
  const raw = window.location.hash.replace(/^#/, '') || '/'
  const [pathPart, queryPart = ''] = raw.split('?')
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`
  const withoutTrailing = path.length > 1 ? path.replace(/\/+$/, '') : path
  return {
    path: withoutTrailing || '/',
    segments: withoutTrailing.split('/').filter(Boolean),
    query: new URLSearchParams(queryPart)
  }
}

export function RouterProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [match, setMatch] = useState<RouteMatch>(() => parseHash())

  useEffect(() => {
    const onHashChange = () => setMatch(parseHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`
    if (options.replace) {
      window.history.replaceState(null, '', target)
      setMatch(parseHash())
    } else if (window.location.hash === target) {
      setMatch(parseHash())
    } else {
      window.location.hash = target
    }
  }, [])

  const value = useMemo<RouterValue>(() => ({ ...match, navigate }), [match, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext)
  if (!value) {
    throw new Error('useRouter must be used inside RouterProvider.')
  }
  return value
}

export function useNavigate(): RouterValue['navigate'] {
  return useRouter().navigate
}

export function usePath(): string {
  return useRouter().path
}

export function useQueryParam(name: string): string | null {
  return useRouter().query.get(name)
}

/** `useRouteMatch(['subscribers', ':id'])` -> `{ id: 'abc' }` or null. */
export function useRouteMatch(pattern: string[]): Record<string, string> | null {
  const { segments } = useRouter()
  return matchPath(pattern, segments)
}

/**
 * Pure pattern matcher, so a route table can be scanned without a hook per
 * candidate. `:name` captures one segment.
 */
export function matchPath(
  pattern: readonly string[],
  segments: readonly string[]
): Record<string, string> | null {
  if (segments.length !== pattern.length) {
    return null
  }

  const params: Record<string, string> = {}
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]
    const actual = segments[index]
    if (expected.startsWith(':')) {
      if (actual === undefined) {
        return null
      }
      params[expected.slice(1)] = decodeURIComponent(actual)
    } else if (expected !== actual) {
      return null
    }
  }
  return params
}
