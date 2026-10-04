import { useEffect, useState } from 'react'

import { Banner, Field, LoadError, PageHeader, Panel } from '../components/ui'
import { useAuth } from '../lib/auth'
import { useConfig } from '../lib/config'
import { useApiMutation, useApiQuery } from '../lib/query'
import type { ProbeResult } from '../types/bridge'

interface BusinessSettings {
  gracePeriodDays: number
  suspensionThresholdMonths: number
  latePenaltyCentavos: number
  penaltyEnabled: boolean
  defaultReconnectionFeeCentavos: number
  companyName: string
  companyAddress: string
  businessName: string
  defaultDueDay: number
}

interface SettingsResponse {
  settings: BusinessSettings
}

type SettingName = keyof BusinessSettings
type DraftValue = string | boolean

interface SettingField {
  name: SettingName
  key: string
  label: string
  type: 'text' | 'number' | 'money' | 'boolean'
  category: 'General' | 'Billing' | 'Service'
  min?: number
  max?: number
  hint?: string
}

const SETTING_FIELDS: SettingField[] = [
  { name: 'companyName', key: 'general.company_name', label: 'Company name', type: 'text', category: 'General' },
  { name: 'businessName', key: 'general.business_name', label: 'Business name', type: 'text', category: 'General' },
  { name: 'companyAddress', key: 'general.company_address', label: 'Company address', type: 'text', category: 'General' },
  { name: 'gracePeriodDays', key: 'billing.grace_period_days', label: 'Grace period (days)', type: 'number', category: 'Billing', min: 0 },
  { name: 'latePenaltyCentavos', key: 'billing.late_penalty_centavos', label: 'Late penalty (PHP)', type: 'money', category: 'Billing', min: 0 },
  { name: 'penaltyEnabled', key: 'billing.penalty_enabled', label: 'Apply late penalties', type: 'boolean', category: 'Billing' },
  { name: 'defaultDueDay', key: 'billing.default_due_day', label: 'Default due day', type: 'number', category: 'Billing', min: 1, max: 31 },
  { name: 'suspensionThresholdMonths', key: 'service.suspension_threshold_months', label: 'Suspension threshold (months)', type: 'number', category: 'Service', min: 1 },
  { name: 'defaultReconnectionFeeCentavos', key: 'service.default_reconnection_fee_centavos', label: 'Default reconnection fee (PHP)', type: 'money', category: 'Service', min: 0 }
]

function toDraft(field: SettingField, value: BusinessSettings[SettingName]): DraftValue {
  if (field.type === 'boolean') {
    return Boolean(value)
  }
  if (field.type === 'money') {
    return (Number(value) / 100).toFixed(2)
  }
  return String(value ?? '')
}

function toStoredValue(field: SettingField, value: DraftValue): unknown {
  if (field.type === 'boolean') {
    return value
  }
  if (field.type === 'text') {
    return String(value).trim()
  }
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue < (field.min ?? 0) || (field.max !== undefined && numericValue > field.max)) {
    throw new Error(`${field.label} is outside the allowed range.`)
  }
  return field.type === 'money' ? Math.round(numericValue * 100) : Math.trunc(numericValue)
}

export function SettingsScreen(): React.JSX.Element {
  const { can } = useAuth()
  const { config, saveConfig, probe } = useConfig()
  const [apiDraft, setApiDraft] = useState(config.apiBase)
  const [connectionMessage, setConnectionMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => setApiDraft(config.apiBase), [config.apiBase])

  const businessSettings = useApiQuery<SettingsResponse>(
    ['settings'],
    (client) => client.get<SettingsResponse>('/settings'),
    { enabled: can('settings.manage') }
  )

  useEffect(() => {
    if (businessSettings.data) {
      setDrafts(Object.fromEntries(SETTING_FIELDS.map((field) => [field.name, toDraft(field, businessSettings.data!.settings[field.name])])) as Record<string, DraftValue>)
    }
  }, [businessSettings.data])

  const saveSetting = useApiMutation<{ key: string; value: unknown }, unknown>(
    (client, setting) => client.put(`/settings/${setting.key}`, { value: setting.value }),
    { onSuccess: () => void businessSettings.refetch() }
  )

  const testConnection = async () => {
    setConnectionMessage(null)
    setProbeResult(await probe(apiDraft))
  }

  const saveConnection = async () => {
    try {
      await saveConfig({ apiBase: apiDraft })
      setConnectionMessage({ tone: 'success', text: 'Server address saved.' })
    } catch (error) {
      setConnectionMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not save the server address.' })
    }
  }

  const updateDraft = (name: SettingName, value: DraftValue) => {
    setDrafts((current) => ({ ...current, [name]: value }))
    setSaveError(null)
  }

  const saveBusinessSetting = (field: SettingField) => {
    try {
      saveSetting.mutate({ key: field.key, value: toStoredValue(field, drafts[field.name]) })
      setSaveError(null)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save the setting.')
    }
  }

  if (can('settings.manage') && businessSettings.error) {
    return <LoadError message={businessSettings.error.message} onRetry={() => void businessSettings.refetch()} />
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Client connection and billing defaults" />
      <div className="stack">
        <Panel title="Server connection" subtitle="This desktop client uses the configured BCIS API address.">
          <div className="stack stack--sm">
            <Field label="BCIS server address" hint="Example: http://192.168.1.20:3001">
              <input className="input" value={apiDraft} onChange={(event) => setApiDraft(event.target.value)} />
            </Field>
            {connectionMessage ? <Banner tone={connectionMessage.tone} title={connectionMessage.tone === 'success' ? 'Saved' : 'Could not save'}>{connectionMessage.text}</Banner> : null}
            {probeResult ? (
              <Banner tone={probeResult.ok ? 'success' : 'error'} title={probeResult.ok ? 'Connection successful' : 'Connection failed'}>
                {probeResult.ok ? `Reached ${probeResult.apiBase}.` : probeResult.error ?? `Server returned status ${probeResult.status}.`}
              </Banner>
            ) : null}
            <div className="row">
              <button type="button" className="btn" onClick={() => void testConnection()}>Test connection</button>
              <button type="button" className="btn btn--primary" onClick={() => void saveConnection()}>Save address</button>
            </div>
          </div>
        </Panel>

        {can('settings.manage') ? (
          <>
            {saveError ? <Banner tone="error" title="Setting not saved">{saveError}</Banner> : null}
            {saveSetting.error ? <Banner tone="error" title="Setting not saved">{saveSetting.error.message}</Banner> : null}
            {saveSetting.isSuccess ? <Banner tone="success" title="Setting saved">The updated value is now in effect.</Banner> : null}
            {(['General', 'Billing', 'Service'] as const).map((category) => (
              <Panel key={category} title={`${category} settings`}>
                {businessSettings.isPending ? <div className="text-sm text-muted">Loading settings…</div> : (
                  <div className="stack">
                    {SETTING_FIELDS.filter((field) => field.category === category).map((field) => (
                      <div key={field.name} className="row" style={{ alignItems: 'end', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
                        <div style={{ flex: 1 }}>
                          {field.type === 'boolean' ? (
                            <label className="checkbox-row">
                              <input
                                type="checkbox"
                                checked={Boolean(drafts[field.name])}
                                onChange={(event) => updateDraft(field.name, event.target.checked)}
                              />
                              <span>{field.label}</span>
                            </label>
                          ) : (
                            <Field label={field.label}>
                              <input
                                className="input"
                                type={field.type === 'text' ? 'text' : 'number'}
                                min={field.min}
                                max={field.max}
                                step={field.type === 'money' ? '0.01' : '1'}
                                value={String(drafts[field.name] ?? '')}
                                onChange={(event) => updateDraft(field.name, event.target.value)}
                              />
                            </Field>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={saveSetting.isPending || drafts[field.name] === undefined}
                          onClick={() => saveBusinessSetting(field)}
                        >
                          Save
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            ))}
          </>
        ) : null}
      </div>
    </>
  )
}