import { useEffect, useMemo, useState } from 'react'

/**
 * Settings panel mounted in the sandbox sidebar. Picks the default
 * provider + model used when a character without an explicit model
 * override is spawned. Defaults live in localStorage via
 * useSandboxSettings; this component is pure UI.
 */
export default function SandboxSettings({ bridgeUrl, settings, onChange }) {
  const [models, setModels] = useState([])
  const [serverDefault, setServerDefault] = useState(null)
  const [serverProviders, setServerProviders] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!bridgeUrl) return
    fetch(`${bridgeUrl}/models`)
      .then((r) => r.json())
      .then((j) => {
        setModels(j.models || [])
        setServerDefault(j.default ?? null)
        const provs = Array.from(new Set((j.models || []).map((m) => m.provider))).filter(Boolean)
        setServerProviders(provs)
      })
      .catch(() => {})
  }, [bridgeUrl])

  // Which provider is active — user selection wins, else server default.
  const activeProvider = settings.provider || serverProviders[0] || 'nvidia-nim'
  const providerModels = useMemo(
    () => models.filter((m) => m.provider === activeProvider),
    [models, activeProvider],
  )
  // Validate the saved model still exists for this provider; clear if not.
  useEffect(() => {
    if (!settings.model) return
    if (!providerModels.some((m) => m.id === settings.model)) {
      onChange({ model: null })
    }
  }, [providerModels, settings.model, onChange])

  const activeModel = settings.model || providerModels[0]?.id || ''

  const PROVIDER_LABELS = {
    'nvidia-nim': 'NIM',
    'google': 'Google',
    'local': 'Local',
  }

  return (
    <details className="sandbox3-settings" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="sandbox3-settings-title">Settings</span>
        <span className="sandbox3-settings-current">
          {PROVIDER_LABELS[activeProvider] || activeProvider} · {activeModel ? activeModel.split('/').pop() : '—'}
        </span>
      </summary>
      <div className="sandbox3-settings-body">
        <label>
          <span>Provider</span>
          <div className="sandbox3-settings-providers">
            {['nvidia-nim', 'google', 'local'].map((p) => (
              <button
                key={p}
                type="button"
                className={p === activeProvider ? 'on' : ''}
                disabled={!serverProviders.includes(p)}
                onClick={() => onChange({ provider: p, model: null })}
                title={!serverProviders.includes(p) ? `${PROVIDER_LABELS[p]} not configured on pi-bridge` : ''}
              >
                {PROVIDER_LABELS[p] || p}
              </button>
            ))}
          </div>
        </label>
        <label>
          <span>Model</span>
          <select
            value={activeModel}
            onChange={(e) => onChange({ model: e.target.value })}
            disabled={providerModels.length === 0}
          >
            {providerModels.length === 0 && <option value="">— no models —</option>}
            {providerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.activeParamsB ? ` (${m.activeParamsB}B)` : ''}
                {m.cost?.input ? ` — $${m.cost.input}/M in` : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="sandbox3-settings-hint">
          Used when spawning characters that don't override model in their profile.
          {serverDefault && <> Pi-bridge default: <code>{serverDefault}</code>.</>}
        </p>
      </div>
    </details>
  )
}
