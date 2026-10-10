/**
 * The payment register and the "receive a payment" flow.
 *
 * Two rules govern this screen.
 *
 * 1. `amount` is a **peso decimal string** on the wire, not centavos. The shared
 *    `amountInput` schema parses it with `parseCentavos`, so "1500" is ₱1,500.00.
 *    The inputs therefore stay in peso land throughout and the parsed centavos
 *    are never sent; a client that "optimised" this into centavos would post a
 *    payment a hundred times too large.
 * 2. The operator sees the allocation before the money moves. `previewAllocation`
 *    is the server's own oldest-first plan, and it is shown in the form rather
 *    than after the fact, so nobody has to reconcile a surprise afterwards.
 */

import { useEffect, useState } from 'react'

import { displayMoney, pesosToCentavos } from '../lib/api'
import { confirmAction, describeError } from '../lib/desktop'
import { ReportExportMenu } from '../components/export'
import { formatDateTime, formatNumber, humanizeToken } from '../lib/format'
import { useApiMutation, useApiQuery, usePagedList } from '../lib/query'
import { useAuth } from '../lib/auth'
import {
  Badge,
  Banner,
  DataTable,
  EmptyState,
  Field,
  LoadError,
  Modal,
  MoneyInput,
  PageHeader,
  Pagination,
  Panel,
  StatTile,
  ToastStack,
  useToasts
} from '../components/ui'
import type { Column } from '../components/ui'
import type { AllocationPreview, PaymentListResponse, PaymentListRow, ServiceAccountListRow } from '../types/api'

const METHODS = ['CASH', 'GCASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'] as const
const STATUS_OPTIONS = ['POSTED', 'REVERSED'] as const

export function PaymentsScreen({ initialShowReceive = false }: { initialShowReceive?: boolean } = {}): React.JSX.Element {
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()

  const [search, setSearch] = useState('')
  const [method, setMethod] = useState('')
  const [status, setStatus] = useState('')
  const [showReceive, setShowReceive] = useState(initialShowReceive)
  const [reversing, setReversing] = useState<PaymentListRow | null>(null)

  useEffect(() => {
    setShowReceive(initialShowReceive)
  }, [initialShowReceive])

  const list = usePagedList<PaymentListRow, PaymentListResponse>('/payments', { q: search, method, status })

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const columns: Array<Column<PaymentListRow>> = [
    {
      key: 'receipt',
      header: 'Receipt',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.receiptNumber}</div>
          {row.referenceNumber ? <div className="text-xs text-muted mono">{row.referenceNumber}</div> : null}
        </div>
      )
    },
    {
      key: 'account',
      header: 'Account',
      render: (row) => (
        <div>
          <div>{row.subscriberName}</div>
          <div className="text-xs text-muted mono">{row.serviceAccountNumber}</div>
        </div>
      )
    },
    { key: 'method', header: 'Method', render: (row) => <Badge label={humanizeToken(row.method)} status={row.method} /> },
    { key: 'amount', header: 'Amount', money: true, render: (row) => <span className="money">{row.amount}</span> },
    {
      key: 'advance',
      header: 'Advance',
      money: true,
      render: (row) =>
        row.advanceCentavos > 0 ? (
          <span className="money text-warning">{row.advance}</span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    { key: 'date', header: 'Received', render: (row) => formatDateTime(row.paymentDate) },
    { key: 'by', header: 'Posted by', render: (row) => row.postedByName },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="row" style={{ gap: 8 }}>
          <Badge status={row.status} />
          {can('payment.reverse') && row.status === 'POSTED' ? (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={(event) => {
                event.stopPropagation()
                setReversing(row)
              }}
            >
              Reverse
            </button>
          ) : null}
        </div>
      )
    }
  ]

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle="Every receipt posted, and the account it was applied to"
        actions={
          <>
            <ReportExportMenu path="/reports/payments" query={{ q: search, method }} suggestedName="bcis-payments-register" />
            {can('payment.create') ? (
              <button type="button" className="btn btn--primary" onClick={() => setShowReceive(true)}>
                Receive payment
              </button>
            ) : null}
          </>
        }
      />

      <div className="stack">
        <div className="stat-grid">
          <StatTile label="Receipts matching" value={formatNumber(list.query?.total ?? 0)} />
          <StatTile
            label="Total posted"
            value={displayMoney({ totalPostedCentavos: list.query?.totalPostedCentavos ?? 0 }, 'totalPosted')}
            tone="success"
            hint="Across the filtered set"
          />
        </div>

        <Panel flush title="Payment register">
          <div className="filter-bar">
            <label className="field filter-bar__grow">
              <span className="field__label">Search</span>
              <input
                className="input"
                value={search}
                placeholder="Receipt no., account no. or reference"
                onChange={(event) => {
                  setSearch(event.target.value)
                  list.setFilter('q', event.target.value)
                }}
              />
            </label>

            <label className="field">
              <span className="field__label">Method</span>
              <select
                className="select"
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value)
                  list.setFilter('method', event.target.value)
                }}
              >
                <option value="">All methods</option>
                {METHODS.map((option) => (
                  <option key={option} value={option}>
                    {humanizeToken(option)}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Status</span>
              <select
                className="select"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value)
                  list.setFilter('status', event.target.value)
                }}
              >
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {humanizeToken(option)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="btn"
              onClick={() => {
                setSearch('')
                setMethod('')
                setStatus('')
                list.resetFilters()
              }}
            >
              Clear
            </button>
          </div>

          <DataTable
            columns={columns}
            rows={list.query?.items ?? []}
            rowKey={(row) => row.id}
            loading={list.isPending}
            empty={<EmptyState title="No payments match these filters" />}
          />

          {list.query ? (
            <div className="panel__footer">
              <Pagination
                page={list.query.page}
                pageSize={list.query.pageSize}
                total={list.query.total}
                onChange={list.setPage}
              />
            </div>
          ) : null}
        </Panel>
      </div>

      {showReceive ? (
        <ReceivePaymentModal
          onClose={() => setShowReceive(false)}
          onPosted={(receipt) => {
            setShowReceive(false)
            push('success', `Receipt ${receipt} posted.`)
            list.refetch()
          }}
        />
      ) : null}

      {reversing ? (
        <ReversePaymentModal
          payment={reversing}
          onClose={() => setReversing(null)}
          onReversed={() => {
            setReversing(null)
            push('success', `${reversing.receiptNumber} was reversed.`)
            list.refetch()
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

/* -------------------------------------------------------- account picker */

/**
 * A typeahead over service accounts.
 *
 * This exists because `POST /payments` takes a service account **UUID**, and
 * asking a cashier to paste a UUID is how money gets posted to the wrong
 * account. The operator types a service account number, an account number or a
 * subscriber name and picks from the list; the id stays an internal detail.
 */
function AccountPicker({
  value,
  onChange,
  error
}: {
  value: string
  onChange: (id: string) => void
  error?: string
}): React.JSX.Element {
  const [term, setTerm] = useState('')

  const results = useApiQuery(
    ['service-accounts', 'picker', term],
    (client) =>
      client.get<{ items: ServiceAccountListRow[]; total: number }>('/service-accounts', {
        query: { q: term, page: 1, pageSize: 8 }
      }),
    { enabled: term.trim().length >= 2 }
  )

  const [selected, setSelected] = useState<ServiceAccountListRow | null>(null)

  if (value && selected?.id === value) {
    return (
      <div>
        <div className="field__label">
          Service account
          <span className="field__required" aria-label="required">
            *
          </span>
        </div>
        <div className="callout-row callout-row--info">
          <div>
            <div className="text-bold">
              {selected.subscriberName}{' '}
              <span className="mono text-muted">{selected.serviceAccountNumber}</span>
            </div>
            <div className="text-xs text-muted">
              {selected.planName} · {selected.areaName} · outstanding {selected.outstanding}
            </div>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              setSelected(null)
              onChange('')
            }}
          >
            Change
          </button>
        </div>
      </div>
    )
  }

  return (
    <Field label="Service account" required error={error} hint="Type at least 2 characters to search">
      <input
        className="input"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="SA-2026-000060, SUB-1050 or a subscriber name"
        autoFocus
      />
      {term.trim().length >= 2 ? (
        <div className="picker-list">
          {results.isPending ? (
            <div className="text-sm text-muted" style={{ padding: 'var(--space-2)' }}>
              Searching…
            </div>
          ) : results.data && results.data.items.length > 0 ? (
            results.data.items.map((row) => (
              <button
                key={row.id}
                type="button"
                className="picker-item"
                onClick={() => {
                  setSelected(row)
                  onChange(row.id)
                  setTerm('')
                }}
              >
                <span>
                  <strong>{row.subscriberName}</strong>{' '}
                  <span className="mono text-muted">{row.serviceAccountNumber}</span>
                  <span className="text-xs text-muted">
                    {' '}
                    · {row.planName} · {row.areaName}
                  </span>
                </span>
                <span className="money text-xs">{row.outstanding}</span>
              </button>
            ))
          ) : (
            <div className="text-sm text-muted" style={{ padding: 'var(--space-2)' }}>
              No service account matches “{term.trim()}”.
            </div>
          )}
        </div>
      ) : null}
    </Field>
  )
}

/* -------------------------------------------------------- receive payment */

interface ReceiveFormValues {
  serviceAccountId: string
  amount: string
  method: string
  referenceNumber: string
  notes: string
}

function ReceivePaymentModal({
  onClose,
  onPosted
}: {
  onClose: () => void
  onPosted: (receiptNumber: string) => void
}): React.JSX.Element {
  const [values, setValues] = useState<ReceiveFormValues>({
    serviceAccountId: '',
    amount: '',
    method: 'CASH',
    referenceNumber: '',
    notes: ''
  })

  const centavos = pesosToCentavos(values.amount)
  const amountError =
    values.amount.trim() === ''
      ? undefined
      : centavos === null
        ? 'Enter a peso amount with at most two decimal places.'
        : centavos <= 0
          ? 'Amount must be greater than zero.'
          : undefined

  const preview = useApiQuery<AllocationPreview>(
    ['allocation-preview', values.serviceAccountId, centavos],
    (client) =>
      client.get<AllocationPreview>('/payments/allocation-preview', {
        query: { serviceAccountId: values.serviceAccountId, amount: values.amount }
      }),
    { enabled: Boolean(values.serviceAccountId) && amountError === undefined && (centavos ?? 0) > 0 }
  )

  const post = useApiMutation<ReceiveFormValues, { receiptNumber: string }>(
    (client, body) =>
      client.post<{ receiptNumber: string }>('/payments', {
        serviceAccountId: body.serviceAccountId,
        // Peso string, deliberately: the server parses this into centavos.
        amount: body.amount,
        method: body.method,
        referenceNumber: body.referenceNumber || undefined,
        notes: body.notes || undefined
      }),
    { onSuccess: (result) => onPosted(result.receiptNumber) }
  )

  const set =
    (key: keyof ReceiveFormValues) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void =>
      setValues((current) => ({ ...current, [key]: event.target.value }))

  const canSubmit = Boolean(values.serviceAccountId) && amountError === undefined && (centavos ?? 0) > 0

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await post.mutateAsync(values).catch(() => undefined)
  }

  return (
    <Modal
      title="Receive payment"
      subtitle="The server allocates the amount to the oldest outstanding invoices first"
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="text-sm text-muted">Any unallocated remainder is held as credit on the account.</span>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="receive-payment-form"
              className="btn btn--primary"
              disabled={!canSubmit || post.isPending}
            >
              {post.isPending ? 'Posting…' : 'Post payment'}
            </button>
          </div>
        </>
      }
    >
      <form id="receive-payment-form" className="stack" onSubmit={submit}>
        {post.error ? (
          <Banner tone="error" title="The payment was not posted">
            {describeError(post.error)}
          </Banner>
        ) : null}

        <AccountPicker
          value={values.serviceAccountId}
          onChange={(id) => setValues((current) => ({ ...current, serviceAccountId: id }))}
          error={post.error?.fieldErrors.serviceAccountId}
        />

        <div className="form-grid">
          <Field label="Amount" required error={amountError ?? post.error?.fieldErrors.amount}>
            <MoneyInput value={values.amount} onChange={(amount) => setValues((c) => ({ ...c, amount }))} error={amountError} />
          </Field>
          <Field label="Method" required error={post.error?.fieldErrors.method}>
            <select className="select" value={values.method} onChange={set('method')}>
              {METHODS.map((option) => (
                <option key={option} value={option}>
                  {humanizeToken(option)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Reference number"
          error={post.error?.fieldErrors.referenceNumber}
          hint="GCash reference, cheque or deposit slip number"
        >
          <input className="input mono" value={values.referenceNumber} onChange={set('referenceNumber')} />
        </Field>

        <Field label="Notes" error={post.error?.fieldErrors.notes} hint="Optional">
          <textarea className="textarea" value={values.notes} onChange={set('notes')} rows={2} />
        </Field>

        <div>
          <div className="form-section__title">Where this will be applied</div>
          {preview.data ? (
            <>
              <DataTable
                columns={[
                  { key: 'invoice', header: 'Invoice', render: (row) => <span className="mono">{row.invoiceNumber}</span> },
                  { key: 'period', header: 'Period', render: (row) => row.period },
                  { key: 'due', header: 'Due', render: (row) => formatDateTime(row.dueDate) },
                  {
                    key: 'outstanding',
                    header: 'Outstanding',
                    money: true,
                    render: (row) => <span className="money">{displayMoney({ outstandingCentavos: row.outstandingCentavos }, 'outstanding')}</span>
                  },
                  {
                    key: 'applied',
                    header: 'Applied',
                    money: true,
                    render: (row) => <span className="money text-bold">{displayMoney({ amountCentavos: row.amountCentavos }, 'applied')}</span>
                  }
                ]}
                rows={preview.data.allocations}
                rowKey={(row) => row.invoiceId}
                empty={<EmptyState title="Nothing outstanding on this account" hint="The whole amount becomes credit on account." />}
                footer={
                  <tr className="total-row">
                    <td colSpan={3}>Advance credit</td>
                    <td />
                    <td className="money text-bold">{preview.data.total.advance}</td>
                  </tr>
                }
              />
              <div className="callout-row callout-row--info" style={{ marginTop: 'var(--space-3)' }}>
                <span>
                  Balance after this payment:{' '}
                  <strong>{displayMoney({ outstandingAfterCentavos: preview.data.outstandingAfterCentavos }, 'outstandingAfter')}</strong>
                </span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">
              {values.serviceAccountId
                ? 'Loading the allocation plan…'
                : 'Enter a service account to preview how the payment will be applied.'}
            </p>
          )}
        </div>
      </form>
    </Modal>
  )
}

/* ------------------------------------------------------- reverse payment */

function ReversePaymentModal({
  payment,
  onClose,
  onReversed
}: {
  payment: PaymentListRow
  onClose: () => void
  onReversed: () => void
}): React.JSX.Element {
  const [reason, setReason] = useState('')

  const reverse = useApiMutation<{ reason: string }, unknown>(
    (client, body) => client.post(`/payments/${payment.id}/reverse`, body),
    { onSuccess: onReversed }
  )

  const reasonError =
    reason.trim().length === 0
      ? 'A reversal reason is required.'
      : reason.trim().length < 5
        ? 'Give at least 5 characters so the audit trail is meaningful.'
        : undefined

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const ok = await confirmAction({
      message: `Reverse ${payment.receiptNumber}?`,
      detail: `The ${payment.amount} will be returned to the account balance and the receipt kept for audit. This cannot be undone from this screen.`,
      confirmLabel: 'Reverse payment',
      danger: true
    })
    if (!ok) {
      return
    }
    await reverse.mutateAsync({ reason: reason.trim() }).catch(() => undefined)
  }

  return (
    <Modal
      title={`Reverse ${payment.receiptNumber}`}
      subtitle="The amount is returned to the account balance and the receipt is kept for audit"
      onClose={onClose}
      width={560}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="reverse-payment-form"
            className="btn btn--danger"
            disabled={Boolean(reasonError) || reverse.isPending}
          >
            {reverse.isPending ? 'Reversing…' : 'Reverse payment'}
          </button>
        </div>
      }
    >
      <form id="reverse-payment-form" className="stack" onSubmit={submit}>
        {reverse.error ? (
          <Banner tone="error" title="The payment was not reversed">
            {describeError(reverse.error)}
          </Banner>
        ) : null}

        <Field label="Reason" required error={reasonError ?? reverse.error?.fieldErrors.reason}>
          <textarea
            className="textarea"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            autoFocus
            placeholder="e.g. Cheque bounced by the issuing bank"
          />
        </Field>
      </form>
    </Modal>
  )
}
