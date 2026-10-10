/**
 * Subscriber profile.
 *
 * The subscriber is the person; the service accounts are what the office
 * actually bills. Keeping them on one screen is the point — a collections
 * conversation almost always needs "who is this and what do they owe" in the
 * same view, so the outstanding figure is repeated per account and totalled from
 * the server's own per-row values.
 */

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { ViewExportMenu } from '../components/export'
import { formatDate, formatNumber } from '../lib/format'
import { useApiQuery, usePagedList } from '../lib/query'
import { useAuth } from '../lib/auth'
import { useNavigate } from '../lib/router'
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
import type { ServiceAccountListRow, SubscriberDetail } from '../types/api'

export function SubscriberProfileScreen({
  subscriberId,
  onBack
}: {
  subscriberId: string
  onBack: () => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const { can } = useAuth()

  const subscriber = useApiQuery<SubscriberDetail>(['subscribers', subscriberId], (client) =>
    client.get<SubscriberDetail>(`/subscribers/${subscriberId}`)
  )

  const accounts = usePagedList<ServiceAccountListRow>('/service-accounts', { subscriberId })

  if (subscriber.error || !subscriber.data) {
    return <LoadError message={describeError(subscriber.error)} onRetry={() => void subscriber.refetch()} />
  }

  const data = subscriber.data
  const accountRows = accounts.query?.items ?? []
  const outstanding = accountRows.reduce((sum, row) => sum + row.outstandingCentavos, 0)
  const credit = accountRows.reduce((sum, row) => sum + row.creditBalanceCentavos, 0)
  const arrears = accountRows.filter((row) => row.outstandingCentavos > 0)

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
    { key: 'installation', header: 'Installation address', render: (row) => row.installationAddress },
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
      render: (row) =>
        row.outstandingCentavos > 0 ? (
          <span className="money text-danger text-bold">{row.outstanding}</span>
        ) : (
          <span className="text-success">Settled</span>
        )
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> }
  ]

  return (
    <>
      <PageHeader
        title={data.fullName}
        subtitle={`${data.accountNumber} · ${data.areaName ?? 'No collection area'}`}
        actions={
          <>
            <button type="button" className="btn" onClick={onBack}>
              Back to subscribers
            </button>
            <ViewExportMenu suggestedName={`bcis-subscriber-${data.accountNumber}.pdf`} />
            <button type="button" className="btn" onClick={() => void printCurrent('page')}>
              Print profile
            </button>
          </>
        }
      />

      <div className="stack">
        {arrears.length > 0 ? (
          <Banner tone="warning" title={`${arrears.length} service account(s) with an outstanding balance`}>
            The account rows below are ordered as the API returns them. Open one to see its invoice history before
            promising a reconnection.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile
            label="Status"
            value={<Badge status={data.status} />}
            hint={`Since ${formatDate(data.createdAt)}`}
          />
          <StatTile
            label="Service accounts"
            value={formatNumber(accounts.query?.total ?? 0)}
            hint="Installations billed under this subscriber"
          />
          <StatTile
            label="Outstanding"
            value={displayMoney({ outstandingCentavos: outstanding }, 'outstanding')}
            tone={outstanding > 0 ? 'danger' : 'success'}
            hint="Sum of this page's account balances"
          />
          <StatTile
            label="Credit"
            value={displayMoney({ creditBalanceCentavos: credit }, 'credit')}
            tone={credit > 0 ? 'info' : undefined}
            hint="Overpayment carried forward"
          />
        </div>

        <div className="grid-2">
          <Panel title="Contact" flush>
            <div className="panel__body">
              <dl className="kv">
                <div className="kv__row">
                  <dt className="kv__key">Account number</dt>
                  <dd className="kv__value mono">{data.accountNumber}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Contact number</dt>
                  <dd className="kv__value mono">{data.contactNumber || '—'}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Email</dt>
                  <dd className="kv__value">{data.email || '—'}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Billing due day</dt>
                  <dd className="kv__value">Day {data.billingDueDay}</dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Collection area</dt>
                  <dd className="kv__value">
                    {data.areaName ?? 'Unassigned'}
                    {data.areaCode ? <span className="mono text-muted"> · {data.areaCode}</span> : null}
                  </dd>
                </div>
                <div className="kv__row">
                  <dt className="kv__key">Address</dt>
                  <dd className="kv__value">
                    {data.addressLine}
                    {data.city ? `, ${data.city}` : ''}
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

          <Panel title="Addresses" subtitle="Where this subscriber has asked to be billed or installed" flush>
            {data.addresses.length > 0 ? (
              <DataTable
                columns={[
                  {
                    key: 'label',
                    header: 'Label',
                    render: (row) => (
                      <div className="row row--between">
                        <span className="text-bold">{row.label}</span>
                        {row.isPrincipal ? <Badge status="ACTIVE" label="Principal" /> : null}
                      </div>
                    )
                  },
                  {
                    key: 'address',
                    header: 'Address',
                    render: (row) => (
                      <div>
                        <div>{row.addressLine}</div>
                        <div className="text-xs text-muted">{row.city}</div>
                      </div>
                    )
                  }
                ]}
                rows={data.addresses}
                rowKey={(row) => row.id}
              />
            ) : (
              <EmptyState title="No recorded addresses" />
            )}
          </Panel>
        </div>

        <Panel flush title="Service accounts" subtitle="Every installation billed under this subscriber">
          {accounts.error?.isUnreachable ? (
            <div className="panel__body">
              <Banner tone="error" title="Service accounts could not be loaded">
                {describeError(accounts.error)}
              </Banner>
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={accountRows}
                rowKey={(row) => row.id}
                loading={accounts.isPending}
                onRowClick={(row) => navigate(`/service-accounts/${row.id}`)}
                empty={<EmptyState title="No service accounts yet" hint="Create an installation to start billing this subscriber." />}
                footer={
                  accountRows.length > 0 ? (
                    <tr className="total-row">
                      <td>Total outstanding</td>
                      <td />
                      <td />
                      <td className="money text-bold">
                        {displayMoney({ outstandingCentavos: outstanding }, 'outstanding')}
                      </td>
                      <td />
                    </tr>
                  ) : undefined
                }
              />
              {accounts.error && !accounts.error.isUnreachable ? (
                <div className="panel__body">
                  <Banner tone="warning" title="Some accounts may be missing">
                    {describeError(accounts.error)}
                  </Banner>
                </div>
              ) : null}
            </>
          )}
        </Panel>

        {can('subscriber.manage') ? null : (
          <p className="text-xs text-subtle">
            You have read-only access to this profile. Changes need the <code>subscriber.manage</code> permission.
          </p>
        )}
      </div>
    </>
  )
}
