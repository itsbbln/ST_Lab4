/**
 * Service accounts: the billing relationship between a subscriber and a plan.
 *
 * An account can be suspended and reconnected, so its status history is shown
 * from `/service-accounts/:id/events` rather than inferred from the current
 * status. `metadata` arrives as a JSON *string*, so it is parsed defensively —
 * a rendering path must not be the thing that throws on unexpected data.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { ReportExportMenu, ViewExportMenu } from '../components/export'
import { formatDate, formatNumber, humanizeToken } from '../lib/format'
import { useApiQuery, usePagedList } from '../lib/query'
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
import type {
  ItemsResponse,
  ServiceAccountDetail,
  ServiceAccountListRow,
  ServiceEvent
} from '../types/api'

/**
 * From the shared `serviceAccountStatuses` list. The first state is
 * `PENDING_ACTIVATION`, not `PENDING`: verified against the running API, offering
 * `PENDING` makes the filter respond 400.
 */
const STATUS_OPTIONS = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'DISCONNECTED',
  'TERMINATED'
] as const

/**
 * `initialAccountId` lets the route open a profile directly, e.g. from the
 * receivables arrears list, so a cross-screen link is a real URL rather than a
 * lost click.
 */
export function ServiceAccountsScreen({ initialAccountId }: { initialAccountId?: string } = {}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [areaId, setAreaId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialAccountId ?? null)

  const list = usePagedList<ServiceAccountListRow>('/service-accounts', { q: search, status, areaId })

  if (selectedId) {
    return <ServiceAccountProfile accountId={selectedId} onBack={() => setSelectedId(null)} />
  }

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const columns: Array<Column<ServiceAccountListRow>> = [
    {
      key: 'account',
      header: 'Service account',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.serviceAccountNumber}</div>
          <div className="text-xs text-muted">{row.planName}</div>
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
    { key: 'area', header: 'Area', render: (row) => row.areaName },
    { key: 'collector', header: 'Collector', render: (row) => row.collectorName ?? '—' },
    {
      key: 'rate',
      header: 'Monthly rate',
      money: true,
      render: (row) => <span className="money">{displayMoney({ currentRateCentavos: row.currentRateCentavos }, 'currentRate')}</span>
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      money: true,
      render: (row) => (
        <span className={`money${row.outstandingCentavos > 0 ? ' text-bold' : ' text-subtle'}`}>{row.outstanding}</span>
      )
    },
    {
      key: 'credit',
      header: 'Credit',
      money: true,
      render: (row) =>
        row.creditBalanceCentavos > 0 ? (
          <span className="money text-success">{displayMoney({ creditBalanceCentavos: row.creditBalanceCentavos }, 'credit')}</span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> }
  ]

  return (
    <>
      <PageHeader
        title="Service accounts"
        subtitle="Each subscriber service, its plan, and what it still owes"
        actions={
          <ReportExportMenu path="/reports/subscribers" query={{ q: search, status, areaId }} suggestedName="bcis-service-accounts" />
        }
      />

      <Panel flush title="Accounts" subtitle={`${formatNumber(list.query?.total ?? 0)} matching`}>
        <div className="filter-bar">
          <label className="field filter-bar__grow">
            <span className="field__label">Search</span>
            <input
              className="input"
              value={search}
              placeholder="Service account no., account no. or subscriber"
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
            <span className="field__label">Collection area</span>
            <input
              className="input"
              value={areaId}
              placeholder="All areas"
              onChange={(event) => {
                setAreaId(event.target.value)
                list.setFilter('areaId', event.target.value)
              }}
            />
          </label>

          <button
            type="button"
            className="btn"
            onClick={() => {
              setSearch('')
              setStatus('')
              setAreaId('')
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
          onRowClick={(row) => setSelectedId(row.id)}
          empty={<EmptyState title="No service accounts match these filters" />}
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
    </>
  )
}

/* --------------------------------------------------------------- profile */

function ServiceAccountProfile({
  accountId,
  onBack
}: {
  accountId: string
  onBack: () => void
}): React.JSX.Element {
  const account = useApiQuery<ServiceAccountDetail>(['service-accounts', accountId], (client) =>
    client.get<ServiceAccountDetail>(`/service-accounts/${accountId}`)
  )

  const events = useApiQuery<ItemsResponse<ServiceEvent>>(
    ['service-accounts', accountId, 'events'],
    (client) => client.get<ItemsResponse<ServiceEvent>>(`/service-accounts/${accountId}/events`)
  )

  if (account.error || !account.data) {
    return <LoadError message={describeError(account.error)} onRetry={() => void account.refetch()} />
  }

  const data = account.data

  return (
    <>
      <PageHeader
        title={data.serviceAccountNumber}
        subtitle={`${data.subscriberName} · ${data.planName} · ${data.areaName}`}
        actions={
          <>
            <button type="button" className="btn" onClick={onBack}>
              Back
            </button>
            <ViewExportMenu suggestedName={`bcis-service-account-${data.serviceAccountNumber}.pdf`} />
            <button type="button" className="btn" onClick={() => void printCurrent('page')}>
              Print
            </button>
          </>
        }
      />

      <div className="stack">
        <div className="stat-grid">
          <StatTile
            label="Monthly rate"
            value={displayMoney({ currentRateCentavos: data.currentRateCentavos }, 'currentRate')}
            tone="info"
          />
          <StatTile
            label="Credit balance"
            value={displayMoney({ creditBalanceCentavos: data.creditBalanceCentavos }, 'credit')}
            tone={data.creditBalanceCentavos > 0 ? 'success' : 'neutral'}
            hint="Overpayments held on account"
          />
          <StatTile
            label="Installation fee"
            value={displayMoney({ installationFeeCentavos: data.installationFeeCentavos }, 'installationFee')}
          />
          <StatTile
            label="Reconnection fee"
            value={displayMoney({ reconnectionFeeCentavos: data.reconnectionFeeCentavos }, 'reconnectionFee')}
          />
          <StatTile
            label="Status"
            value={<Badge status={data.status} />}
            hint={`Activated ${formatDate(data.activationDate)}`}
          />
        </div>

        <div className="grid-2">
          <Panel title="Account" flush>
            <div className="panel__body">
              <dl className="kv">
                <div className="kv__row">
                  <dt className="kv__key">Service account</dt>
                  <dd className="kv__value mono">{data.serviceAccountNumber}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Subscriber</dt>
                  <dd className="kv__value">
                    {data.subscriberName} <span className="mono text-muted">{data.accountNumber}</span>
                  </dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Contact</dt>
                  <dd className="kv__value">{data.contactNumber || '—'}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Installation address</dt>
                  <dd className="kv__value">{data.installationAddress}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Plan</dt>
                  <dd className="kv__value">
                    {data.planName} <span className="mono text-muted">{data.planCode}</span>
                  </dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Service type</dt>
                  <dd className="kv__value">{humanizeToken(data.serviceType)}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Collection area</dt>
                  <dd className="kv__value">{data.areaName}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Collector</dt>
                  <dd className="kv__value">{data.collectorName ?? 'Unassigned'}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Billing</dt>
                  <dd className="kv__value">
                    From {data.billingStartPeriod}, due day {data.billingDueDay}
                  </dd>
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

          <Panel title="Status history" subtitle="Every lifecycle event on this account" flush>
            <DataTable
              columns={[
                { key: 'date', header: 'Effective', render: (row) => formatDate(row.effectiveDate) },
                { key: 'type', header: 'Event', render: (row) => <Badge label={humanizeToken(row.eventType)} status={row.eventType} /> },
                { key: 'reason', header: 'Reason', render: (row) => <EventReason event={row} /> },
                { key: 'actor', header: 'By', render: (row) => row.actorName }
              ]}
              rows={events.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={events.isPending}
              empty={<EmptyState title="No lifecycle events recorded" />}
            />
          </Panel>
        </div>
      </div>
    </>
  )
}

/**
 * Renders an event reason, appending any structured detail.
 *
 * `metadata` is a JSON string that the API documents as advisory, so malformed
 * content is dropped rather than allowed to break the table.
 */
function EventReason({ event }: { event: ServiceEvent }): React.JSX.Element {
  const [detail, setDetail] = useState<string | null>(null)

  if (!event.metadata) {
    return <span>{event.reason}</span>
  }

  let parsed: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(event.metadata)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    parsed = null
  }

  if (!parsed) {
    return <span>{event.reason}</span>
  }

  const summary = Object.entries(parsed)
    .map(([key, value]) => `${humanizeToken(key)}: ${typeof value === 'object' ? '—' : String(value)}`)
    .join(' · ')

  if (detail === null) {
    return (
      <span>
        {event.reason}{' '}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDetail(summary)}>
          details
        </button>
      </span>
    )
  }

  return (
    <span>
      {event.reason}
      <div className="text-xs text-muted mono">{detail}</div>
    </span>
  )
}
