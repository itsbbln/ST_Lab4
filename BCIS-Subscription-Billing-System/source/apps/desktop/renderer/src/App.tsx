/**
 * Application root and the screen route table.
 *
 * Responsibilities, in order: wait for the persisted server configuration,
 * restore the session, resolve the current hash route, and show the login
 * screen when there is no valid session.
 *
 * The whole navigation surface is declared in `ROUTES` so it can be read in one
 * place. Each entry names the permission needed to open it; a route the operator
 * is not entitled to is treated as "not found" rather than rendering an empty
 * screen with a permission error, which reads as a bug to a user.
 */

import type { ReactNode } from 'react'

import { AppShell } from './components/shell'
import { Loading } from './components/ui'
import { AuthProvider, useAuth } from './lib/auth'
import { ConfigProvider, useConfig } from './lib/config'
import { AppQueryProvider } from './lib/query'
import { matchPath, RouterProvider, useRouter } from './lib/router'
import { BillingScreen } from './pages/BillingScreen'
import { CollectionSetupScreen } from './pages/CollectionSetupScreen'
import { CollectionsScreen } from './pages/CollectionsScreen'
import { DashboardScreen } from './pages/DashboardScreen'
import { GcashScreen } from './pages/GcashScreen'
import { InvoicesScreen } from './pages/InvoicesScreen'
import { LoginScreen } from './pages/LoginScreen'
import { NotFoundScreen } from './pages/NotFoundScreen'
import { PaymentsScreen } from './pages/PaymentsScreen'
import { PerformanceScreen } from './pages/PerformanceScreen'
import { PlansScreen } from './pages/PlansScreen'
import { ReportsScreen } from './pages/ReportsScreen'
import { AuditScreen } from './pages/AuditScreen'
import { BackupsScreen } from './pages/BackupsScreen'
import { ReceivablesScreen } from './pages/ReceivablesScreen'
import { SettingsScreen } from './pages/SettingsScreen'
import { ServiceAccountsScreen } from './pages/ServiceAccountsScreen'
import { ServiceControlScreen } from './pages/ServiceControlScreen'
import { SubscribersScreen } from './pages/SubscribersScreen'
import { UsersScreen } from './pages/UsersScreen'
import './App.css'

interface RouteDefinition {
  /** Segments of the path; `:name` captures one segment. */
  pattern: string[]
  /** Permission required to open the screen. */
  permission: string
  /**
   * Matched path parameters, exposed because several screens take their target id
   * as a prop rather than reading the route themselves.
   */
  render: (params: Record<string, string>) => ReactNode
}

/**
 * Order matters only where one pattern is a prefix of another; the list patterns
 * are exact-length, so `['subscribers']` cannot swallow `/subscribers/:id`.
 */
const ROUTES: RouteDefinition[] = [
  { pattern: [], permission: 'dashboard.view', render: () => <DashboardScreen /> },
  { pattern: ['subscribers'], permission: 'subscriber.view', render: () => <SubscribersScreen /> },
  {
    pattern: ['subscribers', ':subscriberId'],
    permission: 'subscriber.view',
    render: (params) => <SubscribersScreen initialSubscriberId={params.subscriberId} />
  },
  { pattern: ['service-accounts'], permission: 'service.view', render: () => <ServiceAccountsScreen /> },
  {
    pattern: ['service-accounts', ':accountId'],
    permission: 'service.view',
    render: (params) => <ServiceAccountsScreen initialAccountId={params.accountId} />
  },
  { pattern: ['plans'], permission: 'subscriber.view', render: () => <PlansScreen /> },
  { pattern: ['billing'], permission: 'billing.view', render: () => <BillingScreen /> },
  { pattern: ['invoices'], permission: 'billing.view', render: () => <InvoicesScreen /> },
  { pattern: ['payments'], permission: 'payment.view', render: () => <PaymentsScreen /> },
  { pattern: ['receive-payment'], permission: 'payment.create', render: () => <PaymentsScreen initialShowReceive /> },
  { pattern: ['gcash'], permission: 'payment.view', render: () => <GcashScreen /> },
  { pattern: ['collections'], permission: 'collection.view', render: () => <CollectionsScreen /> },
  {
    pattern: ['remittances'],
    permission: 'collection.view',
    render: () => <CollectionsScreen initialTab="remittances" />
  },
  {
    pattern: ['collection-setup'],
    permission: 'collection.view',
    render: () => <CollectionSetupScreen />
  },
  { pattern: ['performance'], permission: 'report.view', render: () => <PerformanceScreen /> },
  { pattern: ['reports'], permission: 'report.view', render: () => <ReportsScreen /> },
  { pattern: ['audit'], permission: 'audit.view', render: () => <AuditScreen /> },
  { pattern: ['settings'], permission: 'dashboard.view', render: () => <SettingsScreen /> },
  { pattern: ['backups'], permission: 'backup.restore', render: () => <BackupsScreen /> },
  { pattern: ['users'], permission: 'user.manage', render: () => <UsersScreen /> },
  { pattern: ['receivables'], permission: 'receivables.view', render: () => <ReceivablesScreen /> },
  { pattern: ['suspensions'], permission: 'receivables.view', render: () => <ServiceControlScreen /> },
  {
    pattern: ['reconnections'],
    permission: 'receivables.view',
    render: () => <ServiceControlScreen initialTab="reconnections" />
  }
]

function Boot(): React.JSX.Element {
  const { ready } = useConfig()

  if (!ready) {
    return (
      <div className="boot-shell">
        <Loading label="Starting BCIS" />
      </div>
    )
  }

  return (
    <RouterProvider>
      <SessionGate />
    </RouterProvider>
  )
}

function SessionGate(): React.JSX.Element {
  const { user, initialising } = useAuth()

  if (initialising) {
    return (
      <div className="boot-shell">
        <Loading label="Restoring your session" />
      </div>
    )
  }

  if (!user) {
    return <LoginScreen />
  }

  return (
    <AppShell>
      <ScreenRouter />
    </AppShell>
  )
}

function ScreenRouter(): React.JSX.Element {
  const { segments } = useRouter()
  const { can } = useAuth()

  for (const route of ROUTES) {
    const params = matchPath(route.pattern, segments)
    if (params) {
      if (!can(route.permission)) {
        return <NotFoundScreen />
      }
      return <>{route.render(params)}</>
    }
  }

  return <NotFoundScreen />
}

export default function App(): React.JSX.Element {
  return (
    <ConfigProvider>
      <AppQueryProvider>
        <AuthProvider>
          <Boot />
        </AuthProvider>
      </AppQueryProvider>
    </ConfigProvider>
  )
}
