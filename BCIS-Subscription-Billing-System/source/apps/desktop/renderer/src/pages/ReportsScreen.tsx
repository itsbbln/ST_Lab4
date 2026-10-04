import { PageHeader, Panel } from '../components/ui'
import { useNavigate } from '../lib/router'

interface ReportDestination {
  title: string
  description: string
  path: string
}

const REPORTS: ReportDestination[] = [
  { title: 'Billing cycles', description: 'Review generated billing periods and invoice totals.', path: '/billing' },
  { title: 'Payments register', description: 'Search receipts, posted payments and reversals.', path: '/payments' },
  { title: 'Accounts receivable', description: 'Review outstanding balances and aging.', path: '/receivables' },
  { title: 'Collector performance', description: 'Compare expected collections, remittances and variances.', path: '/performance' }
]

export function ReportsScreen(): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <>
      <PageHeader title="Reports" subtitle="Operational summaries and registers" />
      <Panel flush title="Available reports">
        <div className="stack">
          {REPORTS.map((report) => (
            <div key={report.path} className="row" style={{ justifyContent: 'space-between', gap: 'var(--space-4)' }}>
              <div>
                <div className="text-bold">{report.title}</div>
                <div className="text-sm text-muted">{report.description}</div>
              </div>
              <button type="button" className="btn btn--sm" onClick={() => navigate(report.path)}>
                Open
              </button>
            </div>
          ))}
        </div>
      </Panel>
    </>
  )
}