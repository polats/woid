import { useEffect, useRef, useState } from 'react'
import config from '../woid.config.json'

const cfg = config.agentSandbox || {}
const JUMBLE_URL = cfg.jumbleUrl || 'http://localhost:18089'

// Persona-generation model pool. Mirrors PERSONA_MODELS on the bridge.
// Bridge treats any id not in its own list as "random".
const GEN_MODELS = [
  { id: '', label: 'Random model' },
  { id: 'meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' },
  { id: 'qwen/qwen3-next-80b-a3b-instruct', label: 'Qwen3 Next 80B A3B' },
  { id: 'qwen/qwen3.5-122b-a10b', label: 'Qwen 3.5 122B A10B' },
  { id: 'mistralai/ministral-14b-instruct-2512', label: 'Ministral 14B' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
]

// Best-effort partial-JSON extraction so we can write the growing fields
// back to the form as the stream arrives. Handles the case where the
// closing `"` or `}` hasn't landed yet by falling back to "everything
// after the key marker up to EOL".
function extractLivePersona(raw) {
  if (!raw) return { name: '', about: '' }
  function pull(key) {
    const closed = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (closed) return closed[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    const open = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`))
    if (open) return open[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    return ''
  }
  return {
    name: pull('name').slice(0, 80),
    about: pull('about').slice(0, 1000),
  }
}

export default function AgentProfile({ pubkey, onClose, onDeleted, onUpdated }) {
  const [character, setCharacter] = useState(null)
  const [models, setModels] = useState([])
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Persona streaming. Always overwrites the name — the random default handle
  // is never worth keeping.
  const [generating, setGenerating] = useState(false)
  const [seed, setSeed] = useState('')
  const [genModel, setGenModel] = useState('')
  const [streamModel, setStreamModel] = useState(null)
  const streamAbortRef = useRef(null)

  // Avatar
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarError, setAvatarError] = useState(null)

  useEffect(() => {
    if (!pubkey) return
    fetch(`${cfg.bridgeUrl}/characters/${pubkey}`)
      .then((r) => r.json())
      .then((c) => {
        setCharacter(c)
        setForm({
          name: c.name ?? '',
          about: c.about ?? '',
          model: c.model ?? '',
        })
      })
      .catch((err) => setError(err.message || String(err)))
    fetch(`${cfg.bridgeUrl}/models`)
      .then((r) => r.json())
      .then((j) => setModels(j.models || []))
      .catch(() => {})
  }, [pubkey])

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/characters/${pubkey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          about: form.about.trim() || null,
          model: form.model || null,
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const next = await r.json()
      setCharacter(next)
      onUpdated?.(next)
      if (next.relayPublished === false) {
        // Relay rejected the publish — show the error, don't close.
        setError(`Saved locally but relay publish failed: ${next.relayError ?? 'unknown error'}`)
        return
      }
      // Success — close the modal.
      onClose?.()
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setSaving(false)
    }
  }

  async function generate() {
    setGenerating(true)
    setError(null)
    setStreamModel(null)

    const ctrl = new AbortController()
    streamAbortRef.current = ctrl

    try {
      const res = await fetch(
        `${cfg.bridgeUrl}/characters/${pubkey}/generate-profile/stream`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seed: seed.trim() || undefined,
            overwriteName: true,
            model: genModel || undefined,
          }),
          signal: ctrl.signal,
        },
      )
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let rawDelta = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const events = buf.split(/\n\n/)
        buf = events.pop() ?? ''
        for (const evChunk of events) {
          const lines = evChunk.split('\n')
          let eventType = 'message'
          const dataLines = []
          for (const line of lines) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          const data = dataLines.join('\n')
          if (!data) continue
          try {
            const parsed = JSON.parse(data)
            if (eventType === 'model') {
              setStreamModel(parsed.model)
            } else if (eventType === 'delta') {
              rawDelta += parsed.content ?? ''
              // Stream directly into the name + about inputs.
              const live = extractLivePersona(rawDelta)
              setForm((f) => ({ ...f, name: live.name || f.name, about: live.about || f.about }))
            } else if (eventType === 'persona-done') {
              // Snap to clean final values parsed on the server.
              setForm((f) => ({
                ...f,
                name: parsed.name ?? f.name,
                about: parsed.about ?? f.about,
              }))
            } else if (eventType === 'avatar-start') {
              setAvatarLoading(true)
              setAvatarError(null)
            } else if (eventType === 'avatar-done') {
              setAvatarLoading(false)
              setCharacter((prev) => ({ ...prev, avatarUrl: parsed.avatarUrl }))
            } else if (eventType === 'avatar-error') {
              setAvatarLoading(false)
              setAvatarError(parsed.error || 'avatar generation failed')
            } else if (eventType === 'done') {
              setCharacter((prev) => ({ ...prev, ...parsed }))
              onUpdated?.(parsed)
            } else if (eventType === 'error') {
              throw new Error(parsed.error || 'stream error')
            }
          } catch {
            /* tolerate malformed chunks */
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message || String(err))
    } finally {
      setGenerating(false)
      streamAbortRef.current = null
      setAvatarLoading(false)
    }
  }

  async function generateAvatar() {
    setAvatarLoading(true)
    setAvatarError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/characters/${pubkey}/generate-avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!r.ok) throw new Error(await r.text())
      const result = await r.json()
      setCharacter((prev) => ({ ...prev, avatarUrl: result.avatarUrl }))
      onUpdated?.(result)
    } catch (err) {
      setAvatarError(err.message || String(err))
    } finally {
      setAvatarLoading(false)
    }
  }

  async function remove() {
    if (!confirm(`Delete character "${character?.name}"? This also stops any running runtime.`)) return
    try {
      const r = await fetch(`${cfg.bridgeUrl}/characters/${pubkey}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(await r.text())
      onDeleted?.()
    } catch (err) {
      setError(err.message || String(err))
    }
  }

  if (!character || !form) {
    return (
      <div className="agent-profile-modal-backdrop" onClick={onClose}>
        <div className="agent-profile-modal" onClick={(e) => e.stopPropagation()}>
          <p className="muted">Loading…</p>
        </div>
      </div>
    )
  }

  const jumbleHref = `${JUMBLE_URL}/${character.npub}`

  return (
    <div className="agent-profile-modal-backdrop" onClick={onClose}>
      <div className="agent-profile-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{character.name}</h2>
          <button onClick={onClose}>close</button>
        </header>
        <div className="agent-profile-meta">
          <code title={character.pubkey}>{character.npub}</code>
          {character.runtime && <span className="status status-connected">running</span>}
          <a
            href={jumbleHref}
            target="_blank"
            rel="noreferrer"
            className="agent-profile-jumble-link"
            title="Open this character's profile on the hosted Jumble client"
          >
            View on Jumble ↗
          </a>
        </div>

        <fieldset className="agent-profile-generate agent-profile-generate-top">
          <legend>AI profile</legend>
          <label>
            Seed (optional)
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="e.g. 'new kid this summer' — guides the archetype"
              disabled={generating}
            />
          </label>

          <div className="agent-profile-generate-row">
            <button
              type="button"
              onClick={generate}
              disabled={generating || saving}
            >
              {generating ? 'Streaming…' : '✨ Generate Persona'}
            </button>
            <select
              value={genModel}
              onChange={(e) => setGenModel(e.target.value)}
              disabled={generating}
              title="Which NIM model to ask"
            >
              {GEN_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          {generating && streamModel ? (
            <p className="agent-profile-generate-model">
              <span className="spinner agent-profile-generate-spinner" />
              Streaming from <code>{streamModel}</code>…
            </p>
          ) : character.profileModel && character.profileSource === 'ai' ? (
            <p className="agent-profile-generate-model muted">
              Generated by <code>{character.profileModel}</code>
            </p>
          ) : null}
        </fieldset>

        <form onSubmit={save} className="agent-profile-form">
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              disabled={saving || generating}
            />
          </label>
          <label>
            About
            <textarea
              rows={4}
              placeholder="Short bio rendered in the Nostr kind:0 profile."
              value={form.about}
              onChange={(e) => setForm((f) => ({ ...f, about: e.target.value }))}
              disabled={saving || generating}
            />
          </label>
          <label>
            Default model for runtimes
            <select
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              disabled={saving || models.length === 0}
            >
              <option value="">— use spawn-time default —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.activeParamsB ? ` (${m.activeParamsB}B)` : ''}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="agent-profile-error">{error}</p>}

          <div className="agent-profile-actions">
            <button type="button" onClick={remove} className="danger">Delete</button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={saving || generating} className="primary">
              {saving ? 'Saving…' : 'Save + publish'}
            </button>
          </div>
        </form>

        <div className="agent-profile-avatar-row">
          <div className="agent-profile-avatar">
            {avatarLoading ? (
              <div className="agent-profile-avatar-spinner" aria-label="Generating avatar">
                <div className="spinner" />
                <small>Generating with FLUX…</small>
              </div>
            ) : character.avatarUrl ? (
              <img src={character.avatarUrl} alt={character.name} />
            ) : (
              <div className="agent-profile-avatar-empty">
                <span>No avatar</span>
              </div>
            )}
          </div>
          <div className="agent-profile-avatar-actions">
            <button type="button" onClick={generateAvatar} disabled={avatarLoading || generating}>
              {character.avatarUrl ? 'Regenerate avatar' : '✨ Generate avatar'}
            </button>
            {avatarError && <p className="agent-profile-error">{avatarError}</p>}
            <p className="muted">
              NIM FLUX.1-schnell. Uses the current name + about as the prompt.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
