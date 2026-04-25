import { useEffect, useRef, useState } from 'react'
import config from './config.js'

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

// Brain selector. Mirrors KNOWN_HARNESSES in agent-sandbox/pi-bridge/harnesses/index.js.
// Description is shown as a tooltip + a one-line hint under the select.
const HARNESS_OPTIONS = [
  {
    id: 'pi',
    label: 'pi (coding agent)',
    hint: 'Subprocess with bash/read/write tools. Use when the agent needs file/shell access.',
  },
  {
    id: 'direct',
    label: 'direct (in-process SDK)',
    hint: 'One LLM call per turn, JSON out. Faster and simpler — recommended for most characters.',
  },
  {
    id: 'external',
    label: 'external (you drive it)',
    hint: 'Bridge runs no LLM. Connect a remote driver via SSE + /act. See public/llms.txt.',
  },
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
          state: c.state ?? '',
          model: c.model ?? '',
          harness: c.harness ?? 'direct',
        })
      })
      .catch((err) => setError(err.message || String(err)))
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
          state: form.state.trim() || null,
          model: form.model || null,
          harness: form.harness || null,
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
    return <p className="muted" style={{ padding: '14px' }}>Loading…</p>
  }

  const initial = (form.name || '?').trim().charAt(0).toUpperCase()

  return (
    <div className="agent-profile">
      {/* Compact header card — mirrors .sandbox3-card: portrait + name +
          about, with "Regenerate avatar" tucked directly beneath the
          portrait so it's obvious what it applies to. */}
      <div className="agent-profile-card">
        <div className="agent-profile-card-portrait-col">
          <div className="agent-profile-card-portrait">
            {avatarLoading ? (
              <div className="agent-profile-card-portrait-spinner" aria-label="Generating avatar">
                <div className="spinner" />
              </div>
            ) : character.avatarUrl ? (
              <img src={character.avatarUrl} alt={form.name || 'avatar'} />
            ) : (
              <div className="agent-profile-card-portrait-fallback">{initial}</div>
            )}
          </div>
          <button
            type="button"
            onClick={generateAvatar}
            disabled={avatarLoading || generating}
            className="agent-profile-avatar-btn"
          >
            {character.avatarUrl ? 'Regenerate avatar' : 'Generate avatar'}
          </button>
        </div>
        <div className="agent-profile-card-body">
          <input
            className="agent-profile-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            disabled={saving || generating}
            placeholder="Name"
            maxLength={80}
          />
          <textarea
            className="agent-profile-about"
            rows={4}
            placeholder="Short bio. Published as the Nostr kind:0 about."
            value={form.about}
            onChange={(e) => setForm((f) => ({ ...f, about: e.target.value }))}
            disabled={saving || generating}
          />
          <label className="agent-profile-harness">
            <span className="agent-profile-harness-label">Brain</span>
            <select
              className="agent-profile-harness-select"
              value={form.harness}
              onChange={(e) => setForm((f) => ({ ...f, harness: e.target.value }))}
              disabled={saving || generating}
              title={HARNESS_OPTIONS.find((h) => h.id === form.harness)?.hint || ''}
            >
              {HARNESS_OPTIONS.map((h) => (
                <option key={h.id} value={h.id} title={h.hint}>
                  {h.label}
                </option>
              ))}
            </select>
            <small className="agent-profile-harness-hint">
              {HARNESS_OPTIONS.find((h) => h.id === form.harness)?.hint || ''}
            </small>
          </label>
          <a
            className="agent-profile-card-npub"
            href={`${JUMBLE_URL}/${character.npub}`}
            target="_blank"
            rel="noreferrer"
            title={`Open ${character.name} on Jumble`}
          >
            {character.npub}
          </a>
        </div>
      </div>

      {error && <p className="agent-profile-error">{error}</p>}
      {avatarError && <p className="agent-profile-error">{avatarError}</p>}

      <form onSubmit={save} className="agent-profile-actions" noValidate>
        <span style={{ flex: 1 }} />
        <button type="submit" disabled={saving || generating} className="primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      {/* Generate persona — the big obvious action. Seed + model are
          tucked inside a collapsible to stay out of the way. Label
          matches the avatar button's verb: Generate when empty,
          Regenerate when we already have one. */}
      <fieldset className="agent-profile-generate">
        <legend>Persona</legend>
        <button
          type="button"
          onClick={generate}
          disabled={generating || saving}
          className="agent-profile-generate-btn"
        >
          {generating
            ? 'Streaming…'
            : (character.about && character.profileSource === 'ai')
            ? 'Regenerate persona'
            : 'Generate persona'}
        </button>
        {generating && streamModel ? (
          <p className="agent-profile-generate-model">
            <span className="spinner agent-profile-generate-spinner" />
            Streaming from <code>{streamModel}</code>…
          </p>
        ) : character.profileModel && character.profileSource === 'ai' ? (
          <p className="agent-profile-generate-model muted">
            Last generated by <code>{character.profileModel}</code>
          </p>
        ) : null}
        <details className="agent-profile-generate-options">
          <summary>Options</summary>
          <label>
            Seed
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="e.g. 'new kid this summer'"
              disabled={generating}
            />
          </label>
          <label>
            Model
            <select
              value={genModel}
              onChange={(e) => setGenModel(e.target.value)}
              disabled={generating}
            >
              {GEN_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
        </details>
      </fieldset>

      {/* Destructive actions live at the bottom under an explicit
          header so they're hard to trigger by accident. */}
      <fieldset className="agent-profile-danger">
        <legend>Danger zone</legend>
        <p className="muted">
          Deletes this character's keypair, session history, avatar, and
          any running runtime. Not recoverable.
        </p>
        <button type="button" onClick={remove} className="danger">Delete character</button>
      </fieldset>
    </div>
  )
}
