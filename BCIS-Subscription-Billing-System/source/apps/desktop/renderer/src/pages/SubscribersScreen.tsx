/**
 * The subscriber directory.
 *
 * `GET /subscribers/search` doubles as the global search box the specification
 * asks for: it matches an account number, name, contact number, address,
 * receipt number, invoice number or GCash reference in a single query, so there
 * is no separate "find anything" screen to keep in sync with this list.
 */

import { useState } from 'react'

import { describeError } from '../lib/desktop'
import { humanizeToken } from '../lib/format'
import { displayMoney } from '../lib/api'
import { useApiMutation, useApiQuery, usePagedList } from '../lib/query'
import { useAuth } from '../lib/auth'
import { useNavigate } from '../lib/router'
import { SubscriberProfileScreen } from './SubscriberProfileScreen'
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
  ToastStack,
  useToasts
} from '../components/ui'
import type { Column } from '../components/ui'
import type { ItemsResponse, SubscriberListRow } from '../types/api'
import type { CollectionAreaRow } from '../types/api'

const STATUS_OPTIONS = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'TERMINATED', 'ARCHIVED'] as const

/**
 * The list and the profile are separate components so the profile route does not
 * have to run the list's queries, and so neither screen's hooks are called
 * conditionally when the other is showing.
 */
export function SubscribersScreen({ initialSubscriberId }: { initialSubscriberId?: string } = {}): React.JSX.Element {
  const navigate = useNavigate()

  if (initialSubscriberId) {
    return <SubscriberProfileScreen subscriberId={initialSubscriberId} onBack={() => navigate('/subscribers')} />
  }

  return <SubscriberList />
}

function SubscriberList(): React.JSX.Element {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toasts, push, dismiss } = useToasts()
  const [showForm, setShowForm] = useState(false)

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [areaId, setAreaId] = useState('')

  const list = usePagedList<SubscriberListRow>('/subscribers/search', { q: search, status, areaId })

  const areas = useApiQuery(
    ['collection-areas', 'active'],
    (client) =>
      client.get<ItemsResponse<CollectionAreaRow>>('/collection-areas', {
        query: { activeOnly: true }
      })
  )

  const columns: Array<Column<SubscriberListRow>> = [
    {
      key: 'subscriber',
      header: 'Subscriber',
      width: '26%',
      render: (row) => (
        <div>
          <div className="text-bold">{row.fullName}</div>
          <div className="text-xs text-muted mono">{row.accountNumber}</div>
        </div>
      )
    },
    {
      key: 'address',
      header: 'Principal address',
      render: (row) => (
        <div>
          <div>{row.addressLine}</div>
          <div className="text-xs text-muted">{row.city}</div>
        </div>
      )
    },
    { key: 'contact', header: 'Contact', render: (row) => row.contactNumber || '—' },
    { key: 'area', header: 'Area', render: (row) => row.areaName },
    {
      key: 'services',
      header: 'Services',
      align: 'center',
      render: (row) => row.serviceAccountCount
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      money: true,
      render: (row) => <MoneyCell figure="outstanding" row={row} />
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> }
  ]

  const total = list.query?.total ?? 0
  const page = list.query?.items ?? []

  if (list.error?.isUnreachable) {
    return <LoadError message={describeError(list.error)} onRetry={list.refetch} />
  }

  return (
    <>
      <PageHeader
        title="Subscribers"
        subtitle="Search by name, account number, address, receipt number or invoice number"
        actions={
          can('subscriber.manage') ? (
            <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
              New subscriber
            </button>
          ) : null
        }
      />

      <Panel
        flush
        title="Directory"
        subtitle={
          list.isPending && !list.query
            ? 'Searching…'
            : `${total} subscriber${total === 1 ? '' : 's'} match${total === 1 ? 'es' : ''} these filters`
        }
      >
        <div className="filter-bar">
          <label className="field filter-bar__grow">
            <span className="field__label">Search</span>
            <input
              className="input"
              value={search}
              placeholder="Name, account no., address, receipt or invoice no."
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
            <select
              className="select"
              value={areaId}
              onChange={(event) => {
                setAreaId(event.target.value)
                list.setFilter('areaId', event.target.value)
              }}
            >
              <option value="">All areas</option>
              {areas.data?.items.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
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
              setAreaId('')
              list.resetFilters()
            }}
          >
            Clear
          </button>
        </div>

        <DataTable
          columns={columns}
          rows={page}
          rowKey={(row) => row.id}
          loading={list.isPending}
          onRowClick={(row) => navigate(`/subscribers/${row.id}`)}
          empty={
            <EmptyState
              title="No subscribers match these filters"
              hint="Try a shorter search term, or clear the area and status filters."
            />
          }
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

      {showForm ? (
        <SubscriberForm
          onClose={() => setShowForm(false)}
          onSaved={(message) => {
            setShowForm(false)
            push('success', message)
            list.refetch()
          }}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  )
}

/**
 * A money cell.
 *
 * The API sends `outstandingCentavos` alongside a formatted `outstanding`
 * string; `displayMoney` prefers the server's string so the table cannot show a
 * figure that disagrees with the ledger. A dash is used for a zero balance
 * rather than `₱0.00`, which reads as more legible in a dense table.
 */
function MoneyCell({ row, figure }: { row: SubscriberListRow; figure: string }): React.JSX.Element {
  const text = displayMoney(row, figure)
  if (text === '₱0.00' || text === '0.00') {
    return <span className="money text-subtle">—</span>
  }
  return <span className="money">{text}</span>
}

/* ---------------------------------------------------------------- the form */

interface SubscriberFormValues {
  fullName: string
  contactNumber: string
  email: string
  addressLine: string
  city: string
  collectionAreaId: string
  status: string
  notes: string
}

const EMPTY_FORM: SubscriberFormValues = {
  fullName: '',
  contactNumber: '',
  email: '',
  addressLine: '',
  city: '',
  collectionAreaId: '',
  status: 'ACTIVE',
  notes: ''
}

function SubscriberForm({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved: (message: string) => void
}): React.JSX.Element {
  const [values, setValues] = useState<SubscriberFormValues>(EMPTY_FORM)

  const areas = useApiQuery(
    ['collection-areas', 'active'],
    (client) =>
      client.get<ItemsResponse<CollectionAreaRow>>('/collection-areas', {
        query: { activeOnly: true }
      })
  )

  const create = useApiMutation<SubscriberFormValues, SubscriberListRow>(
    (client, body) =>
      client.post<SubscriberListRow>('/subscribers', {
        ...body,
        // The API treats an absent optional value as null rather than "".
        email: body.email || null,
        notes: body.notes || null
      }),
    { onSuccess: () => onSaved('Subscriber created.') }
  )

  const set =
    (key: keyof SubscriberFormValues) =>
    (
      event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
    ): void => setValues((current) => ({ ...current, [key]: event.target.value }))

  const fieldError = (key: keyof SubscriberFormValues): string | undefined => create.error?.fieldErrors[key]

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await create.mutateAsync(values).catch(() => undefined)
  }

  return (
    <Modal
      title="New subscriber"
      subtitle="An account number is assigned automatically."
      onClose={onClose}
      width={680}
      footer={
        <>
          <span className="text-sm text-muted">
            Service accounts are created separately, so one subscriber can hold several services.
          </span>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="subscriber-form"
              className="btn btn--primary"
              disabled={create.isPending}
            >
              {create.isPending ? 'Saving…' : 'Create subscriber'}
            </button>
          </div>
        </>
      }
    >
      <form id="subscriber-form" className="stack" onSubmit={submit}>
        {create.error ? (
          <Banner tone="error" title="The subscriber was not created">
            {describeError(create.error)}
          </Banner>
        ) : null}

        <div>
          <div className="form-section__title">Identity</div>
          <div className="form-grid">
            <Field label="Full name" required error={fieldError('fullName')}>
              <input className="input" value={values.fullName} onChange={set('fullName')} autoFocus />
            </Field>
            <Field label="Contact number" required error={fieldError('contactNumber')}>
              <input
                className="input"
                value={values.contactNumber}
                onChange={set('contactNumber')}
                placeholder="09XX XXX XXXX"
              />
            </Field>
            <Field label="Email" hint="Optional" error={fieldError('email')}>
              <input className="input" type="email" value={values.email} onChange={set('email')} />
            </Field>
            <Field label="Status" required error={fieldError('status')}>
              <select className="select" value={values.status} onChange={set('status')}>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {humanizeToken(option)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <div>
          <div className="form-section__title">Principal address</div>
          <div className="form-grid">
            <Field label="Address line" required error={fieldError('addressLine')}>
              <input className="input" value={values.addressLine} onChange={set('addressLine')} />
            </Field>
            <Field label="City / municipality" required error={fieldError('city')}>
              <input className="input" value={values.city} onChange={set('city')} />
            </Field>
            <Field
              label="Collection area"
              required
              error={fieldError('collectionAreaId')}
              hint="Drives collection batches and overdue reports"
            >
              <select
                className="select"
                value={values.collectionAreaId}
                onChange={set('collectionAreaId')}
              >
                <option value="">Select an area</option>
                {areas.data?.items.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <Field label="Notes" hint="Optional; visible to office staff only" error={fieldError('notes')}>
          <textarea className="textarea" value={values.notes} onChange={set('notes')} rows={3} />
        </Field>
      </form>
    </Modal>
  )
}
