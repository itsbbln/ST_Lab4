/**
 * Display helpers shared by every screen.
 *
 * Status is always rendered as text plus a colour, never colour alone, so the
 * application stays readable for a colour-blind operator and in a printed
 * report.
 */

const dateFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: '2-digit'
})

const dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
})

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter.format(date)
}

/** `2026-09` -> `September 2026`, for billing period labels. */
export function formatPeriod(period: string | null | undefined): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return period ?? '—'
  }
  const [year, month] = period.split('-')
  const label = new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(
    new Date(Number(year), Number(month) - 1, 1)
  )
  return label
}

export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function currentPeriod(): string {
  return todayIso().slice(0, 7)
}

export function shiftPeriod(period: string, months: number): string {
  const [year, month] = period.split('-').map(Number)
  const date = new Date(year, month - 1 + months, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—'
  }
  return new Intl.NumberFormat('en-PH').format(value)
}

/**
 * Display a peso amount held as integer centavos.
 *
 * Used for figures the API does not decorate with its own `money` string, such
 * as a computed total on the client. Where the server supplies `money`, prefer
 * it via `displayMoney` so a figure is never rendered two different ways.
 */
export function formatPesos(centavos: number | null | undefined, options: { blankZero?: boolean } = {}): string {
  if (typeof centavos !== 'number' || !Number.isInteger(centavos)) {
    return '—'
  }
  if (options.blankZero && centavos === 0) {
    return '—'
  }
  const negative = centavos < 0
  const absolute = Math.abs(centavos)
  const whole = Math.trunc(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  return `${negative ? '−' : ''}₱${whole.toLocaleString('en-PH')}.${fraction}`
}

/** `CASH` -> `Cash`, `PARTIALLY_PAID` -> `Partially paid`. */
export function humanizeToken(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  const words = value.replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Statuses are grouped so a screen can pick a consistent colour and an operator
 * can still read the exact status from the label.
 */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

const statusTones: Record<string, StatusTone> = {
  // Subscribers / accounts
  ACTIVE: 'success',
  PENDING_ACTIVATION: 'info',
  SUSPENDED: 'warning',
  DISCONNECTED: 'neutral',
  TERMINATED: 'neutral',
  INACTIVE: 'neutral',
  ARCHIVED: 'neutral',
  // Invoices
  DRAFT: 'neutral',
  UNPAID: 'info',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
  OVERDUE: 'danger',
  VOID: 'neutral',
  CREDITED: 'info',
  // Payments and proofs
  POSTED: 'success',
  REVERSED: 'danger',
  PENDING: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  // Billing cycles
  OPEN: 'info',
  GENERATED: 'success',
  FINALIZED: 'success',
  CLOSED: 'neutral',
  // Collection
  IN_PROGRESS: 'info',
  SUBMITTED: 'warning',
  REMITTED: 'info',
  RECONCILED: 'success',
  COLLECTED: 'success',
  PARTIAL: 'warning',
  UNCOLLECTED: 'danger',
  SKIPPED: 'neutral',
  CONFIRMED: 'success',
  DRAFT_REM: 'neutral',
  // Service control
  APPROVED: 'info',
  EXECUTED: 'warning',
  CANCELLED: 'neutral',
  PENDING_PAYMENT: 'warning',
  REQUESTED: 'info',
  COMPLETED: 'success',
  // Backups
  CREATED: 'info',
  RESTORED: 'accent',
  FAILED: 'danger'
}

export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) {
    return 'neutral'
  }
  return statusTones[status] ?? 'neutral'
}

/** Absolute path of a route, used for breadcrumbs and print headers. */
export function joinPath(...segments: Array<string | number | undefined>): string {
  return `/${segments
    .filter((segment) => segment !== undefined && segment !== '')
    .map((segment) => String(segment).replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment !== '')
    .join('/')}`
}
