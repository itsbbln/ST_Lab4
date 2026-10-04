/**
 * Shown when a route does not exist, or when the signed-in operator is not
 * entitled to the screen they asked for. Both cases render identically so the
 * navigation surface cannot be probed by an operator without the permission.
 */

import { useNavigate, usePath } from '../lib/router'

export function NotFoundScreen(): React.JSX.Element {
  const navigate = useNavigate()
  const path = usePath()

  return (
    <div className="panel">
      <div className="panel__body">
        <h1>Screen unavailable</h1>
        <p className="text-muted" style={{ marginTop: 8, maxWidth: '52ch' }}>
          There is no screen at <span className="mono">{path}</span>, or your account does not have access to
          it. If you believe this is a mistake, ask an administrator to review the roles assigned to your user.
        </p>
        <div style={{ marginTop: 'var(--space-4)' }}>
          <button type="button" className="btn btn--primary" onClick={() => navigate('/')}>
            Back to the dashboard
          </button>
        </div>
      </div>
    </div>
  )
}
