import { useEffect, useState, useCallback } from 'react'

// Persisted sandbox-wide defaults used when spawning a character that
// doesn't have its own `model` override. Stored in localStorage so the
// selection survives tab reloads; all edits live purely client-side.
const KEY = 'woid-sandbox-settings.v1'

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

export function useSandboxSettings() {
  const [settings, setSettings] = useState(load)

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {}
  }, [settings])

  const update = useCallback((patch) => {
    setSettings((s) => ({ ...s, ...patch }))
  }, [])

  const reset = useCallback(() => setSettings({}), [])

  return { settings, update, reset }
}
