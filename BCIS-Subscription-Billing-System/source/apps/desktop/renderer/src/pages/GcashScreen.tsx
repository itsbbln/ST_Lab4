/**
 * GCash proof verification.
 *
 * A proof is a screenshot a collector submits for money received by GCash. It is
 * unverified money until an office user confirms it, which is the control the
 * specification requires, so the review action is gated on `gcash.verify` and the
 * duplicate flag is surfaced loudly rather than left in a column.
 */

import { useState } from 'react'

import { confirmAction, describeError, openAppPath } from '../lib/desktop'
import { formatDateTime, formatNumber, humanizeToken } from '../lib/format'
import { useApiMutation, usePagedList } from '../lib/query'
import { useAuth } from '../lib/auth'
import {
  Badge,
  Banner,
  DataTable,
  EmptyState,
  Field,
  LoadError,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  StatTile,
  ToastStack,
  useToasts
} from '../components/ui'
import type { Column } from '../components/ui'
import type { GcashProofListResponse, GcashProofRow } from '../types/api'

const STATUS_OPTIONS = ['SUBMITTED', 'VERIFIED', 'REJECTED'] as const

export function GcashScreen(): React.JSX.Element {
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()

  const [status, setStatus] = useState('')
  const [reviewing, setReviewing] = useState<GcashProofRow | null>(null)

  const list = usePagedList<GcashProofRow, GcashProofListResponse>('/gcash/proofs', { status })

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  const rows = list.query?.items ?? []
  const pending = rows.filter((row) => row.status === 'SUBMITTED')
  const duplicates = rows.filter((row) => row.isDuplicateSuspect)

  const columns: Array<Column<GcashProofRow>> = [
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.referenceNumber}</div>
          <div className="text-xs text-muted">from {row.senderName}</div>
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
    { key: 'amount', header: 'Amount', money: true, render: (row) => <span className="money text-bold">{row.amount}</span> },
    { key: 'submitted', header: 'Submitted', render: (row) => formatDateTime(row.submittedAt) },
    { key: 'by', header: 'By', render: (row) => row.submittedByName },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="stack stack--sm">
          <Badge status={row.status} />
          {row.isDuplicateSuspect ? <Badge status="OVERDUE" label="Possible duplicate" /> : null}
        </div>
      )
    },
    {
      key: 'review',
      header: '',
      align: 'right',
      render: (row) =>
        can('gcash.verify') && row.status === 'SUBMITTED' ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={(event) => {
              event.stopPropagation()
              setReviewing(row)
            }}
          >
            Review
          </button>
        ) : (
          <span className="text-xs text-muted">
            {row.verifiedByName ? `by ${row.verifiedByName}` : ''}
          </span>
        )
    }
  ]

  return (
    <>
      <PageHeader
        title="GCash verification"
        subtitle="Proofs submitted for money received by GCash, awaiting a decision"
        actions={
          <button type="button" className="btn" onClick={() => void openAppPath('userData')}>
            Open proof folder
          </button>
        }
      />

      <div className="stack">
        {duplicates.length > 0 ? (
          <Banner tone="warning" title={`${duplicates.length} proof(s) flagged as possible duplicates`}>
            A repeated reference number can mean a screenshot was submitted twice. Check the account before verifying.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile label="Proofs matching" value={formatNumber(list.query?.total ?? 0)} />
          <StatTile
            label="Awaiting decision"
            value={formatNumber(pending.length)}
            tone={pending.length > 0 ? 'warning' : 'success'}
            hint="Unverified money on this page"
          />
          <StatTile
            label="Flagged duplicates"
            value={formatNumber(duplicates.length)}
            tone={duplicates.length > 0 ? 'danger' : 'success'}
          />
        </div>

        <Panel flush title="GCash proofs">
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
            onRowClick={(row) => (can('gcash.verify') && row.status === 'SUBMITTED' ? setReviewing(row) : undefined)}
            empty={<EmptyState title="No GCash proofs match these filters" />}
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

      {reviewing ? (
        <ReviewProofModal
          proof={reviewing}
          onClose={() => setReviewing(null)}
          onDecided={(message) => {
            setReviewing(null)
            push('success', message)
            list.refetch()
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

function ReviewProofModal({
  proof,
  onClose,
  onDecided
}: {
  proof: GcashProofRow
  onClose: () => void
  onDecided: (message: string) => void
}): React.JSX.Element {
  const [rejectionReason, setRejectionReason] = useState('')
  const [showReject, setShowReject] = useState(false)

  /**
   * The schema is `{ proofId, approved, reason }` — a boolean decision, not a
   * VERIFY/REJECT token. `proofId` is also required in the body even though the
   * id is in the URL; the API validates the body against the same id, so sending
   * only the path segment is rejected.
   */
  const review = useApiMutation<{ proofId: string; approved: boolean; reason?: string }, unknown>(
    (client, body) => client.post(`/gcash/proofs/${proof.id}/review`, body),
    { onSuccess: () => onDecided(`${proof.referenceNumber} was recorded.`) }
  )

  const reasonError =
    !showReject || rejectionReason.trim().length >= 3
      ? undefined
      : 'Give at least 3 characters so the collector knows what to correct.'

  const decide = async (decision: 'VERIFY' | 'REJECT'): Promise<void> => {
    const rejecting = decision === 'REJECT'
    const ok = await confirmAction({
      message: rejecting ? `Reject ${proof.referenceNumber}?` : `Verify ${proof.referenceNumber}?`,
      detail: rejecting
        ? `The ${proof.amount} will not be treated as received. The collector is shown your reason.`
        : `The ${proof.amount} will be treated as received on ${proof.serviceAccountNumber}. This is recorded in the audit log.`,
      confirmLabel: rejecting ? 'Reject proof' : 'Verify proof',
      danger: rejecting
    })
    if (!ok) {
      return
    }
    if (rejecting && rejectionReason.trim().length < 3) {
      setShowReject(true)
      return
    }
    await review
      .mutateAsync({
        proofId: proof.id,
        approved: !rejecting,
        reason: rejectionReason.trim() || undefined
      })
      .catch(() => undefined)
  }

  return (
    <Modal
      title={`Review ${proof.referenceNumber}`}
      subtitle={`${proof.senderName} · ${proof.serviceAccountNumber} · ${proof.subscriberName}`}
      onClose={onClose}
      width={560}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={review.isPending}
            onClick={() => {
              setShowReject(true)
              void decide('REJECT')
            }}
          >
            Reject
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={review.isPending}
            onClick={() => void decide('VERIFY')}
          >
            {review.isPending ? 'Saving…' : 'Verify'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {review.error ? (
          <Banner tone="error" title="The decision was not recorded">
            {describeError(review.error)}
          </Banner>
        ) : null}

        {proof.isDuplicateSuspect ? (
          <Banner tone="warning" title="Possible duplicate reference">
            This reference number has been seen before. Verifying it twice would post the money twice.
          </Banner>
        ) : null}

        <dl className="kv">
          <div className="kv__row">
            <dt className="kv__key">Amount</dt>
            <dd className="kv__value money text-bold">{proof.amount}</dd>
          </div>
          <div className="kv__row">
            <dt className="kv__key">Reference</dt>
            <dd className="kv__value mono">{proof.referenceNumber}</dd>
          </div>
          <div className="kv__row">
            <dt className="kv__key">Sender</dt>
            <dd className="kv__value">{proof.senderName}</dd>
          </div>
          <div className="kv__row">
            <dt className="kv__key">Account</dt>
            <dd className="kv__value">
              {proof.subscriberName} <span className="mono text-muted">{proof.serviceAccountNumber}</span>
            </dd>
          </div>
          <div className="kv__row">
            <dt className="kv__key">Submitted</dt>
            <dd className="kv__value">
              {formatDateTime(proof.submittedAt)} by {proof.submittedByName}
            </dd>
          </div>
        </dl>

        <Field
          label="Rejection reason"
          error={reasonError}
          hint="Required to reject; included with the decision"
        >
          <textarea
            className="textarea"
            value={rejectionReason}
            onChange={(event) => {
              setRejectionReason(event.target.value)
              setShowReject(true)
            }}
            rows={2}
            placeholder="e.g. Screenshot does not match the reference number"
          />
        </Field>
      </div>
    </Modal>
  )
}
