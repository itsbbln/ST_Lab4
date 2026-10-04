/**
 * Collection batches and remittances.
 *
 * A batch is the collector's day of work: opened, accounts loaded, money
 * collected, then closed. Remittance is the money coming back to the office, and
 * the difference between cash collected and cash remitted is a **shortage** or an
 * **overage**.
 *
 * The shortage column is deliberately the most prominent thing on this screen. A
 * confirmed remittance that is short is a control point in the specification, and
 * burying it in a tooltip is how a missing ₱500 goes unnoticed for a month.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { formatDate, formatDateTime, formatNumber, humanizeToken } from '../lib/format'
import { useApiQuery, usePagedList } from '../lib/query'
import { useNavigate, useQueryParam } from '../lib/router'
import {
  Badge,
  Banner,
  DataTable,
  EmptyState,
  LoadError,
  PageHeader,
  Pagination,
  Panel,
  StatTile,
  TabBar
} from '../components/ui'
import type { Column } from '../components/ui'
import type { CollectorRow, CollectionBatchRow, ItemsResponse, RemittanceRow } from '../types/api'

/**
 * `GET /collection/batches/:id` returns the batch plus its loaded accounts, every
 * remittance attempt, and the confirmed one. Note that an account row has no
 * per-account shortage: the shortage is a property of the remittance, because it
 * is the collector's declared count that differs from the cash handed back.
 */
interface BatchAccountRow {
  id: string
  serviceAccountId: string
  accountNumber: string
  subscriberName: string
  address: string
  serviceTypeCode: string
  currentBillCentavos: number
  arrearsCentavos: number
  totalDueCentavos: number
  collectedCentavos: number
  status: string
  collectionNotes: string | null
  collectedAt: string | null
}

interface BatchDetailResponse extends CollectionBatchRow {
  dueDayCutoff: number
  notes: string | null
  openedBy: string
  reconciledByName: string | null
  closedBy: string | null
  accounts: BatchAccountRow[]
  remittances: RemittanceRow[]
  confirmedRemittance: RemittanceRow | null
}

const BATCH_STATUSES = ['OPEN', 'IN_PROGRESS', 'SUBMITTED', 'REMITTED', 'RECONCILED', 'CLOSED'] as const
const REMITTANCE_STATUSES = ['SUBMITTED', 'CONFIRMED', 'REJECTED'] as const

type CollectionsTab = 'batches' | 'remittances'

/**
 * The sidebar has a separate entry for batches and remittances, so the route
 * chooses the tab rather than the screen owning the navigation.
 */
export function CollectionsScreen({ initialTab = 'batches' }: { initialTab?: CollectionsTab } = {}): React.JSX.Element {
  const [tab, setTab] = useState<CollectionsTab>(initialTab)

  return (
    <>
      <PageHeader
        title="Collections"
        subtitle="House-to-house batches, and the money coming back to the office"
        tabs={
          <TabBar
            tabs={[
              { key: 'batches', label: 'Batches' },
              { key: 'remittances', label: 'Remittances' }
            ]}
            active={tab}
            onChange={(key) => setTab(key === 'remittances' ? 'remittances' : 'batches')}
          />
        }
      />

      {tab === 'batches' ? <BatchesTab /> : <RemittancesTab />}
    </>
  )
}

/* ---------------------------------------------------------------- batches */

function BatchesTab(): React.JSX.Element {
  const navigate = useNavigate()
  /**
   * The performance report links here as `/collections?collectorId=…`, so the
   * filter arrives as a query param rather than as navigation state.
   */
  const initialCollectorId = useQueryParam('collectorId') ?? ''
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [collectorId, setCollectorId] = useState(initialCollectorId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const list = usePagedList<CollectionBatchRow>('/collection/batches', { status, q: search, collectorId })

  /** Populates the collector picker; failures just leave the list unfiltered. */
  const collectors = useApiQuery<ItemsResponse<CollectorRow>>(['collectors', 'active'], (client) =>
    client.get<ItemsResponse<CollectorRow>>('/collectors', { query: { activeOnly: 'true' } })
  )

  if (selectedId) {
    return (
      <BatchDetail
        batchId={selectedId}
        onBack={() => setSelectedId(null)}
        onOpenAccount={(serviceAccountId) => navigate(`/service-accounts/${serviceAccountId}`)}
      />
    )
  }

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const rows = list.query?.items ?? []
  const outstanding = rows.reduce((sum, row) => sum + row.uncollectedCentavos, 0)
  const collectorOptions = collectors.data?.items ?? []

  const columns: Array<Column<CollectionBatchRow>> = [
    {
      key: 'batch',
      header: 'Batch',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.batchNumber}</div>
          <div className="text-xs text-muted">{formatDate(row.batchDate)}</div>
        </div>
      )
    },
    { key: 'collector', header: 'Collector', render: (row) => row.collectorName },
    { key: 'area', header: 'Area / route', render: (row) => `${row.areaName} · ${row.routeName}` },
    { key: 'accounts', header: 'Accounts', align: 'right', render: (row) => formatNumber(row.accountCount) },
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
      key: 'uncollected',
      header: 'Uncollected',
      money: true,
      render: (row) =>
        row.uncollectedCentavos > 0 ? (
          <span className="money text-warning">
            {displayMoney({ uncollectedCentavos: row.uncollectedCentavos }, 'uncollected')}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> }
  ]

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile label="Batches matching" value={formatNumber(list.query?.total ?? 0)} />
        <StatTile
          label="Uncollected on this page"
          value={displayMoney({ uncollectedCentavos: outstanding }, 'uncollected')}
          tone={outstanding > 0 ? 'warning' : 'success'}
          hint="Money expected but not yet taken"
        />
      </div>

      <Panel flush title="Collection batches">
        <div className="filter-bar">
          <label className="field filter-bar__grow">
            <span className="field__label">Search</span>
            <input
              className="input"
              value={search}
              placeholder="Batch number or collector"
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
              {BATCH_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {humanizeToken(option)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Collector</span>
            <select
              className="select"
              value={collectorId}
              onChange={(event) => {
                setCollectorId(event.target.value)
                list.setFilter('collectorId', event.target.value)
              }}
            >
              <option value="">All collectors</option>
              {collectorOptions.map((collector) => (
                <option key={collector.id} value={collector.id}>
                  {collector.fullName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSearch('')
              setStatus('')
              setCollectorId('')
              list.resetFilters()
            }}
          >
            Clear
          </button>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={list.isPending}
          onRowClick={(row) => setSelectedId(row.id)}
          empty={<EmptyState title="No collection batches match these filters" />}
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
  )
}

function BatchDetail({
  batchId,
  onBack,
  onOpenAccount
}: {
  batchId: string
  onBack: () => void
  /** Set by the list; absent when the screen is reused without a router. */
  onOpenAccount?: (serviceAccountId: string) => void
}): React.JSX.Element {
  const batch = useApiQuery<BatchDetailResponse>(
    ['collection', 'batches', batchId],
    (client) => client.get<BatchDetailResponse>(`/collection/batches/${batchId}`)
  )

  if (batch.error || !batch.data) {
    return <LoadError message={describeError(batch.error)} onRetry={() => void batch.refetch()} />
  }

  const data = batch.data
  const remittance = data.confirmedRemittance ?? data.remittances[0] ?? null
  const timeline: Array<{ label: string; at: string | null }> = [
    { label: 'Opened', at: data.submittedAt },
    { label: 'Remitted', at: data.remittedAt },
    { label: 'Reconciled', at: data.reconciledAt },
    { label: 'Closed', at: data.closedAt }
  ]

  return (
    <>
      <PageHeader
        title={data.batchNumber}
        subtitle={`${data.collectorName} · ${data.areaName} · ${formatDate(data.batchDate)}`}
        actions={
          <>
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
            <button type="button" className="btn" onClick={() => void printCurrent('page')}>
              Print
            </button>
          </>
        }
      />

      <div className="stack">
        {remittance && remittance.shortageCentavos > 0 ? (
          <Banner
            tone="error"
            title={`Shortage of ${displayMoney({ shortageCentavos: remittance.shortageCentavos }, 'shortage')} on this batch`}
          >
            {remittance.remarks ?? 'No reason was recorded.'} The remittance was {humanizeToken(remittance.status)}, so
            the difference is still on the books.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile
            label="Expected"
            value={displayMoney({ expectedReceivableCentavos: data.expectedReceivableCentavos }, 'expected')}
            tone="info"
            hint={`${formatNumber(data.accountCount)} accounts`}
          />
          <StatTile
            label="Cash collected"
            value={displayMoney({ cashCollectedCentavos: data.cashCollectedCentavos }, 'cashCollected')}
          />
          <StatTile
            label="Non-cash collected"
            value={displayMoney({ nonCashCollectedCentavos: data.nonCashCollectedCentavos }, 'nonCashCollected')}
          />
          <StatTile
            label="Uncollected"
            value={displayMoney({ uncollectedCentavos: data.uncollectedCentavos }, 'uncollected')}
            tone={data.uncollectedCentavos > 0 ? 'warning' : 'success'}
          />
          <StatTile label="Status" value={<Badge status={data.status} />} hint={`Opened by ${data.openedByName}`} />
        </div>

        <Panel title="Accounts on this batch" subtitle="House-to-house visits and what each one returned" flush>
          <DataTable
            columns={[
              {
                key: 'account',
                header: 'Account',
                render: (row) => (
                  <div>
                    <div className="text-bold">{row.subscriberName}</div>
                    <div className="text-xs text-muted mono">
                      {row.accountNumber} · {humanizeToken(row.serviceTypeCode)}
                    </div>
                  </div>
                )
              },
              { key: 'address', header: 'Address', render: (row) => row.address },
              {
                key: 'current',
                header: 'Current',
                money: true,
                render: (row) => (
                  <span className="money">{displayMoney({ currentBillCentavos: row.currentBillCentavos }, 'current')}</span>
                )
              },
              {
                key: 'arrears',
                header: 'Arrears',
                money: true,
                render: (row) =>
                  row.arrearsCentavos > 0 ? (
                    <span className="money text-danger">{displayMoney({ arrearsCentavos: row.arrearsCentavos }, 'arrears')}</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )
              },
              {
                key: 'due',
                header: 'Total due',
                money: true,
                render: (row) => (
                  <span className="money text-bold">{displayMoney({ totalDueCentavos: row.totalDueCentavos }, 'total')}</span>
                )
              },
              {
                key: 'collected',
                header: 'Collected',
                money: true,
                render: (row) => (
                  <span className="money">{displayMoney({ collectedCentavos: row.collectedCentavos }, 'collected')}</span>
                )
              },
              { key: 'status', header: 'Visit', render: (row) => <Badge status={row.status} /> },
              {
                key: 'notes',
                header: 'Notes',
                render: (row) => row.collectionNotes ?? <span className="text-subtle">—</span>
              }
            ]}
            rows={data.accounts}
            rowKey={(row) => row.id}
            onRowClick={(row) => onOpenAccount?.(row.serviceAccountId)}
            empty={<EmptyState title="No accounts loaded on this batch" />}
            footer={
              data.accounts.length > 0 ? (
                <tr className="total-row">
                  <td colSpan={4}>Batch total</td>
                  <td className="money text-bold">
                    {displayMoney({ totalDueCentavos: data.expectedReceivableCentavos }, 'total')}
                  </td>
                  <td className="money text-bold">
                    {displayMoney({ totalCollectedCentavos: data.totalCollectedCentavos }, 'collected')}
                  </td>
                  <td colSpan={2} />
                </tr>
              ) : undefined
            }
          />
        </Panel>

        <div className="grid-2">
          <Panel title="Progress" flush>
            <div className="panel__body">
              <dl className="kv">
                {timeline.map((step) => (
                  <div className="kv__row" key={step.label}>
                    <dt className="kv__key">{step.label}</dt>
                    <dd className="kv__value">
                      {step.at ? formatDateTime(step.at) : <span className="text-subtle">Not yet</span>}
                    </dd>
                  </div>
                ))}
                <div className="kv__row">
                  <dt className="kv__key">Route</dt>
                  <dd className="kv__value">{data.routeName}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Due-day cutoff</dt>
                  <dd className="kv__value">Day {data.dueDayCutoff}</dd>
                </div>
                {data.notes ? (
                  <div className="kv__row">
                    <dt className="kv__key">Notes</dt>
                    <dd className="kv__value">{data.notes}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </Panel>

          <Panel title="Remittance" subtitle="The money handed back to the office" flush>
            {remittance ? (
              <div className="panel__body">
                <dl className="kv">
                  <div className="kv__row">
                    <dt className="kv__key">Reference</dt>
                    <dd className="kv__value mono">{remittance.remittanceNumber}</dd>
                  </div>
                  <div className="kv__row">
                    <dt className="kv__key">Status</dt>
                    <dd className="kv__value">
                      <Badge status={remittance.status} />
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt className="kv__key">Cash collected</dt>
                    <dd className="kv__value money">
                      {displayMoney({ cashCollectedCentavos: remittance.cashCollectedCentavos }, 'cashCollected')}
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt className="kv__key">Cash remitted</dt>
                    <dd className="kv__value money">
                      {displayMoney({ cashRemittedCentavos: remittance.cashRemittedCentavos }, 'cashRemitted')}
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt className="kv__key">Shortage</dt>
                    <dd className="kv__value money">
                      {remittance.shortageCentavos > 0 ? (
                        <span className="text-danger text-bold">
                          {displayMoney({ shortageCentavos: remittance.shortageCentavos }, 'shortage')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt className="kv__key">Overage</dt>
                    <dd className="kv__value money">
                      {remittance.overageCentavos > 0 ? (
                        displayMoney({ overageCentavos: remittance.overageCentavos }, 'overage')
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  {remittance.remarks ? (
                    <div className="kv__row">
                      <dt className="kv__key">Remarks</dt>
                      <dd className="kv__value">{remittance.remarks}</dd>
                    </div>
                  ) : null}
                  <div className="kv__row">
                    <dt className="kv__key">Submitted by</dt>
                    <dd className="kv__value">{remittance.submittedByName}</dd>
                  </div>
                  <div className="kv__row">
                    <dt className="kv__key">Confirmed by</dt>
                    <dd className="kv__value">{remittance.confirmedByName ?? 'Not yet confirmed'}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <EmptyState title="No remittance yet" hint="The collector has not handed this batch's money back." />
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------ remittances */

function RemittancesTab(): React.JSX.Element {
  const [status, setStatus] = useState('')
  const list = usePagedList<RemittanceRow>('/collection/remittances', { status })

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const rows = list.query?.items ?? []
  const shortage = rows.reduce((sum, row) => sum + row.shortageCentavos, 0)
  const overage = rows.reduce((sum, row) => sum + row.overageCentavos, 0)

  const columns: Array<Column<RemittanceRow>> = [
    {
      key: 'remittance',
      header: 'Remittance',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.remittanceNumber}</div>
          <div className="text-xs text-muted mono">{row.batchNumber}</div>
        </div>
      )
    },
    { key: 'collector', header: 'Collector', render: (row) => row.collectorName },
    { key: 'date', header: 'Date', render: (row) => formatDate(row.remittanceDate) },
    {
      key: 'collected',
      header: 'Cash collected',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ cashCollectedCentavos: row.cashCollectedCentavos }, 'cashCollected')}</span>
      )
    },
    {
      key: 'remitted',
      header: 'Cash remitted',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ cashRemittedCentavos: row.cashRemittedCentavos }, 'cashRemitted')}</span>
      )
    },
    {
      key: 'shortage',
      header: 'Shortage',
      money: true,
      render: (row) =>
        row.shortageCentavos > 0 ? (
          <span className="money text-danger text-bold">
            {displayMoney({ shortageCentavos: row.shortageCentavos }, 'shortage')}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    {
      key: 'overage',
      header: 'Overage',
      money: true,
      render: (row) =>
        row.overageCentavos > 0 ? (
          <span className="money text-warning">
            {displayMoney({ overageCentavos: row.overageCentavos }, 'overage')}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> }
  ]

  return (
    <div className="stack">
      {shortage > 0 ? (
        <Banner tone="warning" title="Unreconciled shortage on this page">
          {displayMoney({ shortageCentavos: shortage }, 'shortage')} was collected but not remitted. Review each batch
          before closing its collector's day.
        </Banner>
      ) : null}

      <div className="stat-grid">
        <StatTile label="Remittances matching" value={formatNumber(list.query?.total ?? 0)} />
        <StatTile
          label="Shortage"
          value={displayMoney({ shortageCentavos: shortage }, 'shortage')}
          tone={shortage > 0 ? 'danger' : 'success'}
        />
        <StatTile
          label="Overage"
          value={displayMoney({ overageCentavos: overage }, 'overage')}
          tone={overage > 0 ? 'warning' : 'success'}
        />
      </div>

      <Panel flush title="Remittances">
        <div className="filter-bar">
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
              {REMITTANCE_STATUSES.map((option) => (
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
              setStatus('')
              list.resetFilters()
            }}
          >
            Clear
          </button>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={list.isPending}
          empty={<EmptyState title="No remittances match these filters" />}
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
  )
}
