/**
 * Typed HTTP client for the BCIS API.
 *
 * Two rules shape this file.
 *
 * 1. The API is the only thing that talks to PostgreSQL. The renderer sends
 *    plain JSON and never reimplements a business rule.
 * 2. Money is always integer centavos. Most endpoints also return the figure
 *    already formatted, either as a sibling string named after the figure
 *    (`outstanding`) or inside a `money` map. Those strings are what a screen
 *    must display; see `displayMoney`.
 */

export interface MoneyRow {
  money?: Record<string, string>
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export interface ValidationIssue {
  path: string
  message: string
}

/**
 * A failed request, carrying enough structure for a screen to decide between an
 * inline field error, a banner and a full-page "server unreachable" state.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  /** Field name -> message, derived from Zod validation issues. */
  readonly fieldErrors: Record<string, string>

  constructor(status: number, body: Partial<ApiErrorBody>['error'] | null, fallback: string) {
    super(body?.message?.trim() || fallback)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.code ?? 'UNKNOWN'
    this.details = body?.details
    this.fieldErrors = extractFieldErrors(body?.details)
  }

  /** True when the caller simply lacks the permission for this operation. */
  get isForbidden(): boolean {
    return this.status === 403
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /** True when the server could not be reached at all, as opposed to refusing. */
  get isUnreachable(): boolean {
    return this.status === 0
  }
}

function extractFieldErrors(details: unknown): Record<string, string> {
  if (!details || typeof details !== 'object') {
    return {}
  }
  const issues = (details as { issues?: unknown }).issues
  if (!Array.isArray(issues)) {
    return {}
  }

  const fieldErrors: Record<string, string> = {}
  for (const issue of issues as ValidationIssue[]) {
    if (issue && typeof issue.path === 'string' && typeof issue.message === 'string') {
      // Zod array indices (`allocations.0.amount`) are not form field names.
      fieldErrors[issue.path] ??= issue.message
    }
  }
  return fieldErrors
}

type QueryValue = string | number | boolean | null | undefined

export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') {
      continue
    }
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface ClientOptions {
  /** Resolved lazily so a Settings change takes effect without a reload. */
  baseUrl: () => string
  token: () => string | null
  /** Invoked on a 401 so the app can drop the stale session and show login. */
  onUnauthorized?: () => void
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
  signal?: AbortSignal
  /** Skip the global 401 handler for endpoints that handle it themselves. */
  anonymous?: boolean
  headers?: Record<string, string>
}

export class ApiClient {
  private readonly options: ClientOptions

  /**
   * Written as an explicit assignment rather than a parameter property so the
   * class stays valid under `erasableSyntaxOnly`, which the renderer requires.
   */
  constructor(options: ClientOptions) {
    this.options = options
  }

  private url(path: string, query?: Record<string, QueryValue>): string {
    const base = this.options.baseUrl().replace(/\/+$/, '')
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${base}${suffix}${buildQuery(query)}`
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, signal, anonymous, headers = {} } = options
    const token = anonymous ? null : this.options.token()

    const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers }
    if (token) {
      requestHeaders.Authorization = `Bearer ${token}`
    }
    if (body !== undefined && !(body instanceof FormData)) {
      requestHeaders['Content-Type'] = 'application/json'
    }

    let response: Response
    try {
      response = await fetch(this.url(path, query), {
        method,
        headers: requestHeaders,
        signal,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw error
      }
      throw new ApiError(
        0,
        { code: 'UNREACHABLE', message: 'Cannot reach the BCIS server.' },
        'Cannot reach the BCIS server.'
      )
    }

    if (response.status === 401 && !anonymous) {
      this.options.onUnauthorized?.()
    }

    if (response.status === 204) {
      return undefined as T
    }

    const contentType = response.headers.get('content-type') ?? ''

    if (!response.ok) {
      let body: Partial<ApiErrorBody>['error'] | null = null
      if (contentType.includes('application/json')) {
        body = ((await response.json().catch(() => null)) as ApiErrorBody | null)?.error ?? null
      } else {
        const text = (await response.text().catch(() => '')).trim()
        if (text) {
          body = { code: 'UNEXPECTED', message: text.slice(0, 400) }
        }
      }
      throw new ApiError(response.status, body, `Request failed with status ${response.status}.`)
    }

    if (contentType.includes('application/json')) {
      return (await response.json()) as T
    }

    return (await response.text()) as T
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' })
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body })
  }

  put<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PUT', body })
  }

  delete<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' })
  }

  /**
   * Fetch a report export as raw bytes so the file can be handed to the native
   * save dialog rather than silently dropping it in a downloads folder.
   *
   * The API selects the export mode with the `exportFormat` query value; sending
   * `format` instead would be ignored by the route's Zod schema and the server
   * would answer with JSON that this method would happily save as a `.pdf`.
   */
  async download(
    path: string,
    query: Record<string, QueryValue>,
    format: 'csv' | 'xlsx' | 'pdf'
  ): Promise<{ blob: Blob; filename: string }> {
    const token = this.options.token()
    const response = await fetch(this.url(path, { ...query, exportFormat: format }), {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })

    if (!response.ok) {
      let body: Partial<ApiErrorBody>['error'] | null = null
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        body = ((await response.json().catch(() => null)) as ApiErrorBody | null)?.error ?? null
      }
      throw new ApiError(response.status, body, 'The export could not be generated.')
    }

    const disposition = response.headers.get('content-disposition') ?? ''
    const match = /filename="?([^"]+)"?/i.exec(disposition)
    const extension = match ? '' : `.${format}`

    // A 200 with a JSON body means the server answered with report data rather
    // than a file. Saving that bytes-for-bytes would produce a corrupt export.
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      throw new ApiError(200, { code: 'EXPORT_FAILED', message: 'The server did not return a report file.' }, 'The export could not be generated.')
    }

    return {
      blob: await response.blob(),
      filename: match?.[1] ?? `bcis-report${extension}`
    }
  }
}

/**
 * Read a peso figure for display, in the order the API prefers.
 *
 * The two conventions in use are both trusted before anything is formatted
 * locally:
 *
 * 1. `row[figure]` is already a display string. List endpoints send the centavos
 *    and a sibling string named after the figure, for example
 *    `outstandingCentavos: 0` with `outstanding: "-"`.
 * 2. `row.money[figure]`. Detail resources wrap their strings in a `money` map.
 * 3. `row[figure + "Centavos"]` as a number, formatted locally. This is the last
 *    resort, not the first choice.
 *
 * A peso figure that disagrees with the ledger is the most damaging thing this
 * application can show, so the server's own string always wins.
 */
export function displayMoney<T extends object>(row: T, figure: string): string {
  const source = row as Record<string, unknown>

  const direct = source[figure]
  if (typeof direct === 'string' && direct.length > 0) {
    return direct
  }

  const inMap = (source as MoneyRow).money?.[figure]
  if (typeof inMap === 'string' && inMap.length > 0) {
    return inMap
  }

  const centavos = source[`${figure}Centavos`]
  return typeof centavos === 'number' ? formatCentavosFallback(centavos) : '—'
}

const pesoFormatter = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

export function formatCentavosFallback(centavos: number): string {
  if (!Number.isFinite(centavos)) {
    return '—'
  }
  return `₱${pesoFormatter.format(centavos / 100)}`
}

/** Convert a peso string from an input into integer centavos without float math. */
export function pesosToCentavos(input: string): number | null {
  const normalized = input.trim().replace(/,/g, '').replace(/^₱/, '')
  if (!/^-?(?:\d{1,15}(?:\.\d{1,2})?|\.\d{1,2})$/.test(normalized)) {
    return null
  }
  const negative = normalized.startsWith('-')
  const [whole, fraction = ''] = normalized.replace('-', '').split('.')
  const centavos = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
  return negative ? -centavos : centavos
}

/** Turn integer centavos into the plain decimal string a peso input expects. */
export function centavosToPesosInput(centavos: number): string {
  if (typeof centavos !== 'number' || !Number.isInteger(centavos)) {
    return ''
  }
  const negative = centavos < 0
  const absolute = Math.abs(centavos)
  const whole = Math.trunc(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}
