/**
 * Collector performance.
 *
 * This is the accountability report: per collector, how much they were expected
 * to take, how much came back, and whether the cash in their hand matched the
 * money they declared.
 *
 * Two columns deserve the reader's attention before any others. `collectionRate`
 * is the API's rounded whole percent, never recomputed here. A shortage is not a
 * performance failure on its own — it is often a house that genuinely could not
 * pay — but a *repeated* shortage on a large total is the thing to investigate,
 * so both are shown and neither is styled as good or bad on its own.
 */

import { useState } from 'react'

import { displayMoney } from '../lib/api'
import { describeError, printCurrent } from '../lib/desktop'
import { formatDate, formatNumber } from '../lib/format'
import { useApiQuery } from '../lib/query'
import { useNavigate } from '../lib/router'
import {
  Banner,
  DataTable,
  EmptyState,
  LoadError,
  PageHeader,
  Panel,
  StatTile
} from '../components/ui'
import type { Column } from '../components/ui'
import type { CollectorPerformanceRow, ItemsResponse } from '../types/api'

type SortKey = 'collectorName' | 'collectionRate' | 'shortageCentavos' | 'uncollectedCentavos' | 'totalCollectedCentavos'

export function PerformanceScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({
    key: 'shortageCentavos',
    direction: 'desc'
  })

  const performance = useApiQuery<ItemsResponse<CollectorPerformanceRow>>(
    ['collection', 'performance'],
    (client) => client.get<ItemsResponse<CollectorPerformanceRow>>('/collection/performance')
  )

  if (performance.error || !performance.data) {
    return <LoadError message={describeError(performance.error)} onRetry={() => void performance.refetch()} />
  }

  const rows = performance.data.items
  const expected = rows.reduce((sum, row) => sum + row.expectedReceivableCentavos, 0)
  const collected = rows.reduce((sum, row) => sum + row.totalCollectedCentavos, 0)
  const shortage = rows.reduce((sum, row) => sum + row.shortageCentavos, 0)
  const overage = rows.reduce((sum, row) => sum + row.overageCentavos, 0)
  const uncollected = rows.reduce((sum, row) => sum + row.uncollectedCentavos, 0)

  const sorted = [...rows].sort((left, right) => {
    const a = left[sort.key]
    const b = right[sort.key]
    const result =
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    return sort.direction === 'asc' ? result : -result
  })

  const onSort = (key: string): void => {
    setSort((current) =>
      current.key === key
        ? { key: current.key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: key as SortKey, direction: 'desc' }
    )
  }

  const columns: Array<Column<CollectorPerformanceRow>> = [
    {
      key: 'collectorName',
      header: 'Collector',
      sortable: true,
      sortValue: (row) => row.collectorName,
      render: (row) => <span className="text-bold">{row.collectorName}</span>
    },
    {
      key: 'batchCount',
      header: 'Batches',
      align: 'right',
      sortValue: (row) => row.batchCount,
      render: (row) => formatNumber(row.batchCount)
    },
    {
      key: 'expectedReceivableCentavos',
      header: 'Expected',
      money: true,
      sortable: true,
      sortValue: (row) => row.expectedReceivableCentavos,
      render: (row) => (
        <span className="money">{displayMoney({ expectedReceivableCentavos: row.expectedReceivableCentavos }, 'expected')}</span>
      )
    },
    {
      key: 'totalCollectedCentavos',
      header: 'Collected',
      money: true,
      sortable: true,
      sortValue: (row) => row.totalCollectedCentavos,
      render: (row) => (
        <span className="money">{displayMoney({ totalCollectedCentavos: row.totalCollectedCentavos }, 'collected')}</span>
      )
    },
    {
      key: 'uncollectedCentavos',
      header: 'Uncollected',
      money: true,
      sortable: true,
      sortValue: (row) => row.uncollectedCentavos,
      render: (row) =>
        row.uncollectedCentavos > 0 ? (
          <span className="money text-warning">
            {displayMoney({ uncollectedCentavos: row.uncollectedCentavos }, 'uncollected')}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    {
      key: 'collectionRate',
      header: 'Collected',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.collectionRate,
      render: (row) => (
        <span className={rateTone(row.collectionRate)}>{row.collectionRate}%</span>
      )
    },
    {
      key: 'shortageCentavos',
      header: 'Shortage',
      money: true,
      sortable: true,
      sortValue: (row) => row.shortageCentavos,
      render: (row) =>
        row.shortageCentavos > 0 ? (
          <span className="money text-danger text-bold">
            {displayMoney({ shortageCentavos: row.shortageCentavos }, 'shortage')}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    {
      key: 'overageCentavos',
      header: 'Overage',
      money: true,
      sortable: true,
      sortValue: (row) => row.overageCentavos,
      render: (row) =>
        row.overageCentavos > 0 ? (
          <span className="money text-warning">
            {displayMoney({ overageCentavos: row.overageCentavos }, 'overage')}
          </span>
        ) : (
          <span className="text-subtle">—</span>
        )
    }
  ]

  return (
    <>
      <PageHeader
        title="Collector performance"
        subtitle="What each collector was expected to take, and what actually came back"
        actions={
          <button type="button" className="btn" onClick={() => void printCurrent('page')}>
            Print
          </button>
        }
      />

      <div className="stack">
        {shortage > 0 ? (
          <Banner tone="warning" title={`${displayMoney({ shortageCentavos: shortage }, 'shortage')} unaccounted for across all collectors`}>
            A shortage means the cash in the collector's hand was less than the money they declared. Check the
            remittance remarks on the batch before treating it as a loss.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <StatTile label="Collectors with batches" value={formatNumber(rows.length)} />
          <StatTile
            label="Expected"
            value={displayMoney({ expectedReceivableCentavos: expected }, 'expected')}
            tone="info"
          />
          <StatTile
            label="Collected"
            value={displayMoney({ totalCollectedCentavos: collected }, 'collected')}
            hint={expected > 0 ? `${Math.round((collected / expected) * 100)}% of expected` : undefined}
            tone="success"
          />
          <StatTile
            label="Uncollected"
            value={displayMoney({ uncollectedCentavos: uncollected }, 'uncollected')}
            tone={uncollected > 0 ? 'warning' : 'success'}
          />
          <StatTile
            label="Shortage"
            value={displayMoney({ shortageCentavos: shortage }, 'shortage')}
            tone={shortage > 0 ? 'danger' : 'success'}
          />
          <StatTile
            label="Overage"
            value={displayMoney({ overageCentavos: overage }, 'overage')}
            tone={overage > 0 ? 'warning' : 'success'}
            hint="More cash handed in than declared"
          />
        </div>

        <Panel flush title="Per collector" subtitle="Sorted by shortage by default, so the money question is asked first">
          <DataTable
            columns={columns}
            rows={sorted}
            rowKey={(row) => row.collectorId}
            loading={performance.isPending}
            onRowClick={(row) => navigate(`/collections?collectorId=${row.collectorId}`)}
            sort={sort}
            onSort={onSort}
            empty={
              <EmptyState
                title="No collector has opened a batch"
                hint="Performance appears once collection activity has been recorded."
              />
            }
            footer={
              sorted.length > 0 ? (
                <tr className="total-row">
                  <td>All collectors</td>
                  <td className="money text-bold">{formatNumber(rows.reduce((sum, row) => sum + row.batchCount, 0))}</td>
                  <td className="money text-bold">
                    {displayMoney({ expectedReceivableCentavos: expected }, 'expected')}
                  </td>
                  <td className="money text-bold">
                    {displayMoney({ totalCollectedCentavos: collected }, 'collected')}
                  </td>
                  <td className="money text-bold">
                    {displayMoney({ uncollectedCentavos: uncollected }, 'uncollected')}
                  </td>
                  <td className="text-bold">{expected > 0 ? `${Math.round((collected / expected) * 100)}%` : '—'}</td>
                  <td className="money text-bold">
                    {displayMoney({ shortageCentavos: shortage }, 'shortage')}
                  </td>
                  <td className="money text-bold">
                    {displayMoney({ overageCentavos: overage }, 'overage')}
                  </td>
                </tr>
              ) : undefined
            }
          />
        </Panel>

        <p className="text-xs text-subtle">
          Percentages are the values the API calculated and rounded; this screen does not recompute them. Figures
          reflect every batch currently recorded in the system, generated as of {formatDate(new Date().toISOString())}.
        </p>
      </div>
    </>
  )
}

/** Bands, not judgements: a rate is a fact about the accounts, not about the person. */
function rateTone(rate: number): string {
  if (rate >= 90) {
    return 'text-success text-bold'
  }
  if (rate >= 70) {
    return 'text-warning'
  }
  return 'text-danger text-bold'
}
