/**
 * The invoice register and, for one invoice, its statement.
 *
 * Register figures are the server's own strings (`total`, `paid`, `balance`), so
 * the column totals on this screen are the same numbers the API reports in
 * `totalBalanceCentavos` rather than a client-side sum that could disagree.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { formatDate, formatNumber, humanizeToken } from '../lib/format'
import { useApiQuery, usePagedList } from '../lib/query'
import { useAuth } from '../lib/auth'
import {
  Badge,
  Banner,
  DataTable,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  Panel,
  StatTile
} from '../components/ui'
import type { Column } from '../components/ui'
import type { InvoiceDetail, InvoiceListResponse, InvoiceListRow, LedgerResponse } from '../types/api'

/**
 * The seven statuses the API accepts as a filter, taken from the shared
 * `invoiceStatuses` list. Verified against the running API: offering anything
 * outside this set makes the register respond 400, so a name like `ISSUED` would
 * have looked like an empty screen rather than an error.
 */
const STATUS_OPTIONS = ['DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'CREDITED'] as const

export function InvoicesScreen(): React.JSX.Element {
  const { can } = useAuth()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [period, setPeriod] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const list = usePagedList<InvoiceListRow, InvoiceListResponse>(
    '/invoices',
    { q: search, status, period }
  )

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  if (selectedId) {
    return <InvoiceStatement invoiceId={selectedId} onBack={() => setSelectedId(null)} />
  }

  const rows = list.query?.items ?? []
  const totalBalance = list.query?.totalBalanceCentavos ?? 0

  const columns: Array<Column<InvoiceListRow>> = [
    {
      key: 'invoice',
      header: 'Invoice',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.invoiceNumber}</div>
          <div className="text-xs text-muted">
            {row.serviceAccountNumber} · {row.planName}
          </div>
        </div>
      )
    },
    {
      key: 'subscriber',
      header: 'Subscriber',
      render: (row) => (
        <div>
          <div>{row.subscriberName}</div>
          <div className="text-xs text-muted mono">{row.accountNumber}</div>
        </div>
      )
    },
    { key: 'period', header: 'Period', render: (row) => <span className="mono">{row.period}</span> },
    { key: 'due', header: 'Due', render: (row) => formatDate(row.dueDate) },
    { key: 'total', header: 'Total', money: true, render: (row) => <span className="money">{row.total}</span> },
    { key: 'paid', header: 'Paid', money: true, render: (row) => <span className="money">{row.paid}</span> },
    {
      key: 'balance',
      header: 'Balance',
      money: true,
      render: (row) => (
        <span className={`money${row.balanceCentavos > 0 ? ' text-bold' : ' text-subtle'}`}>{row.balance}</span>
      )
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> }
  ]

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Every invoice raised by a billing cycle, with the account it belongs to"
      />

      <div className="stack">
        <div className="stat-grid">
          <StatTile label="Invoices matching" value={formatNumber(list.query?.total ?? 0)} />
          <StatTile
            label="Outstanding balance"
            value={displayMoney({ balanceCentavos: totalBalance }, 'balance')}
            tone={totalBalance > 0 ? 'warning' : 'success'}
            hint="Across the filtered set"
          />
        </div>

        <Panel flush title="Invoice register">
          <div className="filter-bar">
            <label className="field filter-bar__grow">
              <span className="field__label">Search</span>
              <input
                className="input"
                value={search}
                placeholder="Invoice no., account no., subscriber or service account"
                onChange={(event) => {
                  setSearch(event.target.value)
                  list.setFilter('q', event.target.value)
                }}
              />
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

            <label className="field">
              <span className="field__label">Period</span>
              <input
                className="input mono"
                value={period}
                placeholder="2026-09"
                onChange={(event) => {
                  setPeriod(event.target.value)
                  list.setFilter('period', event.target.value)
                }}
              />
            </label>

            <button
              type="button"
              className="btn"
              onClick={() => {
                setSearch('')
                setStatus('')
                setPeriod('')
                list.resetFilters()
              }}
            >
              Clear
            </button>

            {can('billing.generate') ? (
              <span className="text-sm text-muted">
                Voids and adjustments are available from the invoice statement.
              </span>
            ) : null}
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={list.isPending}
            onRowClick={(row) => setSelectedId(row.id)}
            empty={<EmptyState title="No invoices match these filters" hint="Clear the filters or try another period." />}
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
    </>
  )
}

/* ------------------------------------------------------------- statement */

function InvoiceStatement({ invoiceId, onBack }: { invoiceId: string; onBack: () => void }): React.JSX.Element {
  const invoice = useApiQuery<InvoiceDetail>(['invoices', invoiceId], (client) =>
    client.get<InvoiceDetail>(`/invoices/${invoiceId}`)
  )

  const ledger = useApiQuery<LedgerResponse>(
    ['ledger', invoice.data?.serviceAccountId],
    (client) =>
      client.get<LedgerResponse>(`/ledger/${invoice.data?.serviceAccountId}`, {
        query: { page: 1, pageSize: 25 }
      }),
    { enabled: Boolean(invoice.data?.serviceAccountId) }
  )

  if (invoice.isPending) {
    return <LoadError message="Loading the invoice…" />
  }
  if (invoice.error || !invoice.data) {
    return <LoadError message={describeError(invoice.error)} onRetry={() => void invoice.refetch()} />
  }

  const data = invoice.data
  const isVoid = data.status === 'VOID'

  return (
    <>
      <PageHeader
        title={data.invoiceNumber}
        subtitle={`${data.subscriberName} · ${data.serviceAccountNumber} · period ${data.period}`}
        actions={
          <>
            <button type="button" className="btn" onClick={onBack}>
              Back to register
            </button>
            <button type="button" className="btn" onClick={() => void printCurrent('page')}>
              Print
            </button>
          </>
        }
      />

      <div className="stack">
        {isVoid ? (
          <Banner tone="error" title="This invoice was voided">
            {data.voidReason ?? 'No reason was recorded.'} It no longer contributes to the receivable.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile label="Total" value={data.totals.total} tone="info" />
          <StatTile label="Paid" value={data.totals.paid} tone="success" />
          <StatTile
            label="Balance"
            value={data.totals.balance}
            tone={data.balanceCentavos > 0 ? 'warning' : 'success'}
          />
          <StatTile
            label="Due date"
            value={formatDate(data.dueDate)}
            hint={`Issued ${formatDate(data.issueDate)}`}
          />
        </div>

        <div className="grid-2">
          <Panel title="Invoice details" flush>
            <div className="panel__body">
              <dl className="kv">
                <div className="kv__row">
                  <dt className="kv__key">Status</dt>
                  <dd className="kv__value">
                    <Badge status={data.status} />
                  </dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Account number</dt>
                  <dd className="kv__value mono">{data.accountNumber}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Service account</dt>
                  <dd className="kv__value mono">{data.serviceAccountNumber}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Installation address</dt>
                  <dd className="kv__value">{data.installationAddress}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Finalized</dt>
                  <dd className="kv__value">{data.isFinalized ? 'Yes' : 'No'}</dd>
                </div>
              </dl>
            </div>
          </Panel>

          <Panel title="Payments applied" flush>
            {data.payments.length === 0 ? (
              <EmptyState title="Nothing paid against this invoice yet" />
            ) : (
              <DataTable
                columns={[
                  { key: 'receipt', header: 'Receipt', render: (row) => <span className="mono">{row.receiptNumber}</span> },
                  { key: 'date', header: 'Date', render: (row) => formatDate(row.paymentDate) },
                  { key: 'method', header: 'Method', render: (row) => <Badge label={humanizeToken(row.method)} status={row.method} /> },
                  { key: 'amount', header: 'Amount', money: true, render: (row) => <span className="money">{row.amount}</span> }
                ]}
                rows={data.payments}
                rowKey={(row) => row.id}
              />
            )}
          </Panel>
        </div>

        <Panel title="Line items" flush>
          <DataTable
            columns={[
              { key: 'description', header: 'Description', render: (row) => row.description },
              { key: 'type', header: 'Type', render: (row) => <Badge label={humanizeToken(row.itemType)} status={row.itemType} /> },
              { key: 'quantity', header: 'Qty', align: 'right', render: (row) => row.quantity },
              { key: 'unit', header: 'Unit price', money: true, render: (row) => displayMoney({ unitPriceCentavos: row.unitPriceCentavos }, 'unit') },
              { key: 'amount', header: 'Amount', money: true, render: (row) => <span className="money">{row.amount}</span> }
            ]}
            rows={data.items}
            rowKey={(row) => row.id}
            empty={<EmptyState title="This invoice has no line items" />}
            footer={
              <tr className="total-row">
                <td colSpan={4}>Total</td>
                <td className="money text-bold">{data.totals.total}</td>
              </tr>
            }
          />
        </Panel>

        <Panel
          title="Account ledger"
          subtitle="Every posting on this account, oldest first, with a running balance"
          flush
        >
          <DataTable
            columns={[
              { key: 'date', header: 'Date', render: (row) => formatDate(row.entryDate) },
              { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
              { key: 'description', header: 'Description', render: (row) => row.description },
              { key: 'type', header: 'Type', render: (row) => <Badge label={humanizeToken(row.entryType)} status={row.entryType} /> },
              {
                key: 'debit',
                header: 'Debit',
                money: true,
                render: (row) =>
                  row.debitCentavos > 0 ? (
                    <span className="money">{displayMoney({ debitCentavos: row.debitCentavos }, 'debit')}</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )
              },
              {
                key: 'credit',
                header: 'Credit',
                money: true,
                render: (row) =>
                  row.creditCentavos > 0 ? (
                    <span className="money text-success">{displayMoney({ creditCentavos: row.creditCentavos }, 'credit')}</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )
              },
              {
                key: 'balance',
                header: 'Balance',
                money: true,
                render: (row) => <span className="money text-bold">{displayMoney({ balanceCentavos: row.balanceCentavos }, 'balance')}</span>
              }
            ]}
            rows={ledger.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={ledger.isPending}
            empty={<EmptyState title="No ledger entries for this account" />}
            footer={
              ledger.data ? (
                <tr className="total-row">
                  <td colSpan={6}>Closing balance</td>
                  <td className="money text-bold">
                    {displayMoney({ balanceCentavos: ledger.data.closingBalanceCentavos }, 'balance')}
                  </td>
                </tr>
              ) : undefined
            }
          />
        </Panel>
      </div>
    </>
  )
}
