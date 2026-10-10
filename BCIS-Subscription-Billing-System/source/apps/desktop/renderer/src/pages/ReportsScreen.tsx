import { PageHeader, Panel } from '../components/ui'
import { ReportExportMenu } from '../components/export'
import { useNavigate } from '../lib/router'

interface ReportDestination {
  title: string
  description: string
  path: string
  exportPath?: string
  exportQuery?: Record<string, string | number | undefined>
  exportName?: string
}

const REPORTS: ReportDestination[] = [
  {
    title: 'Billing cycles',
    description: 'Review generated billing periods and invoice totals.',
    path: '/billing',
    exportPath: '/reports/billing-vs-collection',
    exportName: 'bcis-billing-vs-collection'
  },
  {
    title: 'Payments register',
    description: 'Search receipts, posted payments and reversals.',
    path: '/payments',
    exportPath: '/reports/payments',
    exportName: 'bcis-payments-register'
  },
  {
    title: 'Monthly collections',
    description: 'Amounts collected per period, broken down by payment method.',
    path: '/receivables',
    exportPath: '/reports/collections',
    exportName: 'bcis-collections'
  },
  {
    title: 'Accounts receivable',
    description: 'Review outstanding balances and aging.',
    path: '/receivables'
  },
  {
    title: 'Collector performance',
    description: 'Compare expected collections, remittances and variances.',
    path: '/performance',
    exportPath: '/reports/collector-performance',
    exportName: 'bcis-collector-performance'
  },
  {
    title: 'Revenue by plan',
    description: 'Billed revenue grouped by service plan.',
    path: '/performance',
    exportPath: '/reports/revenue',
    exportQuery: { by: 'plan' },
    exportName: 'bcis-revenue-by-plan'
  },
  {
    title: 'Revenue by area',
    description: 'Billed revenue grouped by collection area.',
    path: '/performance',
    exportPath: '/reports/revenue',
    exportQuery: { by: 'area' },
    exportName: 'bcis-revenue-by-area'
  },
  {
    title: 'Subscriber directory',
    description: 'Subscriber contacts, plans and account status.',
    path: '/subscribers',
    exportPath: '/reports/subscribers',
    exportName: 'bcis-subscribers'
  },
  {
    title: 'Adjustments and penalties',
    description: 'Credits, debits and penalties applied to accounts.',
    path: '/invoices',
    exportPath: '/reports/adjustments',
    exportName: 'bcis-adjustments'
  },
  {
    title: 'Audit trail',
    description: 'Append-only record of operator and system activity.',
    path: '/audit',
    exportPath: '/reports/audit',
    exportName: 'bcis-audit-trail'
  }
]

export function ReportsScreen(): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <>
      <PageHeader title="Reports" subtitle="Operational summaries and registers" />
      <Panel flush title="Available reports">
        <div className="stack">
          {REPORTS.map((report) => (
            <div
              key={report.title}
              className="row"
              style={{ justifyContent: 'space-between', gap: 'var(--space-4)' }}
            >
              <div>
                <div className="text-bold">{report.title}</div>
                <div className="text-sm text-muted">{report.description}</div>
              </div>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                {report.exportPath && report.exportName ? (
                  <ReportExportMenu
                    path={report.exportPath}
                    query={report.exportQuery}
                    suggestedName={report.exportName}
                    label="Export"
                  />
                ) : null}
                <button type="button" className="btn btn--sm" onClick={() => navigate(report.path)}>
                  Open
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  )
}
