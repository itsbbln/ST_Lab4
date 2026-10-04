import { useEffect, useState } from 'react'
import { roleCodes, roleDescriptions } from '@bcis/shared'
import type { RoleCode } from '@bcis/shared'

import { Badge, Banner, DataTable, EmptyState, Field, LoadError, Modal, PageHeader, Panel } from '../components/ui'
import type { Column } from '../components/ui'
import { formatDateTime } from '../lib/format'
import { useApiMutation, useApiQuery } from '../lib/query'

interface UserRow {
  id: string
  username: string
  displayName: string
  email: string | null
  isActive: boolean
  isLocked: boolean
  lockedUntil: string | null
  lastLoginAt: string | null
  createdAt: string
  roleCodes: RoleCode[]
}

interface UsersResponse {
  items: UserRow[]
}

interface RoleMatrixRow {
  roleCode: RoleCode
  roleName: string
  permissions: string[]
}

interface RoleMatrixResponse {
  items: RoleMatrixRow[]
}

interface CreateUserInput {
  username: string
  displayName: string
  email?: string
  password: string
  roleCodes: RoleCode[]
  isActive: boolean
}

export function UsersScreen(): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newRoles, setNewRoles] = useState<RoleCode[]>(['READONLY_VIEWER'])
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleCode[]>>({})
  const [message, setMessage] = useState<string | null>(null)

  const users = useApiQuery<UsersResponse>(['users'], (client) => client.get<UsersResponse>('/users'))
  const roleMatrix = useApiQuery<RoleMatrixResponse>(['user-role-matrix'], (client) =>
    client.get<RoleMatrixResponse>('/users/role-matrix')
  )

  useEffect(() => {
    if (users.data) {
      setRoleDrafts(Object.fromEntries(users.data.items.map((user) => [user.id, [...user.roleCodes]])))
    }
  }, [users.data])

  const refreshUsers = () => void users.refetch()
  const createUser = useApiMutation<CreateUserInput, { id: string; username: string }>(
    (client, input) => client.post('/users', input),
    { onSuccess: (result) => {
      setMessage(`Account ${result.username} created.`)
      setCreating(false)
      setUsername('')
      setDisplayName('')
      setEmail('')
      setPassword('')
      setNewRoles(['READONLY_VIEWER'])
      refreshUsers()
    } }
  )
  const updateRoles = useApiMutation<{ id: string; roleCodes: RoleCode[] }, { ok: boolean }>(
    (client, request) => client.put(`/users/${request.id}/roles`, { roleCodes: request.roleCodes }),
    { onSuccess: () => {
      setMessage('Roles updated. The user must sign in again for the changes to apply.')
      refreshUsers()
    } }
  )
  const revokeSessions = useApiMutation<{ id: string }, { ok: boolean }>(
    (client, request) => client.delete(`/users/${request.id}/sessions`),
    { onSuccess: () => setMessage('All sessions for that account have been revoked.') }
  )

  if (users.error) {
    return <LoadError message={users.error.message} onRetry={refreshUsers} />
  }

  const columns: Array<Column<UserRow>> = [
    {
      key: 'operator',
      header: 'Operator',
      render: (user) => (
        <div>
          <div className="text-bold">{user.displayName}</div>
          <div className="text-xs text-muted">{user.username}{user.email ? ` · ${user.email}` : ''}</div>
        </div>
      )
    },
    {
      key: 'status',
      header: 'Status',
      render: (user) => <Badge status={!user.isActive ? 'INACTIVE' : user.isLocked ? 'LOCKED' : 'ACTIVE'} />
    },
    { key: 'lastLogin', header: 'Last sign-in', render: (user) => formatDateTime(user.lastLoginAt) },
    {
      key: 'roles',
      header: 'Roles',
      render: (user) => (
        <div className="stack stack--sm">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {(roleDrafts[user.id] ?? []).map((code) => <Badge key={code} status={code} label={roleMatrix.data?.items.find((role) => role.roleCode === code)?.roleName ?? code} />)}
          </div>
          <details>
            <summary>Manage roles</summary>
            <div className="stack stack--sm" style={{ marginTop: 'var(--space-2)' }}>
              {roleCodes.map((code) => (
                <label key={code} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={(roleDrafts[user.id] ?? []).includes(code)}
                    onChange={(event) => setRoleDrafts((current) => {
                      const selected = current[user.id] ?? []
                      const next = event.target.checked ? [...selected, code] : selected.filter((item) => item !== code)
                      return { ...current, [user.id]: next }
                    })}
                  />
                  <span>{roleMatrix.data?.items.find((role) => role.roleCode === code)?.roleName ?? code}</span>
                </label>
              ))}
              <button
                type="button"
                className="btn btn--sm"
                disabled={updateRoles.isPending || !(roleDrafts[user.id]?.length)}
                onClick={() => updateRoles.mutate({ id: user.id, roleCodes: roleDrafts[user.id] ?? [] })}
              >
                Save roles
              </button>
            </div>
          </details>
        </div>
      )
    },
    {
      key: 'sessions',
      header: 'Sessions',
      render: (user) => (
        <button
          type="button"
          className="btn btn--sm btn--danger"
          disabled={revokeSessions.isPending}
          onClick={() => revokeSessions.mutate({ id: user.id })}
        >
          Revoke all
        </button>
      )
    }
  ]

  const toggleNewRole = (code: RoleCode, checked: boolean) => {
    setNewRoles((current) => checked ? [...current, code] : current.filter((item) => item !== code))
  }

  const submitNewUser = (event: React.FormEvent) => {
    event.preventDefault()
    createUser.mutate({
      username: username.trim(),
      displayName: displayName.trim(),
      email: email.trim() || undefined,
      password,
      roleCodes: newRoles,
      isActive: true
    })
  }

  return (
    <>
      <PageHeader
        title="Users & Roles"
        subtitle="Create operator accounts, assign permissions through roles, and revoke sessions"
        actions={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>Add user</button>}
      />
      <div className="stack">
        {message ? <Banner tone="success" title="User administration">{message}</Banner> : null}
        {createUser.error ? <Banner tone="error" title="Could not create user">{createUser.error.message}</Banner> : null}
        {updateRoles.error ? <Banner tone="error" title="Could not update roles">{updateRoles.error.message}</Banner> : null}
        {revokeSessions.error ? <Banner tone="error" title="Could not revoke sessions">{revokeSessions.error.message}</Banner> : null}

        <Panel flush title="Operator accounts">
          <DataTable
            columns={columns}
            rows={users.data?.items ?? []}
            rowKey={(user) => user.id}
            loading={users.isPending}
            empty={<EmptyState title="No operator accounts" />}
          />
        </Panel>

        <Panel flush title="Role permissions" subtitle="Permissions are inherited from the selected role; they are enforced by the API.">
          <DataTable
            columns={[
              { key: 'role', header: 'Role', render: (role) => <div><div className="text-bold">{role.roleName}</div><div className="text-xs text-muted">{role.roleCode}</div><div className="text-sm text-muted">{roleDescriptions[role.roleCode]}</div></div> },
              { key: 'permissions', header: 'Permissions', render: (role) => role.permissions.join(', ') || '—' }
            ]}
            rows={roleMatrix.data?.items ?? []}
            rowKey={(role) => role.roleCode}
            loading={roleMatrix.isPending}
            empty={<EmptyState title="No roles returned" />}
          />
        </Panel>
      </div>

      {creating ? (
        <Modal
          title="Create operator account"
          subtitle="Assign at least one role. Share the new credentials through an approved secure channel."
          onClose={() => setCreating(false)}
          footer={
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" form="create-user-form" className="btn btn--primary" disabled={createUser.isPending || newRoles.length === 0}>
                {createUser.isPending ? 'Creating…' : 'Create user'}
              </button>
            </div>
          }
        >
          <form id="create-user-form" className="stack" onSubmit={submitNewUser}>
            <Field label="Username" required><input className="input" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={60} required /></Field>
            <Field label="Display name" required><input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={3} maxLength={120} required /></Field>
            <Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={160} /></Field>
            <Field label="Initial password" required hint="At least 8 characters."><input className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={200} required /></Field>
            <fieldset className="stack stack--sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field__label">Roles</legend>
              {roleCodes.map((code) => (
                <label key={code} className="checkbox-row">
                  <input type="checkbox" checked={newRoles.includes(code)} onChange={(event) => toggleNewRole(code, event.target.checked)} />
                  <span><strong>{roleMatrix.data?.items.find((role) => role.roleCode === code)?.roleName ?? code}</strong><span className="text-sm text-muted"> — {roleDescriptions[code]}</span></span>
                </label>
              ))}
            </fieldset>
          </form>
        </Modal>
      ) : null}
    </>
  )
}