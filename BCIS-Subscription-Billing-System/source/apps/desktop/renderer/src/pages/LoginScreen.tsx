/**
 * Sign-in screen.
 *
 * Also the place an operator fixes a wrong server address, because a client PC
 * that cannot reach the server has nowhere else to go. That is the single
 * configuration difference between the three machines in this deployment.
 */

import { useEffect, useState } from 'react'

import { Banner, Field } from '../components/ui'
import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import { describeError } from '../lib/desktop'

export function LoginScreen(): React.JSX.Element {
  const { login, signingIn, lastOperator } = useAuth()
  const { config, saveConfig, probe } = useConfig()

  const [username, setUsername] = useState(lastOperator)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showServer, setShowServer] = useState(false)
  const [serverDraft, setServerDraft] = useState(config.apiBase)
  const [serverProbe, setServerProbe] = useState<'idle' | 'checking' | 'ok' | 'failed'>('idle')
  const [serverMessage, setServerMessage] = useState('')

  useEffect(() => {
    setServerDraft(config.apiBase)
  }, [config.apiBase])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (username.trim() === '' || password === '') {
      setError('Enter both your username and your password.')
      return
    }

    try {
      const result = await login(username.trim(), password)
      if (!result.ok) {
        setError(result.message ?? 'Sign-in failed.')
        setPassword('')
      }
    } catch (thrown) {
      setError(describeError(thrown))
    }
  }

  const testServer = async () => {
    setServerProbe('checking')
    setServerMessage('')
    try {
      const result = await probe(serverDraft)
      if (result.ok) {
        setServerProbe('ok')
        setServerMessage('Reached the BCIS server.')
      } else {
        setServerProbe('failed')
        setServerMessage(result.error ?? 'No BCIS server answered at that address.')
      }
    } catch (thrown) {
      setServerProbe('failed')
      setServerMessage(describeError(thrown))
    }
  }

  const applyServer = async () => {
    try {
      await saveConfig({ apiBase: serverDraft })
      setShowServer(false)
      setServerProbe('idle')
      setServerMessage('')
    } catch (thrown) {
      setServerProbe('failed')
      setServerMessage(describeError(thrown))
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-card__brand">
          <span className="login-card__mark">BCIS</span>
          <div>
            <h1>Subscription Billing and Collection</h1>
            <p>Sign in with your operator account</p>
          </div>
        </div>

        <div className="stack stack--sm">
          <Field label="Username" required>
            <input
              className="input"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>

          <Field label="Password" required>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error ? <Banner tone="error" title="Could not sign in">{error}</Banner> : null}
        </div>

        <div style={{ marginTop: 'var(--space-4)' }}>
          <button type="submit" className="btn btn--primary" disabled={signingIn}>
            {signingIn ? <span className="spinner" /> : null}
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </div>

        <div className="login-card__server">
          <div>
            Server: <span className="mono">{config.apiBase}</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ marginTop: 4 }}
            onClick={() => setShowServer((current) => !current)}
          >
            {showServer ? 'Hide server settings' : 'Wrong server? Change it'}
          </button>

          {showServer ? (
            <div className="stack stack--sm" style={{ marginTop: 'var(--space-3)', textAlign: 'left' }}>
              <Field
                label="BCIS server address"
                hint="On the office server this is usually its LAN address, for example 192.168.1.20:3001"
              >
                <input
                  className="input"
                  value={serverDraft}
                  onChange={(event) => setServerDraft(event.target.value)}
                  placeholder="http://192.168.1.20:3001"
                />
              </Field>

              {serverMessage ? (
                <div className={`text-sm ${serverProbe === 'ok' ? 'text-success' : 'text-danger'}`}>
                  {serverMessage}
                </div>
              ) : null}

              <div className="row">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void testServer()}
                  disabled={serverProbe === 'checking'}
                >
                  {serverProbe === 'checking' ? 'Testing…' : 'Test connection'}
                </button>
                <button type="button" className="btn btn--sm btn--primary" onClick={() => void applyServer()}>
                  Save
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </form>
    </div>
  )
}
