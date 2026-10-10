import { useState } from 'react'

import { Badge, Banner, DataTable, EmptyState, Field, LoadError, PageHeader, Panel } from '../components/ui'
import type { Column } from '../components/ui'
import { confirmAction } from '../lib/desktop'
import { formatDateTime, formatNumber, humanizeToken } from '../lib/format'
import { useApiMutation, useApiQuery } from '../lib/query'

interface BackupRecord {
  id: string
  backupId: string
  fileName: string
  filePath: string
  fileSizeBytes: number
  checksum: string | null
  checksumAlgorithm: string
  status: 'CREATED' | 'VERIFIED' | 'RESTORED' | 'FAILED'
  includesAttachments: boolean
  tableCounts: Record<string, number> | null
  createdByName: string | null
  createdAt: string
  verifiedAt: string | null
  verifiedByName: string | null
  restoredAt: string | null
  restoredByName: string | null
  notes: string | null
  filePresent?: boolean
  attachmentsPresent?: boolean
}

interface BackupListResponse {
  items: BackupRecord[]
}

interface CreateBackupResponse {
  backup: BackupRecord
  tableCounts: Record<string, number>
}

interface VerifyBackupResponse {
  backup: BackupRecord
  ok: boolean
  notes: string[]
}

interface IntegrityCheck {
  name: string
  description: string
  passed: boolean
  severity: 'ERROR' | 'WARNING'
  violations: number
  samples: string[]
}

interface IntegrityReport {
  passed: boolean
  checkedAt: string
  total: number
  failed: number
  checks: IntegrityCheck[]
}

export function BackupsScreen(): React.JSX.Element {
  const [includesAttachments, setIncludesAttachments] = useState(true)
  const [notes, setNotes] = useState('')
  const [operationMessage, setOperationMessage] = useState<string | null>(null)
  const backups = useApiQuery<BackupListResponse>(['backups'], (client) => client.get<BackupListResponse>('/backups'))
  const integrity = useApiQuery<IntegrityReport>(['backup-integrity'], (client) =>
    client.get<IntegrityReport>('/backups/integrity')
  )

  const create = useApiMutation<{ includesAttachments: boolean; notes?: string }, CreateBackupResponse>(
    (client, request) => client.post<CreateBackupResponse>('/backups', request),
    { onSuccess: (result) => {
      setOperationMessage(`Backup ${result.backup.backupId} created. Verify it before restoring.`)
      void backups.refetch()
    } }
  )
  const verify = useApiMutation<{ backupId: string }, VerifyBackupResponse>(
    (client, request) => client.post<VerifyBackupResponse>(`/backups/${request.backupId}/verify`, {}),
    { onSuccess: (result) => {
      setOperationMessage(result.ok ? `${result.backup.backupId} passed verification.` : `${result.backup.backupId} did not pass verification.`)
      void backups.refetch()
    } }
  )
  const restore = useApiMutation<{ backupId: string }, { backup: BackupRecord; integrity: IntegrityReport }>(
    (client, request) => client.post(`/backups/${request.backupId}/restore`, { acknowledge: true }),
    { onSuccess: (result) => {
      setOperationMessage(`${result.backup.backupId} restored. Integrity checks ${result.integrity.passed ? 'passed' : 'found issues'}.`)
      void backups.refetch()
      void integrity.refetch()
    } }
  )

  if (backups.error) {
    return <LoadError message={backups.error.message} onRetry={() => void backups.refetch()} />
  }

  const backupColumns: Array<Column<BackupRecord>> = [
    {
      key: 'backup',
      header: 'Backup',
      render: (row) => (
        <div>
          <div className="text-bold mono">{row.backupId}</div>
          <div className="text-xs text-muted">{row.fileName}</div>
        </div>
      )
    },
    { key: 'status', header: 'Status', render: (row) => <Badge status={row.status} /> },
    { key: 'created', header: 'Created', render: (row) => <>{formatDateTime(row.createdAt)}<div className="text-xs text-muted">{row.createdByName ?? 'System'}</div></> },
    {
      key: 'file',
      header: 'Archive',
      render: (row) => (
        <div>
          <div>{row.filePresent ? `${formatNumber(row.fileSizeBytes)} bytes` : 'File missing'}</div>
          <div className="text-xs text-muted">Attachments {row.includesAttachments ? (row.attachmentsPresent ? 'included' : 'copy missing') : 'excluded'}</div>
        </div>
      )
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) => (
        <div className="row">
          <button
            type="button"
            className="btn btn--sm"
            disabled={verify.isPending || !row.filePresent}
            onClick={() => {
              setOperationMessage(null)
              verify.mutate({ backupId: row.backupId })
            }}
          >
            Verify
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={restore.isPending || row.status !== 'VERIFIED' || !row.filePresent}
            onClick={() => void restoreBackup(row.backupId)}
          >
            Restore
          </button>
        </div>
      )
    }
  ]

  const integrityColumns: Array<Column<IntegrityCheck>> = [
    { key: 'check', header: 'Check', render: (row) => <div><div className="text-bold">{humanizeToken(row.name)}</div><div className="text-xs text-muted">{row.description}</div></div> },
    { key: 'result', header: 'Result', render: (row) => <Badge status={row.passed ? 'PASSED' : row.severity === 'ERROR' ? 'FAILED' : 'WARNING'} /> },
    { key: 'violations', header: 'Violations', align: 'right', render: (row) => formatNumber(row.violations) },
    { key: 'samples', header: 'Samples', render: (row) => row.samples.length > 0 ? row.samples.join(', ') : '—' }
  ]

  const restoreBackup = async (backupId: string) => {
    const confirmed = await confirmAction({
      message: `Restore ${backupId}?`,
      detail: 'This replaces the current database with the verified backup and will sign out other users. This action cannot be undone.',
      confirmLabel: 'Restore backup',
      danger: true
    })
    if (confirmed) {
      setOperationMessage(null)
      restore.mutate({ backupId })
    }
  }

  return (
    <>
      <PageHeader title="Backup & Restore" subtitle="Create, verify and restore database backups" />
      <div className="stack">
        {operationMessage ? <Banner tone="success" title="Backup operation complete">{operationMessage}</Banner> : null}
        {create.error ? <Banner tone="error" title="Backup failed">{create.error.message}</Banner> : null}
        {verify.error ? <Banner tone="error" title="Verification failed">{verify.error.message}</Banner> : null}
        {restore.error ? <Banner tone="error" title="Restore failed">{restore.error.message}</Banner> : null}

        <Panel title="Create backup" subtitle="A new archive must pass verification before it can be restored.">
          <div className="stack stack--sm">
            <label className="checkbox-row">
              <input type="checkbox" checked={includesAttachments} onChange={(event) => setIncludesAttachments(event.target.checked)} />
              <span>Include attachments</span>
            </label>
            <Field label="Notes">
              <input className="input" maxLength={300} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional reason or context" />
            </Field>
            <div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={create.isPending}
                onClick={() => create.mutate({ includesAttachments, notes: notes.trim() || undefined })}
              >
                {create.isPending ? 'Creating…' : 'Create backup'}
              </button>
            </div>
          </div>
        </Panel>

        <Panel flush title="Backup register">
          <DataTable
            columns={backupColumns}
            rows={backups.data?.items ?? []}
            rowKey={(row) => row.id}
            loading={backups.isPending}
            empty={<EmptyState title="No backups yet" hint="Create a backup to start the register." />}
          />
        </Panel>

        <Panel flush title="Database integrity" subtitle={integrity.data ? `Checked ${formatDateTime(integrity.data.checkedAt)} · ${integrity.data.failed} of ${integrity.data.total} checks failed` : 'Checking database consistency'}>
          {integrity.error ? (
            <Banner tone="error" title="Integrity checks unavailable">{integrity.error.message}</Banner>
          ) : (
            <DataTable
              columns={integrityColumns}
              rows={integrity.data?.checks ?? []}
              rowKey={(row) => row.name}
              loading={integrity.isPending}
              empty={<EmptyState title="No integrity checks returned" />}
            />
          )}
        </Panel>
      </div>
    </>
  )
}