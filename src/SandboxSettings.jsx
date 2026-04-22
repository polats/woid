import { useEffect, useMemo, useState } from 'react'
import { useBridgeModels } from './hooks/useBridgeModels.js'

/**
 * Settings panel mounted in the sandbox sidebar. Picks the default
 * provider + model used when a character without an explicit model
 * override is spawned. Defaults live in localStorage via
 * useSandboxSettings; this component is pure UI.
 */
export default function SandboxSettings({ bridgeUrl, settings, onChange }) {
  const { models, defaultModel: serverDefault } = useBridgeModels(bridgeUrl)
  const [open, setOpen] = useState(false)

  const serverProviders = useMemo(
    () => Array.from(new Set(models.map((m) => m.provider))).filter(Boolean),
    [models],
  )

  // Which provider is active — user selection wins, else server default.
  const activeProvider = settings.provider || serverProviders[0] || 'nvidia-nim'
  const providerModels = useMemo(
    () => models.filter((m) => m.provider === activeProvider),
    [models, activeProvider],
  )
  // If the user has a provider selected, keep settings.model consistent
  // with it — snap to the provider's first model if the saved id isn't
  // valid anymore. We deliberately *don't* write settings on mount when
  // `settings.provider` is unset: that's the "use per-character model"
  // state, and spawning before the user clicks a provider should leave
  // per-character + server defaults in charge.
  useEffect(() => {
    if (!settings.provider) return
    if (providerModels.length === 0) return
    const stillValid = settings.model && providerModels.some((m) => m.id === settings.model)
    if (!stillValid) {
      onChange({ model: providerModels[0].id })
    }
  }, [providerModels, settings.model, settings.provider, onChange])

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
          {settings.provider
            ? `${PROVIDER_LABELS[activeProvider] || activeProvider} · ${activeModel ? activeModel.split('/').pop() : '—'}`
            : 'per-character'}
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
          Wins over per-character model in AgentProfile. Click
          <button
            type="button"
            className="sandbox3-settings-reset"
            onClick={() => onChange({ provider: null, model: null })}
            disabled={!settings.provider}
          >reset</button>
          to fall back to each character's own model (or pi-bridge default{serverDefault ? <>: <code>{serverDefault}</code></> : null}).
        </p>
      </div>
    </details>
  )
}
