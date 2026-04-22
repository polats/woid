import { useEffect, useMemo, useState } from 'react'
import { useBridgeModels } from './hooks/useBridgeModels.js'

/**
 * Settings panel mounted in the sandbox sidebar. Picks the default
 * provider + model used when a character without an explicit model
 * override is spawned. Defaults live in localStorage via
 * useSandboxSettings; this component is pure UI.
 */
export default function SandboxSettings({ bridgeUrl, settings, onChange }) {
  const { models, defaultProvider: serverDefaultProvider, defaultModel: serverDefaultModel } = useBridgeModels(bridgeUrl)
  const [open, setOpen] = useState(false)

  const serverProviders = useMemo(
    () => Array.from(new Set(models.map((m) => m.provider))).filter(Boolean),
    [models],
  )

  // Which provider is active. Priority: user selection → server's
  // PI_DEFAULT_PROVIDER (exposed via /models) → first known provider.
  // We commit that default into settings on mount so it persists in
  // localStorage — otherwise spawnBody's `if (settings.provider)` check
  // falls through every session and the pi-bridge fallback never shows
  // as "selected" in the UI.
  const activeProvider = settings.provider || serverDefaultProvider || serverProviders[0] || 'nvidia-nim'
  const providerModels = useMemo(
    () => models.filter((m) => m.provider === activeProvider),
    [models, activeProvider],
  )

  // Initial commit: when /models loads and settings is empty, write the
  // server default into localStorage so subsequent renders see it as a
  // real selection.
  useEffect(() => {
    if (settings.provider) return
    if (!serverDefaultProvider) return
    const defaultFromCatalog =
      (serverDefaultModel && models.find((m) => m.id === serverDefaultModel && m.provider === serverDefaultProvider)?.id) ||
      models.find((m) => m.provider === serverDefaultProvider)?.id ||
      null
    if (defaultFromCatalog) {
      onChange({ provider: serverDefaultProvider, model: defaultFromCatalog })
    }
  }, [settings.provider, serverDefaultProvider, serverDefaultModel, models, onChange])

  // Keep settings.model consistent with the active provider — snap to
  // the provider's first model if the saved id isn't valid anymore.
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
      </div>
    </details>
  )
}
