/**
 * The shared component vocabulary for every BCIS screen.
 *
 * The specification asks for visible labels, required indicators, consistent
 * table behaviour and status shown as text plus colour. Those rules are encoded
 * once here so no screen has to reinvent them.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'

import { displayMoney } from '../lib/api'
import { statusTone, humanizeToken } from '../lib/format'
import type { StatusTone } from '../lib/format'
import './ui.css'

/* ------------------------------------------------------------------ text */

export function Badge({ status, label }: { status?: string | null; label?: string }): React.JSX.Element {
  const tone = statusTone(status)
  return <span className={`badge badge--${tone}`}>{label ?? humanizeToken(status)}</span>
}

export function Money({
  row,
  field,
  blankZero = false
}: {
  row: Record<string, unknown>
  field: string
  blankZero?: boolean
}): React.JSX.Element {
  const text = displayMoney(row as never, field)
  if (blankZero && text === '₱0.00') {
    return <span className="money text-subtle">—</span>
  }
  return <span className="money">{text}</span>
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  footer
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
  footer?: ReactNode
}): React.JSX.Element {
  return (
    <section className="panel">
      {title || actions ? (
        <header className="panel__header">
          <div>
            {title ? <div className="panel__title">{title}</div> : null}
            {subtitle ? <div className="panel__subtitle">{subtitle}</div> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? 'panel__body panel__body--flush' : 'panel__body'}>{children}</div>
      {footer ? <div className="panel__footer">{footer}</div> : null}
    </section>
  )
}

export function Banner({
  tone,
  title,
  children
}: {
  tone: 'error' | 'warning' | 'success' | 'info'
  title: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div>
        <div className="banner__title">{title}</div>
        {children ? <div className="banner__body">{children}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="table__empty">
      <div className="text-bold">{title}</div>
      {hint ? <div className="text-sm text-muted" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  )
}

export function LoadingRows({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="stack stack--sm" style={{ padding: 'var(--space-4)' }}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${100 - index * 7}%` }} />
      ))}
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="row" style={{ padding: 'var(--space-5)', color: 'var(--text-muted)' }}>
      <span className="spinner" />
      <span className="text-sm">{label}…</span>
    </div>
  )
}

/** A full-page error with a retry, used where a screen cannot render at all. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <Banner tone="error" title="This screen could not be loaded">
        <div>{message}</div>
      </Banner>
      {onRetry ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ----------------------------------------------------------------- forms */

export function Field({
  label,
  required = false,
  hint,
  error,
  children
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? (
          <span className="field__required" aria-label="required">
            *
          </span>
        ) : null}
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

export function MoneyInput({
  value,
  onChange,
  placeholder = '0.00',
  disabled,
  error
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  error?: string
}): React.JSX.Element {
  return (
    <input
      className={`input input--money${error ? ' input--error' : ''}`}
      inputMode="decimal"
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  )
}

/* ----------------------------------------------------------------- modal */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '6vh var(--space-5) var(--space-5)',
        background: 'rgba(16, 24, 40, 0.44)',
        overflow: 'auto'
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel"
        style={{ width: '100%', maxWidth: width, boxShadow: 'var(--shadow-lg)' }}
      >
        <header className="panel__header">
          <div>
            <div className="panel__title">{title}</div>
            {subtitle ? <div className="panel__subtitle">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="panel__body">{children}</div>
        {footer ? <div className="panel__footer">{footer}</div> : null}
      </section>
    </div>
  )
}

/* ---------------------------------------------------------------- toasts */

export interface Toast {
  id: number
  tone: 'error' | 'success' | 'info'
  message: string
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): React.JSX.Element {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} onClick={() => onDismiss(toast.id)}>
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  )
}

/** Toast state for a screen; `push` is stable so it can be passed to effects. */
export function useToasts(): { toasts: Toast[]; push: (tone: Toast['tone'], message: string) => void; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id))

  const push = (tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, tone, message }])
    window.setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 4500)
  }

  return { toasts, push, dismiss }
}

/* ----------------------------------------------------------------- table */

export interface Column<T> {
  key: string
  header: ReactNode
  /** Money columns are right-aligned with tabular figures automatically. */
  align?: 'left' | 'right' | 'center'
  money?: boolean
  width?: string
  sortable?: boolean
  sortValue?: (row: T) => string | number
  render: (row: T) => ReactNode
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  empty?: ReactNode
  loading?: boolean
  maxHeight?: string
  /** Optional summary row rendered in a tfoot, e.g. a collected total. */
  footer?: ReactNode
  sort?: { key: string; direction: 'asc' | 'desc' }
  onSort?: (key: string) => void
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  loading = false,
  maxHeight,
  footer,
  sort,
  onSort
}: DataTableProps<T>): React.JSX.Element {
  if (loading) {
    return <LoadingRows />
  }
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing to show yet." />}</>
  }

  return (
    <div className="table-wrap" style={maxHeight ? { ['--table-max-height' as string]: maxHeight } : undefined}>
      <table className={`table${onRowClick ? ' table--clickable' : ''}`}>
        <thead>
          <tr>
            {columns.map((column) => {
              const align = column.align ?? (column.money ? 'right' : 'left')
              const active = sort?.key === column.key
              const className = [
                column.sortable && onSort ? 'is-sortable' : '',
                align === 'right' ? 'money' : '',
                align === 'center' ? 'text-center' : ''
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <th
                  key={column.key}
                  className={className}
                  style={column.width ? { width: column.width } : undefined}
                  onClick={column.sortable && onSort ? () => onSort(column.key) : undefined}
                  aria-sort={active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {column.header}
                  {active ? <span aria-hidden="true">{sort?.direction === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter') {
                        onRowClick(row)
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => {
                const align = column.align ?? (column.money ? 'right' : 'left')
                return (
                  <td
                    key={column.key}
                    className={align === 'right' ? 'money' : align === 'center' ? 'text-center' : undefined}
                  >
                    {column.render(row)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  )
}

/** Apply the active sort to a client-side row set. */
export function useSortedRows<T>(rows: T[], columns: Array<Column<T>>, sort: { key: string; direction: 'asc' | 'desc' } | null): T[] {
  return useMemo(() => {
    if (!sort) {
      return rows
    }
    const column = columns.find((candidate) => candidate.key === sort.key)
    if (!column?.sortValue) {
      return rows
    }
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((left, right) => {
      const a = column.sortValue!(left)
      const b = column.sortValue!(right)
      if (typeof a === 'number' && typeof b === 'number') {
        return (a - b) * factor
      }
      return String(a).localeCompare(String(b)) * factor
    })
  }, [rows, columns, sort])
}

/* ------------------------------------------------------------- page frame */

export function PageHeader({
  title,
  subtitle,
  actions,
  tabs
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  tabs?: ReactNode
}): React.JSX.Element {
  return (
    <div className="page-header">
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1>{title}</h1>
          {subtitle ? <p className="text-muted text-sm" style={{ marginTop: 2 }}>{subtitle}</p> : null}
        </div>
        {actions ? <div className="row page-actions">{actions}</div> : null}
      </div>
      {tabs ? <div style={{ marginTop: 'var(--space-4)' }}>{tabs}</div> : null}
    </div>
  )
}

export function TabBar({
  tabs,
  active,
  onChange
}: {
  tabs: Array<{ key: string; label: string; count?: number }>
  active: string
  onChange: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`tab${active === tab.key ? ' tab--active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className="tab__count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: StatusTone
}): React.JSX.Element {
  return (
    <div className={`stat-tile${tone ? ` stat-tile--${tone}` : ''}`}>
      <div className="stat-tile__label">{label}</div>
      <div className="stat-tile__value">{value}</div>
      {hint ? <div className="stat-tile__hint">{hint}</div> : null}
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}): React.JSX.Element {
  const lastPage = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)

  return (
    <div className="pagination">
      <span>
        {first}–{last} of {total}
      </span>
      <button type="button" className="btn btn--sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {lastPage}
      </span>
      <button type="button" className="btn btn--sm" disabled={page >= lastPage} onClick={() => onChange(page + 1)}>
        Next
      </button>
    </div>
  )
}
