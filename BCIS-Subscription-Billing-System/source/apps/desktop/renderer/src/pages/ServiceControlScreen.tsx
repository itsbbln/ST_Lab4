/**
 * Suspensions and reconnections.
 *
 * Cutting a line off is the most consequential thing this application does, and
 * the API enforces it as a sequence rather than a single toggle: a request is
 * raised, approved by someone else, then executed in the field. This screen shows
 * that sequence as the status of each row, and only offers the action the row's
 * current status actually allows.
 *
 * A reconnecting subscriber pays the plan's reconnection fee, which the API
 * raises as an invoice. The fee is shown before work is assigned so the office
 * does not promise a free restoration.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { ViewExportMenu } from '../components/export'
import { formatDate, formatNumber, humanizeToken } from '../lib/format'
import { useApiMutation, useApiQuery, usePagedList } from '../lib/query'
import { useAuth } from '../lib/auth'
import { useNavigate } from '../lib/router'
import {
  Badge,
  Banner,
  DataTable,
  EmptyState,
  LoadError,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  StatTile,
  TabBar,
  ToastStack,
  useToasts
} from '../components/ui'
import type { Column } from '../components/ui'
import type {
  OverdueAccountRow,
  ReconnectionRow,
  SuspensionCandidatesResponse,
  SuspensionRow
} from '../types/api'

const SUSPENSION_STATUSES = ['REQUESTED', 'APPROVED', 'EXECUTED', 'CANCELLED', 'COMPLETED'] as const
const RECONNECTION_STATUSES = ['REQUESTED', 'PENDING_PAYMENT', 'APPROVED', 'COMPLETED', 'CANCELLED'] as const

type Tab = 'suspensions' | 'reconnections' | 'candidates'

/**
 * The sidebar has separate entries for suspensions and reconnections, so the
 * route picks the tab rather than the screen owning the navigation.
 */
export function ServiceControlScreen({
  initialTab = 'suspensions'
}: { initialTab?: 'suspensions' | 'reconnections' | 'candidates' } = {}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab)

  return (
    <>
      <PageHeader
        title="Service control"
        subtitle="Cutting service off, and bringing it back"
        tabs={
          <TabBar
            tabs={[
              { key: 'suspensions', label: 'Suspensions' },
              { key: 'reconnections', label: 'Reconnections' },
              { key: 'candidates', label: 'Candidates' }
            ]}
            active={tab}
            onChange={(key) => setTab(key === 'reconnections' || key === 'candidates' ? key : 'suspensions')}
          />
        }
      />
      {tab === 'suspensions' ? <SuspensionsTab /> : null}
      {tab === 'reconnections' ? <ReconnectionsTab /> : null}
      {tab === 'candidates' ? <CandidatesTab /> : null}
    </>
  )
}

/* ------------------------------------------------------------ suspensions */

function SuspensionsTab(): React.JSX.Element {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()

  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  /** The transition being confirmed; `kind` is also the API's URL segment. */
  const [act, setAct] = useState<SuspensionAction | null>(null)

  const list = usePagedList<SuspensionRow>('/service-control/suspensions', { status })

  const mutation = useApiMutation<{ suspensionId: string }, unknown>(
    (client, body) =>
      client.post(`/service-control/suspensions/${body.suspensionId}/${act?.kind ?? 'approve'}`, body),
    {
      onSuccess: () => {
        setBusyId(null)
        setAct(null)
        push('success', 'The suspension was updated.')
        list.refetch()
      }
    }
  )

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const rows = list.query?.items ?? []
  const outstanding = rows.filter((row) => row.status === 'REQUESTED' || row.status === 'APPROVED')
  const arrears = rows.reduce((sum, row) => sum + row.arrearsAtSuspensionCentavos, 0)

  const columns: Array<Column<SuspensionRow>> = [
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
    { key: 'reason', header: 'Reason', render: (row) => humanizeToken(row.reason) },
    { key: 'effective', header: 'Effective', render: (row) => formatDate(row.effectiveDate) },
    {
      key: 'arrears',
      header: 'Arrears at request',
      money: true,
      render: (row) => (
        <span className="money text-danger text-bold">
          {displayMoney({ arrearsAtSuspensionCentavos: row.arrearsAtSuspensionCentavos }, 'arrears')}
        </span>
      )
    },
    { key: 'accountStatus', header: 'Line status', render: (row) => <Badge status={row.accountStatus} /> },
    { key: 'status', header: 'Request', render: (row) => <Badge status={row.status} /> },
    { key: 'raised', header: 'Raised', render: (row) => `${formatDate(row.createdAt)} · ${row.createdByName}` },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        const next = SUSPENSION_ACTIONS[row.status]
        if (!can('service.manage') || !next) {
          return null
        }
        return (
          <button
            type="button"
            className={`btn btn--sm${next.kind === 'execute' ? ' btn--danger' : ' btn--primary'}`}
            disabled={busyId === row.id}
            onClick={(event) => {
              event.stopPropagation()
              setBusyId(row.id)
              setAct(next)
            }}
          >
            {next.label}
          </button>
        )
      }
    }
  ]

  return (
    <div className="stack">
      {outstanding.length > 0 ? (
        <Banner tone="warning" title={`${outstanding.length} suspension(s) not yet executed`}>
          A requested suspension does not cut the line. It takes an approval and then a field execution.
        </Banner>
      ) : null}

      <div className="stat-grid">
        <StatTile label="Requests matching" value={formatNumber(list.query?.total ?? 0)} />
        <StatTile
          label="Awaiting execution"
          value={formatNumber(outstanding.length)}
          tone={outstanding.length > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Arrears on this page"
          value={displayMoney({ arrearsAtSuspensionCentavos: arrears }, 'arrears')}
          tone="danger"
        />
      </div>

      <Panel flush title="Suspension requests">
        <div className="filter-bar">
          <label className="field">
            <span className="field__label">Request status</span>
            <select
              className="select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value)
                list.setFilter('status', event.target.value)
              }}
            >
              <option value="">All statuses</option>
              {SUSPENSION_STATUSES.map((option) => (
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
          <button type="button" className="btn" onClick={() => void printCurrent('page')}>
            Print
          </button>
          <ViewExportMenu suggestedName="bcis-service-control.pdf" />
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={list.isPending}
          onRowClick={(row) => navigate(`/service-accounts/${row.serviceAccountId}`)}
          empty={<EmptyState title="No suspension requests match these filters" />}
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

      {act ? (
        <ConfirmActionModal
          title={act.label}
          detail={ACT_DETAIL[act.kind]}
          confirmLabel={act.label}
          danger={act.kind === 'execute' || act.kind === 'cancel'}
          busy={mutation.isPending}
          error={mutation.error ? describeError(mutation.error) : null}
          onCancel={() => {
            setAct(null)
            setBusyId(null)
          }}
          onConfirm={() => {
            if (!busyId) {
              return
            }
            void mutation.mutateAsync({ suspensionId: busyId }).catch(() => {
              setBusyId(null)
            })
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

interface SuspensionAction {
  kind: 'approve' | 'execute' | 'cancel'
  label: string
}

/**
 * The API models a suspension as a sequence rather than a toggle, so the only
 * action offered is the one the row's current status allows.
 */
const SUSPENSION_ACTIONS: Record<string, SuspensionAction | undefined> = {
  REQUESTED: { kind: 'approve', label: 'Approve' },
  APPROVED: { kind: 'execute', label: 'Mark executed' },
  EXECUTED: { kind: 'cancel', label: 'Cancel' }
}

const ACT_DETAIL: Record<'approve' | 'execute' | 'cancel', string> = {
  approve: 'Approving authorises the field team to cut this line. The subscriber is not notified by this action.',
  execute: 'Record that the line was actually cut. This is what changes the service account status to suspended.',
  cancel: 'Cancel this request. Use this if the arrears were settled or the request was raised in error.'
}

/* ---------------------------------------------------------- reconnections */

function ReconnectionsTab(): React.JSX.Element {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()

  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [act, setAct] = useState<'complete' | 'cancel' | null>(null)

  const list = usePagedList<ReconnectionRow>('/service-control/reconnections', { status })

  const mutation = useApiMutation<{ reconnectionId: string }, unknown>(
    (client, body) => client.post(`/service-control/reconnections/${body.reconnectionId}/${act}`, body),
    {
      onSuccess: () => {
        setBusyId(null)
        setAct(null)
        push('success', 'The reconnection was updated.')
        list.refetch()
      }
    }
  )

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const rows = list.query?.items ?? []
  const fees = rows.reduce((sum, row) => sum + row.feeCentavos, 0)
  const unpaid = rows.reduce((sum, row) => sum + row.feeBalanceCentavos, 0)
  const inFlight = rows.filter((row) => row.status !== 'COMPLETED' && row.status !== 'CANCELLED')

  const columns: Array<Column<ReconnectionRow>> = [
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
    { key: 'requested', header: 'Requested', render: (row) => formatDate(row.requestDate) },
    {
      key: 'fee',
      header: 'Reconnection fee',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ feeCentavos: row.feeCentavos }, 'fee')}</span>
      )
    },
    {
      key: 'invoice',
      header: 'Fee invoice',
      render: (row) =>
        row.feeInvoiceNumber ? (
          <div>
            <div className="mono text-sm">{row.feeInvoiceNumber}</div>
            {row.feeBalanceCentavos > 0 ? (
              <div className="money text-xs text-danger">
                {displayMoney({ feeBalanceCentavos: row.feeBalanceCentavos }, 'feeBalance')} outstanding
              </div>
            ) : (
              <div className="text-xs text-muted">Paid</div>
            )}
          </div>
        ) : (
          <span className="text-subtle">Not raised</span>
        )
    },
    { key: 'accountStatus', header: 'Line status', render: (row) => <Badge status={row.accountStatus} /> },
    { key: 'status', header: 'Reconnection', render: (row) => <Badge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        if (!can('service.manage') || (act === null && !RECONNECTION_ACTIONS[row.status])) {
          return null
        }
        const next = RECONNECTION_ACTIONS[row.status]
        if (!next) {
          return null
        }
        return (
          <button
            type="button"
            className={`btn btn--sm${next === 'complete' ? ' btn--primary' : ''}`}
            disabled={busyId === row.id}
            onClick={(event) => {
              event.stopPropagation()
              setBusyId(row.id)
              setAct(next)
            }}
          >
            {next === 'complete' ? 'Mark restored' : 'Cancel'}
          </button>
        )
      }
    }
  ]

  return (
    <div className="stack">
      {inFlight.length > 0 ? (
        <Banner tone="info" title={`${inFlight.length} reconnection(s) in progress`}>
          A subscriber is only reconnected once the reconnection fee invoice is settled and the technician has finished
          the work.
        </Banner>
      ) : null}

      <div className="stat-grid">
        <StatTile label="Requests matching" value={formatNumber(list.query?.total ?? 0)} />
        <StatTile
          label="Fees billed"
          value={displayMoney({ feeCentavos: fees }, 'fee')}
          hint="Reconnection fees raised on this page"
        />
        <StatTile
          label="Fee balances unpaid"
          value={displayMoney({ feeBalanceCentavos: unpaid }, 'feeBalance')}
          tone={unpaid > 0 ? 'danger' : 'success'}
        />
      </div>

      <Panel flush title="Reconnection requests">
        <div className="filter-bar">
          <label className="field">
            <span className="field__label">Request status</span>
            <select
              className="select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value)
                list.setFilter('status', event.target.value)
              }}
            >
              <option value="">All statuses</option>
              {RECONNECTION_STATUSES.map((option) => (
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
          onRowClick={(row) => navigate(`/service-accounts/${row.serviceAccountId}`)}
          empty={<EmptyState title="No reconnection requests match these filters" />}
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

      {act ? (
        <ConfirmActionModal
          title={act === 'complete' ? 'Mark the line restored' : 'Cancel this reconnection'}
          detail={
            act === 'complete'
              ? 'Confirm the technician has finished and the subscriber is receiving service again. This returns the account to active.'
              : 'Cancel this reconnection. Any fee invoice already raised is left as it is, so cancel the invoice separately if the fee should not stand.'
          }
          confirmLabel={act === 'complete' ? 'Mark restored' : 'Cancel reconnection'}
          danger={act === 'cancel'}
          busy={mutation.isPending}
          error={mutation.error ? describeError(mutation.error) : null}
          onCancel={() => {
            setAct(null)
            setBusyId(null)
          }}
          onConfirm={() => {
            if (!busyId) {
              return
            }
            void mutation.mutateAsync({ reconnectionId: busyId }).catch(() => {
              setBusyId(null)
            })
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

const RECONNECTION_ACTIONS: Record<string, 'complete' | 'cancel' | undefined> = {
  REQUESTED: 'complete',
  PENDING_PAYMENT: 'complete',
  APPROVED: 'complete'
}

/* ------------------------------------------------------------- candidates */

function CandidatesTab(): React.JSX.Element {
  const navigate = useNavigate()

  const candidates = useApiQuery<SuspensionCandidatesResponse>(
    ['receivables', 'suspension-candidates'],
    (client) => client.get<SuspensionCandidatesResponse>('/receivables/suspension-candidates')
  )

  if (candidates.error || !candidates.data) {
    return <LoadError message={describeError(candidates.error)} onRetry={() => void candidates.refetch()} />
  }

  const rows = candidates.data.items
  const arrears = rows.reduce((sum, row) => sum + row.totalArrearsCentavos, 0)

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
    { key: 'contact', header: 'Contact', render: (row) => row.contactNumber },
    { key: 'area', header: 'Area', render: (row) => row.areaName },
    { key: 'collector', header: 'Collector', render: (row) => row.collectorName ?? 'Unassigned' },
    {
      key: 'months',
      header: 'Months unpaid',
      align: 'right',
      render: (row) => (
        <span className="text-danger text-bold">{formatNumber(row.monthsUnpaid)}</span>
      )
    },
    {
      key: 'arrears',
      header: 'Total arrears',
      money: true,
      render: (row) => (
        <span className="money text-danger text-bold">
          {displayMoney({ totalArrearsCentavos: row.totalArrearsCentavos }, 'total')}
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
              {formatDate(row.oldestUnpaidInvoice.dueDate)} ·{' '}
              {formatNumber(row.oldestUnpaidInvoice.daysPastDue)} days past due
            </div>
          </div>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    { key: 'lastPayment', header: 'Last payment', render: (row) => formatDate(row.lastPayment?.paidAt) }
  ]

  return (
    <div className="stack">
      <Banner tone="warning" title="These accounts meet the suspension policy">
        {formatNumber(candidates.data.items.length)} account(s) are past the{' '}
        {formatNumber(candidates.data.gracePeriodDays)}-day grace period and have unpaid months. Raising a request
        still needs an approval before anything is cut.
      </Banner>

      <div className="stat-grid">
        <StatTile label="Candidates" value={formatNumber(rows.length)} />
        <StatTile
          label="Total arrears"
          value={displayMoney({ totalArrearsCentavos: arrears }, 'total')}
          tone="danger"
        />
        <StatTile
          label="Threshold"
          value={`${formatNumber(candidates.data.suspensionThresholdMonths)} month(s)`}
          hint="Unpaid months before an account qualifies"
        />
      </div>

      <Panel flush title="Suspension candidates">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.serviceAccountId}
          onRowClick={(row) => navigate(`/service-accounts/${row.serviceAccountId}`)}
          empty={<EmptyState title="No accounts meet the suspension policy" hint="Everyone is inside the grace period." />}
          footer={
            rows.length > 0 ? (
              <tr className="total-row">
                <td colSpan={4}>Total arrears</td>
                <td className="money text-bold">
                  {displayMoney({ totalArrearsCentavos: arrears }, 'total')}
                </td>
                <td colSpan={3} />
              </tr>
            ) : undefined
          }
        />
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------------ modal */

/**
 * A shared confirmation layout for the approve/execute/cancel transitions.
 *
 * This is a component rather than the native `confirmAction` dialog because the
 * API's own error text has to stay on screen; a native dialog discards it and
 * leaves the user with a failed action and no explanation.
 */
function ConfirmActionModal({
  title,
  detail,
  confirmLabel,
  danger,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  title: string
  detail: string
  confirmLabel: string
  danger: boolean
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={480}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="stack">
        {error ? (
          <Banner tone="error" title="The action was not recorded">
            {error}
          </Banner>
        ) : null}
        <p className="text-sm">{detail}</p>
        <p className="text-xs text-subtle">This is recorded in the audit log with your name.</p>
      </div>
    </Modal>
  )
}
