/**
 * Export controls shared by every screen.
 *
 * Two flavours sit next to the Print button so an operator can print a screen
 * or take it away as a file:
 *
 *  - `ViewExportMenu` saves whatever is on screen to a PDF file.
 *  - `ReportExportMenu` writes CSV/XLSX/PDF through a report endpoint, for the
 *    screens the API can render as a report. It disappears when the operator
 *    lacks `report.export`, matching the server's own check.
 */

import { useAuth } from '../lib/auth'
import { useReportExport, useViewExport } from '../lib/desktop'
import { ExportMenu } from './ui'
import type { ExportFormat } from './ui'

export function ViewExportMenu({
  suggestedName,
  label
}: {
  suggestedName: string
  label?: string
}): React.JSX.Element {
  const { exportView } = useViewExport()
  return <ExportMenu label={label} formats={['pdf']} onExport={() => exportView(suggestedName)} />
}

export function ReportExportMenu({
  path,
  query = {},
  suggestedName,
  formats = ['pdf', 'csv', 'xlsx'],
  label = 'Export'
}: {
  path: string
  query?: Record<string, string | number | undefined>
  suggestedName: string
  formats?: ExportFormat[]
  label?: string
}): React.JSX.Element | null {
  const { can } = useAuth()
  const { exportReport } = useReportExport()

  if (!can('report.export')) {
    return null
  }

  return (
    <ExportMenu
      label={label}
      formats={formats}
      onExport={(format) => exportReport(path, query, format, suggestedName)}
    />
  )
}
