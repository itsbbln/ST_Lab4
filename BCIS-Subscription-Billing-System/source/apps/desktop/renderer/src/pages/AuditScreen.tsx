import {
  DataTable,
  EmptyState,
  LoadError,
  PageHeader,
  Panel,
  Pagination
} from '../components/ui'
import type { Column } from '../components/ui'
import { ReportExportMenu } from '../components/export'
import { formatDateTime, humanizeToken } from '../lib/format'
import { usePagedList } from '../lib/query'

interface AuditRow {
  id: string
  createdAt: string
  actorName: string
  actorUsername: string
  action: string
  entityType: string | null
  entityId: string | null
  reason: string | null
  oldValues: unknown
  newValues: unknown
  ipAddress: string | null
}

interface AuditResponse {
  items: AuditRow[]
  page: number
  pageSize: number
  total: number
}

export function AuditScreen(): React.JSX.Element {
  const list = usePagedList<AuditRow, AuditResponse>('/audit', {}, 25)

  if (list.error) {
    return <LoadError message={list.error.message} onRetry={list.refetch} />
  }

  const columns: Array<Column<AuditRow>> = [
    { key: 'date', header: 'When', render: (row) => formatDateTime(row.createdAt) },
    {
      key: 'actor',
      header: 'Operator',
      render: (row) => (
        <div>
          <div className="text-bold">{row.actorName}</div>
          <div className="text-xs text-muted">{row.actorUsername}</div>
        </div>
      )
    },
    { key: 'action', header: 'Action', render: (row) => humanizeToken(row.action.replaceAll('.', '_')) },
    {
      key: 'entity',
      header: 'Record',
      render: (row) => row.entityType ? `${humanizeToken(row.entityType)}${row.entityId ? ` · ${row.entityId}` : ''}` : '—'
    },
    {
      key: 'details',
      header: 'Details',
      render: (row) => {
        const details = { reason: row.reason, oldValues: row.oldValues, newValues: row.newValues }
        return Object.values(details).some(Boolean) ? (
          <details>
            <summary>View</summary>
            <pre className="text-xs">{JSON.stringify(details, null, 2)}</pre>
          </details>
        ) : '—'
      }
    }
  ]

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle="Append-only record of operator and system activity"
        actions={<ReportExportMenu path="/reports/audit" suggestedName="bcis-audit-trail" />}
      />
      <Panel flush title="Recent activity">
        <DataTable
          columns={columns}
          rows={list.query?.items ?? []}
          rowKey={(row) => row.id}
          loading={list.isPending}
          empty={<EmptyState title="No audit activity" />}
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