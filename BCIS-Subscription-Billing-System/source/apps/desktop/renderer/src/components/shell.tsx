/**
 * The application shell: sidebar navigation, top bar and the print hook.
 *
 * The navigation tree mirrors the laboratory's required menu, and each entry
 * declares the permission needed to see it. That only controls what is
 * *offered*; the API independently refuses any operation the operator is not
 * entitled to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import { useNavigate, usePath } from '../lib/router'
import { exportCurrentView, printCurrent, showMessage } from '../lib/desktop'
import { humanizeToken } from '../lib/format'
import type { BcisMenuAction } from '../types/bridge'
import './shell.css'

export interface NavEntry {
  path: string
  label: string
  icon: string
  permission: string
  /** Shown under this group in the sidebar. */
  group: string
}

export const NAV_ENTRIES: NavEntry[] = [
  { path: '/', label: 'Dashboard', icon: '▤', permission: 'dashboard.view', group: 'Overview' },

  { path: '/subscribers', label: 'Subscribers', icon: '☰', permission: 'subscriber.view', group: 'Subscribers' },
  { path: '/service-accounts', label: 'Service Accounts', icon: '⚙', permission: 'service.view', group: 'Subscribers' },
  { path: '/plans', label: 'Service Plans', icon: '◈', permission: 'subscriber.view', group: 'Subscribers' },

  { path: '/billing', label: 'Billing Cycles', icon: '▦', permission: 'billing.view', group: 'Billing & Payments' },
  { path: '/invoices', label: 'Invoices', icon: '▧', permission: 'billing.view', group: 'Billing & Payments' },
  { path: '/payments', label: 'Payments', icon: '◉', permission: 'payment.view', group: 'Billing & Payments' },
  { path: '/receive-payment', label: 'Receive Payment', icon: '＋', permission: 'payment.create', group: 'Billing & Payments' },
  { path: '/gcash', label: 'GCash Verification', icon: '✓', permission: 'gcash.verify', group: 'Billing & Payments' },

  { path: '/collections', label: 'Collection Batches', icon: '⛬', permission: 'collection.view', group: 'Collections' },
  { path: '/remittances', label: 'Remittances', icon: '⇄', permission: 'collection.view', group: 'Collections' },
  { path: '/collection-setup', label: 'Areas, Routes & Collectors', icon: '⌘', permission: 'collection.view', group: 'Collections' },
  { path: '/performance', label: 'Collector Performance', icon: '▲', permission: 'report.view', group: 'Collections' },

  { path: '/receivables', label: 'Accounts Receivable', icon: '⧗', permission: 'receivables.view', group: 'Receivables' },
  { path: '/suspensions', label: 'Suspensions', icon: '⊘', permission: 'receivables.view', group: 'Receivables' },
  { path: '/reconnections', label: 'Reconnections', icon: '↺', permission: 'receivables.view', group: 'Receivables' },

  { path: '/reports', label: 'Reports', icon: '▥', permission: 'report.view', group: 'Reports & Administration' },
  { path: '/backups', label: 'Backup & Restore', icon: '⛁', permission: 'backup.restore', group: 'Reports & Administration' },
  { path: '/users', label: 'Users & Roles', icon: '☖', permission: 'user.manage', group: 'Reports & Administration' },
  { path: '/audit', label: 'Audit Trail', icon: '☰', permission: 'audit.view', group: 'Reports & Administration' },
  { path: '/settings', label: 'Settings', icon: '⚒', permission: 'dashboard.view', group: 'Reports & Administration' }
]

const GROUP_ORDER = [
  'Overview',
  'Subscribers',
  'Billing & Payments',
  'Collections',
  'Receivables',
  'Reports & Administration'
]

export function AppShell({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, logout, can } = useAuth()
  const { config, apiStatus, lanUrls } = useConfig()
  const navigate = useNavigate()
  const path = usePath()
  const [collapsed, setCollapsed] = useState(false)

  const entries = useMemo(
    () => NAV_ENTRIES.filter((entry) => can(entry.permission)),
    [can]
  )

  const groups = useMemo(() => {
    const visible = new Set(entries.map((entry) => entry.group))
    return GROUP_ORDER.filter((group) => visible.has(group)).map((group) => ({
      group,
      items: entries.filter((entry) => entry.group === group)
    }))
  }, [entries])

  const isActive = (entry: NavEntry) =>
    entry.path === '/' ? path === '/' : path === entry.path || path.startsWith(`${entry.path}/`)

  /**
   * The name a view export should suggest in the save dialog, e.g.
   * `bcis-collector-performance.pdf`. Derived from the active screen so every
   * export leaves a file that says which screen it came from.
   */
  const exportName = useMemo(() => {
    const active = entries.find((entry) => isActive(entry))
    const slug = (active?.label ?? 'view')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return `bcis-${slug || 'view'}.pdf`
    // `path` and `entries` cover every input `isActive` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, path])

  /**
   * The main process calls this immediately before printing. Collapsing the
   * navigation keeps a route sheet or statement of account on the page by
   * itself, which the specification requires. `__bcisAfterPrint` undoes it for
   * PDF export, which fires no `afterprint` event of its own.
   */
  useEffect(() => {
    const restore = () => document.body.classList.remove('printing')
    window.__bcisBeforePrint = () => {
      document.body.classList.add('printing')
    }
    window.__bcisAfterPrint = restore
    window.addEventListener('afterprint', restore)
    return () => {
      restore()
      delete window.__bcisBeforePrint
      delete window.__bcisAfterPrint
    }
  }, [])

  const handleMenuAction = useCallback(
    (action: BcisMenuAction) => {
      if (action === 'print' || action === 'print-page') {
        void printCurrent('page')
        return
      }
      if (action === 'export') {
        void exportCurrentView(exportName)
        return
      }
      if (action === 'settings') {
        navigate('/settings')
        return
      }
      if (action.startsWith('navigate:')) {
        const target = action.slice('navigate:'.length)
        navigate(target === 'dashboard' ? '/' : `/${target}`)
      }
    },
    [navigate, exportName]
  )

  useEffect(() => {
    if (typeof window.bcis?.on !== 'function') {
      return
    }
    return window.bcis.on('bcis:menu-action', handleMenuAction)
  }, [handleMenuAction])

  return (
    <div className={`app-shell${collapsed ? ' app-shell--collapsed' : ''}`}>
      <nav className="app-sidebar" aria-label="Main navigation">
        <div className="sidebar__brand">
          <span className="sidebar__mark">BCIS</span>
          {!collapsed ? <span className="sidebar__tagline">Billing &amp; Collection</span> : null}
        </div>

        <div className="sidebar__nav">
          {groups.map(({ group, items }) => (
            <div key={group} className="sidebar__group">
              {!collapsed ? <div className="sidebar__group-label">{group}</div> : null}
              {items.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`sidebar__item${isActive(entry) ? ' sidebar__item--active' : ''}`}
                  onClick={() => navigate(entry.path)}
                  title={collapsed ? entry.label : undefined}
                  aria-current={isActive(entry) ? 'page' : undefined}
                >
                  <span className="sidebar__icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                  {!collapsed ? <span>{entry.label}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar__footer">
          {!collapsed ? (
            <div className="sidebar__server" title={config.apiBase}>
              <span className={`dot dot--${apiStatus === 'exited' ? 'danger' : 'ok'}`} />
              <div>
                <div className="sidebar__server-label">Server</div>
                <div className="sidebar__server-value">{config.apiBase.replace(/^https?:\/\//, '')}</div>
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className="sidebar__collapse"
            onClick={() => setCollapsed((current) => !current)}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
      </nav>

      <div className="app-body">
        <header className="app-topbar">
          <div className="topbar__left">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                navigate('/')
              }}
            >
              Dashboard
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void printCurrent('page')}
              title="Print this screen without the navigation"
            >
              Print
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                void exportCurrentView(exportName).then((saved) => {
                  if (saved) {
                    void showMessage({ type: 'info', message: 'Saved to file', detail: saved })
                  }
                })
              }}
              title="Export this screen to a PDF file"
            >
              Export
            </button>
            {config.launchApiLocally ? (
              <span className="badge badge--info" title={`Listening on port ${config.apiPort}`}>
                Hosting the API
              </span>
            ) : null}
          </div>

          <div className="topbar__right">
            {lanUrls.length > 1 ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() =>
                  void showMessage({
                    type: 'info',
                    message: 'Server addresses on this machine',
                    detail: `Configure the two client PCs to use one of:\n\n${lanUrls
                      .filter((url) => !url.includes('127.0.0.1') && !url.includes('localhost'))
                      .join('\n')}`
                  })
                }
                title="Show the address the client PCs should use"
              >
                LAN addresses
              </button>
            ) : null}

            <div className="user-chip">
              <div className="user-chip__meta">
                <strong>{user?.displayName}</strong>
                {/*
                  Roles are a list and `/auth/me` does not return them, so this
                  falls back to the account name rather than rendering an empty
                  chip after a reload restored the session.
                */}
                <span>
                  {user?.roles?.length
                    ? user.roles.map((role) => humanizeToken(role)).join(', ')
                    : user?.username}
                </span>
              </div>
              <button type="button" className="btn btn--sm" onClick={() => logout('manual')}>
                Sign out
              </button>
            </div>
          </div>
        </header>

        <main className="app-main">
          <div className="printable">{children}</div>
        </main>
      </div>
    </div>
  )
}
