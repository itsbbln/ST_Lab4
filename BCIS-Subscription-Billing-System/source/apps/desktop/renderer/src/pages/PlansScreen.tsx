/**
 * Service plans.
 *
 * A plan is the price book: what a subscriber pays each month, what installation
 * costs, and what a reconnection costs. Rates are read-only here even for
 * `plan.manage` users on purpose — see the note in `PlanPrice` about why editing
 * a live rate is a billing-cycle decision rather than a field edit.
 */

import { useState } from 'react'

import { centavosToPesosInput, displayMoney, pesosToCentavos } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { formatNumber, humanizeToken } from '../lib/format'
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
import type { ItemsResponse, PlanRow } from '../types/api'

const SERVICE_TYPES = ['CABLE', 'INTERNET', 'CABLE_INTERNET'] as const

export function PlansScreen(): React.JSX.Element {
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()

  const [serviceType, setServiceType] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [editing, setEditing] = useState<PlanRow | null>(null)

  const plans = useApiQuery<ItemsResponse<PlanRow>>(['plans', serviceType, includeInactive], (client) =>
    client.get<ItemsResponse<PlanRow>>('/plans', {
      query: { serviceType: serviceType || undefined, includeInactive: includeInactive ? 'true' : undefined }
    })
  )

  if (plans.error || !plans.data) {
    return <LoadError message={describeError(plans.error)} onRetry={() => void plans.refetch()} />
  }

  const rows = plans.data.items
  const cheapest = rows.reduce<PlanRow | null>(
    (lowest, row) => (!lowest || row.monthlyPriceCentavos < lowest.monthlyPriceCentavos ? row : lowest),
    null
  )
  const dearest = rows.reduce<PlanRow | null>(
    (highest, row) => (!highest || row.monthlyPriceCentavos > highest.monthlyPriceCentavos ? row : highest),
    null
  )

  const columns: Array<Column<PlanRow>> = [
    {
      key: 'plan',
      header: 'Plan',
      render: (row) => (
        <div>
          <div className="text-bold">{row.name}</div>
          <div className="text-xs text-muted mono">{row.code}</div>
        </div>
      )
    },
    { key: 'type', header: 'Service', render: (row) => row.serviceTypeName || humanizeToken(row.serviceType) },
    {
      key: 'spec',
      header: 'Specification',
      render: (row) => (
        <span className="text-sm">
          {row.serviceType === 'CABLE' && row.channelCount
            ? `${formatNumber(row.channelCount)} channels`
            : row.speedMbps
              ? `${row.speedMbps} Mbps`
              : '—'}
        </span>
      )
    },
    {
      key: 'monthly',
      header: 'Monthly',
      money: true,
      render: (row) => (
        <span className="money text-bold">{displayMoney({ monthlyPriceCentavos: row.monthlyPriceCentavos }, 'monthly')}</span>
      )
    },
    {
      key: 'installation',
      header: 'Installation',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ installationFeeCentavos: row.installationFeeCentavos }, 'installation')}</span>
      )
    },
    {
      key: 'reconnection',
      header: 'Reconnection',
      money: true,
      render: (row) => (
        <span className="money">{displayMoney({ reconnectionFeeCentavos: row.reconnectionFeeCentavos }, 'reconnection')}</span>
      )
    },
    { key: 'active', header: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        can('plan.manage') ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={(event) => {
              event.stopPropagation()
              setEditing(row)
            }}
          >
            Edit
          </button>
        ) : null
    }
  ]

  return (
    <>
      <PageHeader
        title="Service plans"
        subtitle="The price book every invoice is generated from"
        actions={
          <button type="button" className="btn" onClick={() => void printCurrent('page')}>
            Print price list
          </button>
        }
      />

      <div className="stack">
        <Banner tone="info" title="Changing a rate does not reprice past invoices">
          A plan's monthly price is copied onto each invoice when the billing cycle is generated. Editing the rate here
          affects the next cycle only; already-issued invoices keep the amount the subscriber agreed to.
        </Banner>

        <div className="stat-grid">
          <StatTile label="Plans" value={formatNumber(rows.length)} hint={`${rows.filter((row) => row.isActive).length} active`} />
          <StatTile
            label="Lowest monthly"
            value={cheapest ? displayMoney({ monthlyPriceCentavos: cheapest.monthlyPriceCentavos }, 'monthly') : '—'}
            hint={cheapest?.name}
            tone="success"
          />
          <StatTile
            label="Highest monthly"
            value={dearest ? displayMoney({ monthlyPriceCentavos: dearest.monthlyPriceCentavos }, 'monthly') : '—'}
            hint={dearest?.name}
          />
        </div>

        <Panel flush title="Plans">
          <div className="filter-bar">
            <label className="field">
              <span className="field__label">Service type</span>
              <select className="select" value={serviceType} onChange={(event) => setServiceType(event.target.value)}>
                <option value="">All service types</option>
                {SERVICE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {humanizeToken(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field--check">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
              />
              <span>Include inactive plans</span>
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setServiceType('')
                setIncludeInactive(false)
                void plans.refetch()
              }}
            >
              Clear
            </button>
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            empty={<EmptyState title="No plans match these filters" hint="Plans are seeded with the demo data." />}
          />
        </Panel>
      </div>

      {editing ? (
        <EditPlanModal
          plan={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            push('success', message)
            void plans.refetch()
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

/**
 * Money goes out as peso decimal strings (`monthlyPrice: "649.00"`), not
 * centavos, because `upsertPlanSchema` runs every amount through `parseCentavos`.
 * Sending centavos here would post a ₱100 price.
 */
interface PlanUpdateBody {
  name?: string
  monthlyPrice?: string
  installationFee?: string
  reconnectionFee?: string
  description?: string
  isActive?: boolean
}

function EditPlanModal({
  plan,
  onClose,
  onSaved
}: {
  plan: PlanRow
  onClose: () => void
  onSaved: (message: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(plan.name)
  const [description, setDescription] = useState(plan.description)
  const [monthly, setMonthly] = useState(centavosToPesosInput(plan.monthlyPriceCentavos))
  const [installation, setInstallation] = useState(centavosToPesosInput(plan.installationFeeCentavos))
  const [reconnection, setReconnection] = useState(centavosToPesosInput(plan.reconnectionFeeCentavos))
  const [isActive, setIsActive] = useState(plan.isActive)
  const [touched, setTouched] = useState(false)

  const save = useApiMutation<PlanUpdateBody, { id: string; code: string }>(
    (client, body) => client.put<{ id: string; code: string }>(`/plans/${plan.id}`, body),    { onSuccess: (result) => onSaved(`${result.code} was updated. It applies from the next billing cycle.`) }
  )

  /** Mirrors the shared schema so the user is told before a round trip. */
  const fieldErrors: Record<string, string> = {}
  if (name.trim().length < 3 || name.trim().length > 120) {
    fieldErrors.name = 'Plan name must be between 3 and 120 characters.'
  }
  if (pesosToCentavos(monthly) === null || (pesosToCentavos(monthly) ?? 0) <= 0) {
    fieldErrors.monthly = 'Enter a peso amount with at most two decimal places, greater than zero.'
  }
  for (const [key, value] of [
    ['installation', installation],
    ['reconnection', reconnection]
  ] as const) {
    if (pesosToCentavos(value) === null || (pesosToCentavos(value) ?? -1) < 0) {
      fieldErrors[key] = 'Enter a peso amount of zero or more.'
    }
  }

  const errorCount = Object.keys(fieldErrors).length
  const validate = (): boolean => {
    setTouched(true)
    return errorCount === 0
  }

  return (
    <Modal
      title={`Edit ${plan.code}`}
      subtitle={`${plan.serviceTypeName} · currently billed at ${displayMoney({ monthlyPriceCentavos: plan.monthlyPriceCentavos }, 'monthly')} a month`}
      onClose={onClose}
      width={560}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending}
            onClick={() => {
              if (!validate()) {
                return
              }
              void save
                .mutateAsync({
                  name: name.trim(),
                  description: description.trim(),
                  monthlyPrice: monthly.trim(),
                  installationFee: installation.trim(),
                  reconnectionFee: reconnection.trim(),
                  isActive
                })
                .catch(() => undefined)
            }}
          >
            {save.isPending ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {save.error ? (
          <Banner tone="error" title="The plan was not saved">
            {describeError(save.error)}
          </Banner>
        ) : null}

        {touched && errorCount > 0 ? (
          <Banner tone="warning" title="Fix the highlighted fields before saving" />
        ) : null}

        <Field label="Plan name" required error={touched ? fieldErrors.name : undefined}>
          <input
            className={`input${touched && fieldErrors.name ? ' input--error' : ''}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <div className="form-grid">
          <Field
            label="Monthly price"
            required
            hint="Pesos, e.g. 599.00"
            error={touched ? fieldErrors.monthly : undefined}
          >
            <input
              className={`input input--money${touched && fieldErrors.monthly ? ' input--error' : ''}`}
              inputMode="decimal"
              value={monthly}
              onChange={(event) => setMonthly(event.target.value)}
            />
          </Field>
          <Field
            label="Installation fee"
            hint="Pesos; zero is allowed"
            error={touched ? fieldErrors.installation : undefined}
          >
            <input
              className={`input input--money${touched && fieldErrors.installation ? ' input--error' : ''}`}
              inputMode="decimal"
              value={installation}
              onChange={(event) => setInstallation(event.target.value)}
            />
          </Field>
          <Field
            label="Reconnection fee"
            hint="Pesos; zero is allowed"
            error={touched ? fieldErrors.reconnection : undefined}
          >
            <input
              className={`input input--money${touched && fieldErrors.reconnection ? ' input--error' : ''}`}
              inputMode="decimal"
              value={reconnection}
              onChange={(event) => setReconnection(event.target.value)}
            />
          </Field>
        </div>

        <Field label="Description" hint="Shown to office staff on the subscriber form">
          <textarea
            className="textarea"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <label className="field field--check">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          <span>Active — inactive plans cannot be assigned to new service accounts</span>
        </label>
      </div>
    </Modal>
  )
}
