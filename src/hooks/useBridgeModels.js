import { useEffect, useState } from 'react'

// Single source of truth for /models. Shared by Sandbox (to resolve
// spawn-time model/provider pairs) and SandboxSettings (to render the
// picker). Polls once on mount — the catalog is small + stable between
// pi-bridge restarts, so repoll isn't worth the churn.
export function useBridgeModels(bridgeUrl) {
  const [models, setModels] = useState([])
  const [defaultModel, setDefaultModel] = useState(null)
  const [defaultProvider, setDefaultProvider] = useState(null)

  useEffect(() => {
    if (!bridgeUrl) return
    let cancelled = false
    fetch(`${bridgeUrl}/models`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setModels(j.models || [])
        setDefaultModel(j.default ?? null)
        setDefaultProvider(j.defaultProvider ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bridgeUrl])

  return { models, defaultModel, defaultProvider }
}
