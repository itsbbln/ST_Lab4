/**
 * Management dashboard.
 *
 * The specification calls for six widgets: collections against what was billed,
 * AR aging, collector performance, overdue alerts, recent payments and the GCash
 * verification workload.
 *
 * The API's `/dashboard` response covers most of that in one round trip, but it
 * deliberately does not pre-compute aging or per-collector performance, because
 * both are reports. So those two widgets query `/receivables/aging` and
 * `/reports/collector-performance` alongside the dashboard rather than being
 * faked from figures the dashboard does not send. Every peso value displayed is
 * the server's own string, via `displayMoney`.
 */

import {
  Badge,
  Banner,
  DataTable,
  EmptyState,
  LoadError,
  PageHeader,
  Panel,
  StatTile
} from '../components/ui'
import type { Column } from '../components/ui'
import { displayMoney } from '../lib/api'
import { describeError } from '../lib/desktop'
import { formatDate, formatDateTime, formatNumber, humanizeToken } from '../lib/format'
import { useApiQuery } from '../lib/query'
import { useNavigate } from '../lib/router'
import type {
  AgingBucket,
  CollectorPerformanceRow,
  DashboardResponse,
  DashboardOverdueAccount,
  ItemsResponse
} from '../types/api'

export function DashboardScreen(): React.JSX.Element {
  const navigate = useNavigate()

  const dashboard = useApiQuery<DashboardResponse>(['dashboard'], (client) => client.get<DashboardResponse>('/dashboard'))

  const aging = useApiQuery<ItemsResponse<AgingBucket>>(['receivables', 'aging'], (client) =>
    client.get<ItemsResponse<AgingBucket>>('/receivables/aging')
  )

  const performance = useApiQuery<ItemsResponse<CollectorPerformanceRow>>(
    ['reports', 'collector-performance'],
    (client) => client.get<ItemsResponse<CollectorPerformanceRow>>('/reports/collector-performance')
  )

  const { data, error, isPending, refetch } = dashboard

  if (error && !data) {
    return <LoadError message={describeError(error)} onRetry={() => void refetch()} />
  }

  const receivables = data?.receivables
  const billing = data?.billing
  const collections = data?.collections
  const accounts = data?.accounts
  const batches = data?.collectionBatches
  const gcash = data?.gcash

  const agingColumns: Array<Column<AgingBucket>> = [
    { key: 'bucket', header: 'Bucket', render: (row) => row.label },
    { key: 'invoices', header: 'Invoices', align: 'right', render: (row) => formatNumber(row.invoiceCount) },
    { key: 'accounts', header: 'Accounts', align: 'right', render: (row) => formatNumber(row.accountCount) },
    {
      key: 'amount',
      header: 'Outstanding',
      money: true,
      render: (row) => <span className="money">{displayMoney({ outstandingCentavos: row.amountCentavos }, 'outstanding')}</span>
    }
  ]

  const agingRows = aging.data?.items ?? []
  const agingTotal = agingRows.reduce((sum, bucket) => sum + bucket.amountCentavos, 0)
  const overdueBuckets = agingRows.filter((bucket) => bucket.bucket !== 'CURRENT').length

  const collectorColumns: Array<Column<CollectorPerformanceRow>> = [
    { key: 'collector', header: 'Collector', render: (row) => <span className="text-bold">{row.collectorName}</span> },
    { key: 'batches', header: 'Batches', align: 'right', render: (row) => formatNumber(row.batchCount) },
    {
      key: 'expected',
      header: 'Expected',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ expectedReceivableCentavos: row.expectedReceivableCentavos }, 'expected')}</span>
      )
    },
    {
      key: 'collected',
      header: 'Collected',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ totalCollectedCentavos: row.totalCollectedCentavos }, 'collected')}</span>
      )
    },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      render: (row) => `${row.collectionRate.toFixed(1)}%`
    },
    {
      key: 'variance',
      header: 'Shortage / overage',
      money: true,
      render: (row) => (
        <VarianceCell shortage={row.shortageCentavos} overage={row.overageCentavos} />
      )
    }
  ]

  const collectorRows = performance.data?.items ?? []
  const shortageTotal = collectorRows.reduce((sum, row) => sum + row.shortageCentavos, 0)

  const overdueColumns: Array<Column<DashboardOverdueAccount>> = [
    {
      key: 'account',
      header: 'Account',
      render: (row) => (
        <div>
          <div className="text-bold">{row.subscriberName}</div>
          <div className="text-xs text-muted mono">{row.accountNumber}</div>
        </div>
      )
    },
    { key: 'days', header: 'Days overdue', align: 'right', render: (row) => formatNumber(row.daysOverdue) },
    {
      key: 'amount',
      header: 'Amount due',
      money: true,
      render: (row) => <span className="money text-danger text-bold">{row.amount}</span>
    }
  ]

  const methodColumns: Array<Column<{ method: string; count: number; amount: string }>> = [
    { key: 'method', header: 'Method', render: (row) => <Badge label={humanizeToken(row.method)} status={row.method} /> },
    { key: 'count', header: 'Payments', align: 'right', render: (row) => formatNumber(row.count) },
    { key: 'amount', header: 'Amount', money: true, render: (row) => <span className="money">{row.amount}</span> }
  ]

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          data
            ? `${formatDate(data.period.from)} – ${formatDate(data.period.to)} · position as of ${formatDateTime(data.generatedAt)}`
            : 'Loading the current position…'
        }
        actions={
          <button type="button" className="btn" onClick={() => void refetch()}>
            Refresh
          </button>
        }
      />

      <div className="stack">
        {shortageTotal > 0 ? (
          <Banner tone="warning" title="Unreconciled collection shortage">
            {displayMoney({ shortageCentavos: shortageTotal }, 'shortage')} is recorded as shortage on open batches. Review it
            under Collections.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile
            label="Collected this month"
            value={collections?.received ?? '—'}
            tone="success"
            hint={`${formatNumber(collections?.paymentsInPeriod)} payments · avg ${collections?.averagePayment ?? '—'}`}
          />
          <StatTile
            label="Billed this month"
            value={formatNumber(billing?.issuedInPeriod)}
            tone="info"
            hint={`${formatNumber(billing?.paidInPeriod)} paid · ${formatNumber(billing?.outstandingInvoices)} outstanding`}
          />
          <StatTile
            label="Total outstanding"
            value={receivables?.totalOutstanding ?? '—'}
            tone={receivables && receivables.overdueCentavos > 0 ? 'danger' : 'success'}
            hint={`${formatNumber(receivables?.overdueAccounts)} accounts overdue`}
          />
          <StatTile
            label="Overdue"
            value={receivables?.overdue ?? '—'}
            tone="danger"
            hint={`${receivables?.collectionRate ?? 0}% collection rate`}
          />
          <StatTile
            label="Active accounts"
            value={formatNumber(accounts?.active)}
            hint={`${formatNumber(accounts?.suspended)} suspended · ${formatNumber(accounts?.pendingActivation)} pending`}
          />
          <StatTile
            label="Subscribers"
            value={formatNumber(data?.subscribers.total)}
            hint={`${formatNumber(data?.subscribers.active)} active · ${formatNumber(data?.subscribers.newInPeriod)} new`}
          />
          <StatTile
            label="GCash to verify"
            value={formatNumber(gcash?.pending)}
            tone={gcash && gcash.pending > 0 ? 'warning' : 'success'}
            hint={`${formatNumber(gcash?.verifiedInPeriod)} verified · ${formatNumber(gcash?.rejectedInPeriod)} rejected`}
          />
          <StatTile
            label="Collection batches"
            value={formatNumber(batches?.open)}
            hint={`${formatNumber(batches?.inProgress)} in progress · ${formatNumber(batches?.remitted)} remitted`}
          />
        </div>

        <div className="grid-2">
          <Panel
            title="Accounts receivable aging"
            subtitle={aging.isPending ? 'Loading…' : `${overdueBuckets} overdue buckets`}
            flush
            actions={
              <button type="button" className="btn btn--sm" onClick={() => navigate('/receivables')}>
                All receivables
              </button>
            }
          >
            <DataTable
              columns={agingColumns}
              rows={agingRows}
              rowKey={(row) => row.bucket}
              loading={aging.isPending}
              onRowClick={() => navigate('/receivables')}
              empty={<EmptyState title="No receivables outstanding" />}
              footer={
                agingRows.length > 0 ? (
                  <tr className="total-row">
                    <td>Total outstanding</td>
                    <td className="money text-bold">
                      {formatNumber(agingRows.reduce((sum, bucket) => sum + bucket.invoiceCount, 0))}
                    </td>
                    <td />
                    <td className="money text-bold">
                      {displayMoney({ outstandingCentavos: agingTotal }, 'outstanding')}
                    </td>
                  </tr>
                ) : undefined
              }
            />
          </Panel>

          <Panel
            title="Collector performance"
            subtitle="House-to-house results for the current period"
            flush
            actions={
              <button type="button" className="btn btn--sm" onClick={() => navigate('/reports')}>
                Open reports
              </button>
            }
          >
            <DataTable
              columns={collectorColumns}
              rows={collectorRows}
              rowKey={(row) => row.collectorId}
              loading={performance.isPending}
              empty={<EmptyState title="No collection activity in this period" hint="Batches appear here once a collector submits one." />}
            />
          </Panel>
        </div>

        <div className="grid-2">
          <Panel
            title="Overdue alerts"
            subtitle="Largest arrears first"
            flush
            actions={
              <button type="button" className="btn btn--sm" onClick={() => navigate('/receivables')}>
                All receivables
              </button>
            }
          >
            <DataTable
              columns={overdueColumns}
              rows={data?.topOverdue ?? []}
              rowKey={(row) => row.accountNumber}
              loading={isPending}
              onRowClick={() => navigate('/receivables')}
              empty={<EmptyState title="Nothing overdue" hint="Every issued invoice is within its due window." />}
            />
          </Panel>

          <Panel title="Payments this period" subtitle="How customers are paying" flush>
            <DataTable
              columns={methodColumns}
              rows={collections?.byMethod ?? []}
              rowKey={(row) => row.method}
              loading={isPending}
              empty={<EmptyState title="No payments in this period" />}
            />
          </Panel>
        </div>
      </div>
    </>
  )
}

/** Shortage and overage share a column; only the non-zero side is shown. */
function VarianceCell({ shortage, overage }: { shortage: number; overage: number }): React.JSX.Element {
  if (shortage > 0) {
    return <span className="money text-danger">{displayMoney({ shortageCentavos: shortage }, 'shortage')}</span>
  }
  if (overage > 0) {
    return <span className="money text-warning">{displayMoney({ overageCentavos: overage }, 'overage')}</span>
  }
  return <span className="money text-subtle">—</span>
}
