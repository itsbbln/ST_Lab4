/**
 * Receivables follow-up.
 *
 * The API's AR aging buckets are shown as the summary at the top, and the overdue
 * list below is the actionable half: each row is an account with arrears, its
 * collector, and whether it is a suspension candidate. The aging figures and the
 * shortage/overdue counts come from the server; nothing here is summed client-side.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { formatDate, formatNumber } from '../lib/format'
import { useApiQuery, usePagedList } from '../lib/query'
import { useNavigate } from '../lib/router'
import {
  Badge,
  DataTable,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  Panel,
  StatTile
} from '../components/ui'
import type { Column } from '../components/ui'
import type { AgingBucket, ItemsResponse, OverdueAccountRow, OverdueResponse } from '../types/api'

export function ReceivablesScreen(): React.JSX.Element {
  const navigate = useNavigate()

  const [areaId, setAreaId] = useState('')
  const [collectorId, setCollectorId] = useState('')
  const [onlyCandidates, setOnlyCandidates] = useState('')

  const aging = useApiQuery<ItemsResponse<AgingBucket>>(['receivables', 'aging'], (client) =>
    client.get<ItemsResponse<AgingBucket>>('/receivables/aging')
  )

  const overdue = usePagedList<OverdueAccountRow, OverdueResponse>('/receivables/overdue', {
    areaId,
    collectorId,
    onlyCandidates
  })

  const buckets = aging.data?.items ?? []
  const current = buckets.find((bucket) => bucket.bucket === 'CURRENT')
  const overdueBuckets = buckets.filter((bucket) => bucket.bucket !== 'CURRENT')
  const overdueTotal = overdueBuckets.reduce((sum, bucket) => sum + bucket.amountCentavos, 0)

  if (overdue.error?.isUnreachable) {
    return <LoadError message={describeError(overdue.error)} onRetry={overdue.refetch} />
  }

  const columns: Array<Column<OverdueAccountRow>> = [
    {
      key: 'account',
      header: 'Account',
      render: (row) => (
        <div>
          <div className="text-bold">{row.subscriberName}</div>
          <div className="text-xs text-muted mono">
            {row.serviceAccountNumber} · {row.subscriberAccountNumber}
          </div>
        </div>
      )
    },
    { key: 'plan', header: 'Plan', render: (row) => row.planName },
    { key: 'area', header: 'Area', render: (row) => row.areaName },
    { key: 'collector', header: 'Collector', render: (row) => row.collectorName ?? 'Unassigned' },
    {
      key: 'months',
      header: 'Months unpaid',
      align: 'right',
      render: (row) => (
        <span className={row.monthsUnpaid >= 3 ? 'text-danger text-bold' : undefined}>{formatNumber(row.monthsUnpaid)}</span>
      )
    },
    {
      key: 'current',
      header: 'Current bill',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ currentBillCentavos: row.currentBillCentavos }, 'currentBill')}</span>
      )
    },
    {
      key: 'arrears',
      header: 'Arrears',
      money: true,
      render: (row) => (
        <span className="money text-danger text-bold">
          {displayMoney({ arrearsCentavos: row.arrearsCentavos }, 'arrears')}
        </span>
      )
    },
    {
      key: 'oldest',
      header: 'Oldest invoice',
      render: (row) =>
        row.oldestUnpaidInvoice ? (
          <div>
            <div className="mono text-sm">{row.oldestUnpaidInvoice.invoiceNumber}</div>
            <div className="text-xs text-muted">
              {formatDate(row.oldestUnpaidInvoice.dueDate)} · {formatNumber(row.oldestUnpaidInvoice.daysPastDue)} days
            </div>
          </div>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    {
      key: 'candidate',
      header: 'Suspension',
      render: (row) =>
        row.isSuspensionCandidate ? <Badge status="SUSPENDED" label="Candidate" /> : <span className="text-subtle">—</span>
    }
  ]

  return (
    <>
      <PageHeader
        title="Receivables"
        subtitle="What is owed, how old it is, and who is collecting it"
        actions={
          <button type="button" className="btn" onClick={() => void printCurrent('page')}>
            Print
          </button>
        }
      />

      <div className="stack">
        <div className="stat-grid">
          <StatTile
            label="Current"
            value={displayMoney({ currentCentavos: current?.amountCentavos ?? 0 }, 'current')}
            tone="info"
            hint={`${formatNumber(current?.invoiceCount ?? 0)} invoice(s) not yet due`}
          />
          <StatTile
            label="Overdue"
            value={displayMoney({ overdueCentavos: overdueTotal }, 'overdue')}
            tone="danger"
            hint={`${formatNumber(overdueBuckets.reduce((sum, bucket) => sum + bucket.invoiceCount, 0))} invoice(s)`}
          />
          <StatTile
            label="Total outstanding"
            value={displayMoney({ totalCentavos: overdueTotal + (current?.amountCentavos ?? 0) }, 'total')}
            tone="warning"
          />
          <StatTile
            label="Accounts to follow up"
            value={formatNumber(overdue.query?.total ?? 0)}
            hint="Accounts with arrears past the due date"
          />
        </div>

        <Panel title="Aging" subtitle="Outstanding balance by how old the oldest unpaid invoice is" flush>
          <DataTable
            columns={[
              { key: 'bucket', header: 'Bucket', render: (row) => row.label },
              { key: 'invoices', header: 'Invoices', align: 'right', render: (row) => formatNumber(row.invoiceCount) },
              { key: 'accounts', header: 'Accounts', align: 'right', render: (row) => formatNumber(row.accountCount) },
              {
                key: 'amount',
                header: 'Outstanding',
                money: true,
                render: (row) => (
                  <span className="money">{displayMoney({ amountCentavos: row.amountCentavos }, 'amount')}</span>
                )
              },
              {
                key: 'share',
                header: 'Share',
                align: 'right',
                render: (row) =>
                  overdueTotal > 0 ? `${((row.amountCentavos / overdueTotal) * 100).toFixed(1)}%` : '—'
              }
            ]}
            rows={buckets}
            rowKey={(row) => row.bucket}
            loading={aging.isPending}
            empty={<EmptyState title="No receivables outstanding" />}
            footer={
              buckets.length > 0 ? (
                <tr className="total-row">
                  <td>Total</td>
                  <td className="money text-bold">
                    {formatNumber(buckets.reduce((sum, bucket) => sum + bucket.invoiceCount, 0))}
                  </td>
                  <td />
                  <td className="money text-bold">
                    {displayMoney(
                      { totalCentavos: buckets.reduce((sum, bucket) => sum + bucket.amountCentavos, 0) },
                      'total'
                    )}
                  </td>
                  <td />
                </tr>
              ) : undefined
            }
          />
        </Panel>

        {overdue.query && overdue.query.total > 0 ? (
          <Panel flush title="Accounts with arrears" subtitle="Most behind on payment first">
            <div className="filter-bar">
              <label className="field">
                <span className="field__label">Collection area</span>
                <input
                  className="input"
                  value={areaId}
                  placeholder="All areas"
                  onChange={(event) => {
                    setAreaId(event.target.value)
                    overdue.setFilter('areaId', event.target.value)
                  }}
                />
              </label>
              <label className="field">
                <span className="field__label">Collector</span>
                <input
                  className="input"
                  value={collectorId}
                  placeholder="All collectors"
                  onChange={(event) => {
                    setCollectorId(event.target.value)
                    overdue.setFilter('collectorId', event.target.value)
                  }}
                />
              </label>
              <label className="field">
                <span className="field__label">Suspension</span>
                <select
                  className="select"
                  value={onlyCandidates}
                  onChange={(event) => {
                    setOnlyCandidates(event.target.value)
                    overdue.setFilter('onlyCandidates', event.target.value)
                  }}
                >
                  <option value="">All accounts</option>
                  <option value="true">Suspension candidates only</option>
                  <option value="false">Not yet candidates</option>
                </select>
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setAreaId('')
                  setCollectorId('')
                  setOnlyCandidates('')
                  overdue.resetFilters()
                }}
              >
                Clear
              </button>
            </div>

            <DataTable
              columns={columns}
              rows={overdue.query.items}
              rowKey={(row) => row.serviceAccountId}
              loading={overdue.isPending}
              onRowClick={(row) => navigate(`/service-accounts/${row.serviceAccountId}`)}
              empty={<EmptyState title="No accounts match these filters" />}
            />

            <div className="panel__footer">
              <Pagination
                page={overdue.query.page}
                pageSize={overdue.query.pageSize}
                total={overdue.query.total}
                onChange={overdue.setPage}
              />
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  )
}
