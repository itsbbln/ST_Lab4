/**
 * Collection topology: areas, routes, collectors.
 *
 * These three are the shape of the collections operation. A batch is opened for
 * an area and a route, and assigned to a collector, so a batch cannot exist
 * without all three being set up first. The screen keeps them on one page
 * because that dependency is the reason each is hard to find on its own.
 *
 * Every write here needs `settings.manage`; the read-only view is available to
 * anyone with `collection.view`, which is what a collector needs.
 */

import { useState } from 'react'

import { describeError } from '../lib/desktop'
import { formatDate, formatNumber } from '../lib/format'
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
  TabBar,
  ToastStack,
  useToasts
} from '../components/ui'
import type { Column } from '../components/ui'
import type { CollectorRow, CollectionAreaRow, CollectionRouteRow, ItemsResponse } from '../types/api'

type Tab = 'areas' | 'routes' | 'collectors'

export function CollectionSetupScreen(): React.JSX.Element {
  const { can } = useAuth()
  const [tab, setTab] = useState<Tab>('areas')

  const areas = useApiQuery<ItemsResponse<CollectionAreaRow>>(['collection-areas', 'all'], (client) =>
    client.get<ItemsResponse<CollectionAreaRow>>('/collection-areas')
  )
  const routes = useApiQuery<ItemsResponse<CollectionRouteRow>>(['collection-routes', 'all'], (client) =>
    client.get<ItemsResponse<CollectionRouteRow>>('/collection-routes')
  )
  const collectors = useApiQuery<ItemsResponse<CollectorRow>>(['collectors', 'all'], (client) =>
    client.get<ItemsResponse<CollectorRow>>('/collectors')
  )

  const loading = areas.isPending || routes.isPending || collectors.isPending
  const failed = areas.error ?? routes.error ?? collectors.error
  if (failed) {
    return <LoadError message={describeError(failed)} onRetry={() => void areas.refetch()} />
  }

  const areaRows = areas.data?.items ?? []
  const routeRows = routes.data?.items ?? []
  const collectorRows = collectors.data?.items ?? []

  return (
    <>
      <PageHeader
        title="Areas, routes & collectors"
        subtitle="The collection topology every batch is built on"
        tabs={
          <TabBar
            tabs={[
              { key: 'areas', label: 'Areas', count: areaRows.length },
              { key: 'routes', label: 'Routes', count: routeRows.length },
              { key: 'collectors', label: 'Collectors', count: collectorRows.length }
            ]}
            active={tab}
            onChange={(key) => setTab(key === 'routes' || key === 'collectors' ? key : 'areas')}
          />
        }
      />

      <div className="stack">
        {!can('settings.manage') ? (
          <Banner tone="info" title="Read-only">
            Setting up areas, routes and collectors needs the <code>settings.manage</code> permission. Ask an owner or
            administrator to make changes here.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile label="Areas" value={formatNumber(areaRows.length)} hint={`${areaRows.filter((row) => row.isActive).length} active`} />
          <StatTile label="Routes" value={formatNumber(routeRows.length)} hint={`${routeRows.filter((row) => row.isActive).length} active`} />
          <StatTile
            label="Collectors"
            value={formatNumber(collectorRows.length)}
            hint={`${collectorRows.filter((row) => row.isActive).length} active`}
          />
          <StatTile
            label="Average routes per area"
            value={
              areaRows.length === 0 ? '—' : (routeRows.length / areaRows.length).toFixed(1)
            }
            hint="A thin spread means long walks between houses"
          />
        </div>

        {tab === 'areas' ? <AreasPanel areas={areaRows} loading={loading} editable={can('settings.manage')} /> : null}
        {tab === 'routes' ? (
          <RoutesPanel routes={routeRows} areas={areaRows} loading={loading} editable={can('settings.manage')} />
        ) : null}
        {tab === 'collectors' ? (
          <CollectorsPanel collectors={collectorRows} loading={loading} editable={can('settings.manage')} />
        ) : null}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ areas */

/**
 * Areas, routes and collectors are create-only: the API exposes `GET` and `POST`
 * for each and no update route. A correction is therefore a deactivation handled
 * outside this screen, so there is deliberately no Edit button that would
 * silently post a duplicate.
 */

function AreasPanel({
  areas,
  loading,
  editable
}: {
  areas: CollectionAreaRow[]
  loading: boolean
  editable: boolean
}): React.JSX.Element {
  const { toasts, push, dismiss } = useToasts()
  const [adding, setAdding] = useState(false)

  const columns: Array<Column<CollectionAreaRow>> = [
    {
      key: 'area',
      header: 'Area',
      render: (row) => (
        <div>
          <div className="text-bold">{row.name}</div>
          <div className="text-xs text-muted mono">{row.code}</div>
        </div>
      )
    },
    { key: 'description', header: 'Description', render: (row) => row.description || <span className="text-subtle">—</span> },
    { key: 'created', header: 'Created', render: (row) => formatDate(row.createdAt) },
    { key: 'active', header: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> }
  ]

  return (
    <Panel
      flush
      title="Collection areas"
      actions={
        editable ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setAdding(true)}>
            Add area
          </button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        rows={areas}
        rowKey={(row) => row.id}
        loading={loading}
        empty={<EmptyState title="No collection areas" hint="An area is the top of the collection hierarchy." />}
      />

      {adding ? (
        <AreaModal
          onClose={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false)
            push('success', message)
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </Panel>
  )
}

function AreaModal({ onClose, onSaved }: { onClose: () => void; onSaved: (message: string) => void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [touched, setTouched] = useState(false)

  const save = useApiMutation<{ code: string; name: string; description: string }, unknown>(
    (client, body) => client.post('/collection-areas', body),
    { onSuccess: () => onSaved(`${code.trim()} was created.`) }
  )

  /** `upsertCollectionAreaSchema`: code 2–30 chars, letters/numbers/dot/underscore/hyphen. */
  const codeError =
    code.trim().length < 2 || code.trim().length > 30
      ? 'Area code must be between 2 and 30 characters.'
      : /^[A-Za-z0-9._-]+$/.test(code.trim())
        ? undefined
        : 'Area code may only contain letters, numbers, dot, underscore and hyphen.'
  const nameError =
    name.trim().length < 3 || name.trim().length > 120 ? 'Area name must be between 3 and 120 characters.' : undefined
  const errorCount = [codeError, nameError].filter(Boolean).length

  return (
    <Modal
      title="Add collection area"
      subtitle="Areas group routes and subscribers for collection"
      onClose={onClose}
      width={480}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || Boolean(codeError) || Boolean(nameError)}
            onClick={() => {
              setTouched(true)
              if (errorCount > 0) {
                return
              }
              void save
                .mutateAsync({ code: code.trim(), name: name.trim(), description: description.trim() })
                .catch(() => undefined)
            }}
          >
            {save.isPending ? 'Saving…' : 'Create area'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {save.error ? (
          <Banner tone="error" title="The area was not created">
            {describeError(save.error)}
          </Banner>
        ) : null}
        <Field label="Code" required hint="Short identifier used on batch and route references" error={touched ? codeError : undefined}>
          <input
            className={`input mono${touched && codeError ? ' input--error' : ''}`}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <Field label="Name" required error={touched ? nameError : undefined}>
          <input
            className={`input${touched && nameError ? ' input--error' : ''}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Description" hint="Optional">
          <textarea
            className="textarea"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}

/* ----------------------------------------------------------------- routes */

function RoutesPanel({
  routes,
  areas,
  loading,
  editable
}: {
  routes: CollectionRouteRow[]
  areas: CollectionAreaRow[]
  loading: boolean
  editable: boolean
}): React.JSX.Element {
  const { toasts, push, dismiss } = useToasts()
  const [adding, setAdding] = useState(false)

  const columns: Array<Column<CollectionRouteRow>> = [
    {
      key: 'route',
      header: 'Route',
      render: (row) => (
        <div>
          <div className="text-bold">{row.name}</div>
          <div className="text-xs text-muted mono">{row.code}</div>
        </div>
      )
    },
    { key: 'area', header: 'Area', render: (row) => row.areaName },
    { key: 'description', header: 'Description', render: (row) => row.description || <span className="text-subtle">—</span> },
    { key: 'active', header: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> }
  ]

  return (
    <Panel
      flush
      title="Collection routes"
      subtitle="A named walking route inside an area"
      actions={
        editable ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setAdding(true)}>
            Add route
          </button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        rows={routes}
        rowKey={(row) => row.id}
        loading={loading}
        empty={<EmptyState title="No collection routes" hint="A batch is opened for one route, so routes come first." />}
      />

      {adding ? (
        <RouteModal
          areas={areas}
          onClose={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false)
            push('success', message)
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </Panel>
  )
}

function RouteModal({
  areas,
  onClose,
  onSaved
}: {
  areas: CollectionAreaRow[]
  onClose: () => void
  onSaved: (message: string) => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [areaId, setAreaId] = useState(areas[0]?.id ?? '')
  const [description, setDescription] = useState('')
  const [touched, setTouched] = useState(false)

  const save = useApiMutation<{ code: string; name: string; areaId: string; description: string }, unknown>(
    (client, body) => client.post('/collection-routes', body),
    { onSuccess: () => onSaved(`${code.trim()} was created.`) }
  )

  const codeError =
    code.trim().length < 2 || code.trim().length > 30
      ? 'Route code must be between 2 and 30 characters.'
      : /^[A-Za-z0-9._-]+$/.test(code.trim())
        ? undefined
        : 'Route code may only contain letters, numbers, dot, underscore and hyphen.'
  const nameError =
    name.trim().length < 3 || name.trim().length > 120 ? 'Route name must be between 3 and 120 characters.' : undefined
  const areaError = areaId ? undefined : 'Choose the area this route belongs to.'

  return (
    <Modal
      title="Add collection route"
      subtitle="A batch is opened for a route, so this must exist before collection starts"
      onClose={onClose}
      width={480}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || areas.length === 0}
            onClick={() => {
              setTouched(true)
              if (codeError || nameError || areaError) {
                return
              }
              void save
                .mutateAsync({
                  code: code.trim(),
                  name: name.trim(),
                  areaId,
                  description: description.trim()
                })
                .catch(() => undefined)
            }}
          >
            {save.isPending ? 'Saving…' : 'Create route'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {save.error ? (
          <Banner tone="error" title="The route was not created">
            {describeError(save.error)}
          </Banner>
        ) : null}
        {areas.length === 0 ? (
          <Banner tone="warning" title="Create an area first">
            A route has to belong to an area, and there are none yet.
          </Banner>
        ) : null}
        <Field label="Code" required hint="Short identifier used on batch references" error={touched ? codeError : undefined}>
          <input
            className={`input mono${touched && codeError ? ' input--error' : ''}`}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <Field label="Name" required error={touched ? nameError : undefined}>
          <input
            className={`input${touched && nameError ? ' input--error' : ''}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Area" required error={touched ? areaError : undefined}>
          <select
            className={`select${touched && areaError ? ' input--error' : ''}`}
            value={areaId}
            onChange={(event) => setAreaId(event.target.value)}
          >
            <option value="">Choose an area…</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name} ({area.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description" hint="Optional">
          <textarea
            className="textarea"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------- collectors */

function CollectorsPanel({
  collectors,
  loading,
  editable
}: {
  collectors: CollectorRow[]
  loading: boolean
  editable: boolean
}): React.JSX.Element {
  const { toasts, push, dismiss } = useToasts()
  const [adding, setAdding] = useState(false)

  const columns: Array<Column<CollectorRow>> = [
    {
      key: 'collector',
      header: 'Collector',
      render: (row) => (
        <div>
          <div className="text-bold">{row.fullName}</div>
          <div className="text-xs text-muted mono">{row.code}</div>
        </div>
      )
    },
    { key: 'contact', header: 'Contact', render: (row) => row.contactNumber || <span className="text-subtle">—</span> },
    { key: 'created', header: 'Added', render: (row) => formatDate(row.createdAt) },
    { key: 'active', header: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> }
  ]

  return (
    <Panel
      flush
      title="Collectors"
      subtitle="The people who carry a batch and hand the money back"
      actions={
        editable ? (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setAdding(true)}>
            Add collector
          </button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        rows={collectors}
        rowKey={(row) => row.id}
        loading={loading}
        empty={<EmptyState title="No collectors" hint="Add one before opening a collection batch." />}
      />

      {adding ? (
        <CollectorModal
          onClose={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false)
            push('success', message)
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </Panel>
  )
}

function CollectorModal({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved: (message: string) => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [fullName, setFullName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [touched, setTouched] = useState(false)

  const save = useApiMutation<{ code: string; fullName: string; contactNumber: string }, unknown>(
    (client, body) => client.post('/collectors', body),
    { onSuccess: () => onSaved(`${fullName.trim()} was added as a collector.`) }
  )

  const codeError =
    code.trim().length < 2 || code.trim().length > 30
      ? 'Collector code must be between 2 and 30 characters.'
      : /^[A-Za-z0-9._-]+$/.test(code.trim())
        ? undefined
        : 'Collector code may only contain letters, numbers, dot, underscore and hyphen.'
  const nameError =
    fullName.trim().length < 3 || fullName.trim().length > 120
      ? 'Full name must be between 3 and 120 characters.'
      : undefined
  const contactError =
    contactNumber.trim().length < 7 || contactNumber.trim().length > 30
      ? 'Contact number must be between 7 and 30 characters.'
      : /^[0-9+\-\s()]+$/.test(contactNumber.trim())
        ? undefined
        : 'Contact number may only contain digits and phone separators.'

  return (
    <Modal
      title="Add collector"
      subtitle="Collectors are assigned to batches and are accountable for the money they carry"
      onClose={onClose}
      width={480}
      footer={
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || Boolean(codeError) || Boolean(nameError) || Boolean(contactError)}
            onClick={() => {
              setTouched(true)
              if (codeError || nameError || contactError) {
                return
              }
              void save
                .mutateAsync({
                  code: code.trim(),
                  fullName: fullName.trim(),
                  contactNumber: contactNumber.trim()
                })
                .catch(() => undefined)
            }}
          >
            {save.isPending ? 'Saving…' : 'Add collector'}
          </button>
        </div>
      }
    >
      <div className="stack">
        {save.error ? (
          <Banner tone="error" title="The collector was not saved">
            {describeError(save.error)}
          </Banner>
        ) : null}
        <Field label="Code" required hint="Short identifier shown on batch sheets" error={touched ? codeError : undefined}>
          <input
            className={`input mono${touched && codeError ? ' input--error' : ''}`}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <Field label="Full name" required error={touched ? nameError : undefined}>
          <input
            className={`input${touched && nameError ? ' input--error' : ''}`}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </Field>
        <Field label="Contact number" required error={touched ? contactError : undefined}>
          <input
            className={`input mono${touched && contactError ? ' input--error' : ''}`}
            value={contactNumber}
            onChange={(event) => setContactNumber(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
