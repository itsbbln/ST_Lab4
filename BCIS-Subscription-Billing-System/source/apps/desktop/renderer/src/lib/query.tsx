/**
 * Data-fetching layer.
 *
 * Screens never call `fetch` directly; they declare a query key and this module
 * handles caching, refetching and error normalisation. TanStack Query is used
 * because it is already a dependency of the project and because a billing
 * operator moving between a subscriber profile and its statement should not
 * re-fetch a page they have already seen.
 */

import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiError } from './api'
import { useConfig } from './config'
import type { Page } from '../types/api'

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Financial data is only re-read when the operator asks, or after a write.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // Never retry a refusal; only a transient network problem is worth repeating.
          if (error instanceof ApiError && error.status !== 0) {
            return false
          }
          return failureCount < 2
        },
        refetchOnWindowFocus: false
      },
      mutations: { retry: false }
    }
  })
}

export function AppQueryProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const queryClient = useMemo(() => createQueryClient(), [])
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

export interface ApiQueryOptions {
  /** Set false to keep a screen from firing before it has the inputs it needs. */
  enabled?: boolean
}

/**
 * `useApiQuery(['subscribers', page], (client) => client.get(...))`
 *
 * The fetcher receives the configured client so the query function stays a
 * plain function of its key, which keeps it trivially reusable and refetchable.
 */
export function useApiQuery<T>(
  queryKey: readonly unknown[],
  fetcher: (client: ReturnType<typeof useConfig>['client']) => Promise<T>,
  options: ApiQueryOptions = {}
): UseQueryResult<T, ApiError> {
  const { client } = useConfig()
  return useQuery<T, ApiError>({
    queryKey,
    queryFn: () => fetcher(client),
    enabled: options.enabled ?? true,
    // A key change (page 1 -> page 2) should show a spinner, not the old rows.
    placeholderData: (previous) => previous
  })
}

export function useApiMutation<TVariables, TData>(
  mutationFn: (client: ReturnType<typeof useConfig>['client'], variables: TVariables) => Promise<TData>,
  options: { onSuccess?: (data: TData, variables: TVariables) => void; onError?: (error: ApiError) => void } = {}
): UseMutationResult<TData, ApiError, TVariables> {
  const { client } = useConfig()
  return useMutation<TData, ApiError, TVariables>({
    mutationFn: (variables) => mutationFn(client, variables),
    onSuccess: options.onSuccess,
    onError: options.onError
  })
}

/**
 * The paginated envelope the list endpoints return.
 *
 * The API deliberately does not send a `totalPages` figure: the client derives it
 * from `total` and `pageSize` in `Pagination`, so there is only ever one place
 * to be wrong instead of two.
 */
export type Paged<T> = Page<T>

/**
 * `R` lets a caller widen the envelope when an endpoint returns more than the
 * four paging fields. `/invoices`, for example, also reports
 * `totalBalanceCentavos` for the filtered set, and that figure is the server's
 * own subtotal rather than one the client should recompute from the visible page.
 */
export function usePagedList<T, R extends Paged<T> = Paged<T>>(
  path: string,
  filters: Record<string, string | number | boolean | undefined>,
  pageSize = 25
): {
  page: number
  setPage: (page: number) => void
  setFilter: (key: string, value: string | number | boolean | undefined) => void
  resetFilters: () => void
  query: R | undefined
  isPending: boolean
  error: ApiError | null
  refetch: () => void
} {
  const [page, setPageState] = useState(1)
  const [activeFilters, setActiveFilters] = useState(filters)

  const filterKey = JSON.stringify(activeFilters)
  useEffect(() => {
    setPageState(1)
  }, [filterKey])

  const query = useApiQuery<R>(
    ['paged', path, filterKey, page, pageSize],
    (client) =>
      client.get<R>(path, {
        query: { ...activeFilters, page, pageSize } as Record<string, string | number | boolean | undefined>
      })
  )

  return {
    page,
    setPage: setPageState,
    setFilter: (key, value) =>
      setActiveFilters((current) => {
        const next = { ...current }
        if (value === undefined || value === '') {
          delete next[key]
        } else {
          next[key] = value
        }
        return next
      }),
    resetFilters: () => setActiveFilters(filters),
    query: query.data,
    isPending: query.isPending,
    error: query.error,
    refetch: () => void query.refetch()
  }
}
