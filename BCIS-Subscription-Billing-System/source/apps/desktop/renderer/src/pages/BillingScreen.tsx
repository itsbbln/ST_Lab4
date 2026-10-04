/**
 * Billing cycles.
 *
 * Generation is idempotent per period by design: running it twice for the same
 * month reports the first run's invoice numbers and creates nothing. That is why
 * this screen has no "rebuild" or "force" button — a month that needs rebuilding
 * is voided invoice by invoice, which leaves an audit trail.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { confirmAction, describeError } from '../lib/desktop'
import { formatDateTime, formatNumber, formatPeriod, humanizeToken } from '../lib/format'
import { useApiMutation, useApiQuery } from '../lib/query'
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
  Panel,
  StatTile,
  ToastStack,
  useToasts
} from '../components/ui'
import type { Column } from '../components/ui'
import type { BillingCycleRow, BillingCycleSummaryResponse, ItemsResponse } from '../types/api'

interface GenerateResult {
  period: string
  created: number
  skipped: number
  totalCentavos: number
  invoiceNumbers?: string[]
}

export function BillingScreen(): React.JSX.Element {
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()

  const [showGenerate, setShowGenerate] = useState(false)
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null)

  const cycles = useApiQuery<ItemsResponse<BillingCycleRow>>(
    ['billing', 'cycles'],
    (client) => client.get<ItemsResponse<BillingCycleRow>>('/billing/cycles', { query: { limit: 24 } })
  )

  if (cycles.error?.isUnreachable) {
    return <LoadError message={describeError(cycles.error)} onRetry={() => void cycles.refetch()} />
  }

  const rows = cycles.data?.items ?? []

  const columns: Array<Column<BillingCycleRow>> = [
    {
      key: 'period',
      header: 'Period',
      render: (row) => <span className="text-bold mono">{row.period}</span>
    },
    { key: 'invoices', header: 'Invoices', align: 'right', render: (row) => formatNumber(row.invoiceCount) },
    {
      key: 'billed',
      header: 'Total billed',
      money: true,
      render: (row) => <span className="money">{displayMoney({ totalBilledCentavos: row.totalBilledCentavos }, 'totalBilled')}</span>
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
    { key: 'generated', header: 'Generated', render: (row) => formatDateTime(row.finalizedAt ?? row.generatedAt) },
    { key: 'by', header: 'By', render: (row) => row.generatedByName }
  ]

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Monthly cycles, and what each one raised"
        actions={
          can('billing.generate') ? (
            <button type="button" className="btn btn--primary" onClick={() => setShowGenerate(true)}>
              Generate invoices
            </button>
          ) : null
        }
      />

      <div className="stack">
        <Panel flush title="Billing cycles" subtitle="Most recent first">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={cycles.isPending}
            onRowClick={(row) => setSelectedPeriod(row.period)}
            empty={<EmptyState title="No billing cycle has been run yet" hint="Generate the current month to get started." />}
          />
        </Panel>
      </div>

      {showGenerate ? (
        <GenerateModal
          existingPeriods={rows.map((row) => row.period)}
          onClose={() => setShowGenerate(false)}
          onGenerated={(result) => {
            setShowGenerate(false)
            push(
              'success',
              result.created > 0
                ? `${formatPeriod(result.period)}: ${result.created} invoice(s) created.`
                : `${formatPeriod(result.period)} was already generated; nothing new was created.`
            )
            void cycles.refetch()
          }}
        />
      ) : null}

      {selectedPeriod ? (
        <CycleSummaryModal period={selectedPeriod} onClose={() => setSelectedPeriod(null)} />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

/* --------------------------------------------------------------- summary */

function CycleSummaryModal({ period, onClose }: { period: string; onClose: () => void }): React.JSX.Element {
  const summary = useApiQuery<BillingCycleSummaryResponse>(
    ['billing', 'cycles', period, 'summary'],
    (client) => client.get<BillingCycleSummaryResponse>(`/billing/cycles/${period}/summary`)
  )

  return (
    <Modal title={`Cycle ${formatPeriod(period)}`} onClose={onClose} width={620}>
      {summary.error ? (
        <Banner tone="error" title="The cycle summary could not be loaded">
          {describeError(summary.error)}
        </Banner>
      ) : null}

      <div className="stack">
        <div className="stat-grid">
          {(summary.data?.rows ?? []).map((row) => (
            <StatTile
              key={row.status}
              label={humanizeToken(row.status)}
              value={displayMoney({ totalCentavos: row.totalCentavos }, 'total')}
              hint={`${formatNumber(row.invoiceCount)} invoice(s) · balance ${displayMoney({ balanceCentavos: row.balanceCentavos }, 'balance')}`}
              tone={row.status === 'PAID' ? 'success' : row.status === 'OVERDUE' ? 'warning' : 'info'}
            />
          ))}
        </div>

        <p className="text-sm text-muted">
          The balance is what is still collectible from this cycle. It falls as payments are applied, so a cycle that
          shows a zero balance has been fully collected.
        </p>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------- generate */

function GenerateModal({
  existingPeriods,
  onClose,
  onGenerated
}: {
  existingPeriods: string[]
  onClose: () => void
  onGenerated: (result: GenerateResult) => void
}): React.JSX.Element {
  const [period, setPeriod] = useState('')
  const [applyPenalty, setApplyPenalty] = useState(false)

  const alreadyRun = existingPeriods.includes(period.trim())

  const generate = useApiMutation<{ period: string; applyPenalty: boolean }, GenerateResult>(
    (client, body) => client.post<GenerateResult>('/billing/generate', body),
    { onSuccess: onGenerated }
  )

  const periodError =
    period.trim() === ''
      ? 'Enter a period in YYYY-MM format.'
      : /^\d{4}-(0[1-9]|1[0-2])$/.test(period.trim())
        ? undefined
        : 'Use YYYY-MM, for example 2026-09.'

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const ok = await confirmAction({
      message: `Generate invoices for ${formatPeriod(period.trim())}?`,
      detail: alreadyRun
        ? 'This period has already been generated. Running it again will not create new invoices.'
        : 'Invoices are raised for every active service account. The action is recorded in the audit log.',
      confirmLabel: 'Generate'
    })
    if (!ok) {
      return
    }
    await generate.mutateAsync({ period: period.trim(), applyPenalty }).catch(() => undefined)
  }

  return (
    <Modal
      title="Generate monthly invoices"
      subtitle="Raises subscriptions for every active service account in the period"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="text-sm text-muted">Safe to run twice: the second run creates nothing.</span>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="generate-billing-form"
              className="btn btn--primary"
              disabled={Boolean(periodError) || generate.isPending}
            >
              {generate.isPending ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </>
      }
    >
      <form id="generate-billing-form" className="stack" onSubmit={submit}>
        {generate.error ? (
          <Banner tone="error" title="The billing period was not generated">
            {describeError(generate.error)}
          </Banner>
        ) : null}

        {alreadyRun ? (
          <Banner tone="info" title="This period already exists">
            Running it again will report the original invoice numbers and create nothing.
          </Banner>
        ) : null}

        <Field label="Billing period" required error={periodError ?? generate.error?.fieldErrors.period} hint="YYYY-MM">
          <input
            className="input mono"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            placeholder="2026-09"
            autoFocus
          />
        </Field>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={applyPenalty}
            onChange={(event) => setApplyPenalty(event.target.checked)}
          />
          <span>
            Apply late-payment penalties
            <span className="text-sm text-muted"> — adds a penalty line to invoices whose due date has passed.</span>
          </span>
        </label>
      </form>
    </Modal>
  )
}
