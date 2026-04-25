import { useEffect, useMemo, useRef, useState } from 'react'
import config from './config.js'
import { useBridgeModels } from './hooks/useBridgeModels.js'

const PROVIDER_LABELS = { 'nvidia-nim': 'NIM', 'google': 'Google', 'local': 'Local' }

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

// Prompt style — A/B testable. Surfaced in the Settings section
// alongside Brain. New characters default to 'dynamic'; legacy
// characters with no field stay on 'minimal' until the user opts in.
const PROMPT_STYLE_OPTIONS = [
  {
    id: 'dynamic',
    label: 'dynamic (recommended)',
    hint: 'Anti-silence rule, one-action-per-turn emphasis, numeric mood lever (energy + social, 0–100). Adapted from call-my-ghost.',
  },
  {
    id: 'minimal',
    label: 'minimal (legacy)',
    hint: 'Original short prompt: speak / walk / update state, no anti-silence guidance or mood. Useful as an A/B baseline.',
  },
]

// Brain selector. Mirrors KNOWN_HARNESSES in agent-sandbox/pi-bridge/harnesses/index.js.
// `direct` first because it's the default brain for new spawns.
// Description is shown as a tooltip + a one-line hint under the select.
const HARNESS_OPTIONS = [
  {
    id: 'direct',
    label: 'direct (in-process SDK)',
    hint: 'One LLM call per turn, JSON out. Faster and simpler — recommended for most characters.',
  },
  {
    id: 'pi',
    label: 'pi (coding agent)',
    hint: 'Subprocess with bash/read/write tools. Use when the agent needs file/shell access.',
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

export default function AgentProfile({ pubkey, onClose, onDeleted, onUpdated, onDirtyChange }) {
  const [character, setCharacter] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const { models, defaultProvider: serverDefaultProvider } = useBridgeModels(cfg.bridgeUrl)
  const serverProviders = useMemo(
    () => Array.from(new Set(models.map((m) => m.provider))).filter(Boolean),
    [models],
  )
  // Active provider for the model dropdown. If the character pinned a
  // model, infer its provider; otherwise keep what the user toggled,
  // falling back to the bridge default.
  const characterProvider = useMemo(() => {
    if (!form?.model) return null
    return models.find((m) => m.id === form.model)?.provider || null
  }, [form?.model, models])
  const [selectedProvider, setSelectedProvider] = useState(null)
  const activeProvider = characterProvider || selectedProvider || serverDefaultProvider || serverProviders[0] || 'nvidia-nim'
  const providerModels = useMemo(
    () => models.filter((m) => m.provider === activeProvider),
    [models, activeProvider],
  )

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
          promptStyle: c.promptStyle ?? 'minimal',
        })
      })
      .catch((err) => setError(err.message || String(err)))
  }, [pubkey])

  // Whether the form has unsaved changes vs the loaded character.
  // Lifts to AgentDrawer + Sandbox via onDirtyChange so they can warn
  // before navigating away (tab switch, dismiss, character change).
  const isDirty = useMemo(() => {
    if (!character || !form) return false
    return (
      form.name !== (character.name ?? '') ||
      form.about !== (character.about ?? '') ||
      form.state !== (character.state ?? '') ||
      (form.model || null) !== (character.model || null) ||
      (form.harness || 'direct') !== (character.harness || 'direct') ||
      (form.promptStyle || 'minimal') !== (character.promptStyle || 'minimal')
    )
  }, [character, form])

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  // Reset dirty flag in the parent on unmount so a stale "you have
  // unsaved changes" warning doesn't follow the user to a different
  // character or after a successful save.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

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
          promptStyle: form.promptStyle || null,
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const next = await r.json()
      setCharacter(next)
      onUpdated?.(next)
      if (next.relayPublished === false) {
        // Relay rejected the publish — show the error, don't close.
        // The form values still match `next` so isDirty will read false
        // on the next render, but call the parent explicitly so the
        // Save button picks up its 'Saved' label without waiting.
        onDirtyChange?.(false)
        setError(`Saved locally but relay publish failed: ${next.relayError ?? 'unknown error'}`)
        return
      }
      // Success — clear the dirty flag and stay on the profile so the
      // user can keep tweaking. The Save button's `dirty` styling drops
      // and isDirty re-evaluates against the freshly-saved character.
      onDirtyChange?.(false)
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

  const hasPersona = !!(character.about && character.about.trim())

  return (
    <div className="agent-profile">
      {/* Persona generator. Front-and-center for fresh characters
          where filling out the bio is the next step; collapses to a
          one-line strip once a persona exists so the actual card has
          room to breathe. */}
      <details
        className={`agent-profile-generate-strip${hasPersona ? '' : ' is-empty'}`}
        open={!hasPersona || generating}
      >
        <summary>
          <span className="agent-profile-generate-strip-title">
            {hasPersona ? 'Persona' : 'Persona — generate one'}
          </span>
          <span className="agent-profile-generate-strip-meta">
            {generating && streamModel
              ? <><span className="spinner agent-profile-generate-spinner" /> streaming from <code>{streamModel}</code></>
              : character.profileModel && character.profileSource === 'ai'
                ? <>last generated by <code>{character.profileModel}</code></>
                : hasPersona ? 'manually written' : 'no bio yet'}
          </span>
        </summary>
        <div className="agent-profile-generate-strip-body">
          <button
            type="button"
            onClick={generate}
            disabled={generating || saving}
            className="agent-profile-generate-btn"
          >
            {generating
              ? 'Streaming…'
              : hasPersona ? 'Regenerate persona' : 'Generate persona'}
          </button>
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
        </div>
      </details>

      {/* Compact header card — portrait + name + about row. */}
      <div className="agent-profile-card">
        <div className="agent-profile-card-top">
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

      </div>

      {error && <p className="agent-profile-error">{error}</p>}
      {avatarError && <p className="agent-profile-error">{avatarError}</p>}

      {/* State — the live, agent-managed runtime fields. Distinct
          from Settings (config that bites at spawn time). State
          updates as turns unfold; Settings only changes when you
          edit + respawn. */}
      <fieldset className="agent-profile-section">
        <legend>State</legend>
        <label className="agent-profile-field">
          <span className="agent-profile-field-label">State note</span>
          <textarea
            className="agent-profile-field-textarea"
            value={form.state}
            onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
            placeholder="(empty — the agent updates this between turns under the dynamic prompt)"
            rows={2}
            disabled={saving || generating}
          />
        </label>
        {character?.mood && (
          <div className="agent-profile-mood">
            <span className="agent-profile-field-label">Mood</span>
            <span className="agent-profile-mood-pill">energy: {character.mood.energy ?? '—'}</span>
            <span className="agent-profile-mood-pill">social: {character.mood.social ?? '—'}</span>
          </div>
        )}
      </fieldset>

      {/* Settings — applies on every spawn for this character. Brain
          is operational (which LLM drives the character), not
          identity, so it lives outside the persona card. Collapsed
          by default; expand to override what the bridge would pick. */}
      <details className="agent-profile-strip">
        <summary>
          <span className="agent-profile-strip-title">Settings</span>
          <span className="agent-profile-strip-meta">
            {(() => {
              const parts = []
              if (form.harness) parts.push(form.harness)
              if (form.model) parts.push(form.model.split('/').pop().replace(/-(?:E?\d+B|Q\d+_K_M).*$/i, ''))
              else parts.push('bridge default model')
              return parts.join(' · ')
            })()}
          </span>
        </summary>
        <div className="agent-profile-strip-body">
        <label className="agent-profile-field">
          <span className="agent-profile-field-label">Provider</span>
          <div className="sandbox3-settings-providers">
            {['nvidia-nim', 'google', 'local'].map((p) => (
              <button
                key={p}
                type="button"
                className={p === activeProvider ? 'on' : ''}
                disabled={!serverProviders.includes(p) || saving || generating}
                onClick={() => {
                  setSelectedProvider(p)
                  // Snap the character's model to the first model of the
                  // newly-picked provider (or clear if there are none).
                  const next = models.find((m) => m.provider === p)
                  setForm((f) => ({ ...f, model: next?.id || '' }))
                }}
                title={!serverProviders.includes(p) ? `${PROVIDER_LABELS[p]} not configured on pi-bridge` : ''}
              >
                {PROVIDER_LABELS[p] || p}
              </button>
            ))}
          </div>
        </label>
        <label className="agent-profile-field">
          <span className="agent-profile-field-label">Model</span>
          <select
            className="agent-profile-field-select"
            value={form.model || ''}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            disabled={providerModels.length === 0 || saving || generating}
          >
            <option value="">— bridge default —</option>
            {providerModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.activeParamsB ? ` (${m.activeParamsB}B)` : ''}
                {m.cost?.input ? ` — $${m.cost.input}/M in` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-profile-field">
          <span className="agent-profile-field-label">Brain</span>
          <div className="sandbox3-settings-providers">
            {HARNESS_OPTIONS.map((h) => (
              <button
                key={h.id}
                type="button"
                className={h.id === form.harness ? 'on' : ''}
                onClick={() => setForm((f) => ({ ...f, harness: h.id }))}
                disabled={saving || generating}
                title={h.hint}
              >
                {h.label.split(' ')[0]}
              </button>
            ))}
          </div>
          <small className="agent-profile-field-hint">
            {HARNESS_OPTIONS.find((h) => h.id === form.harness)?.hint || ''}
          </small>
        </label>
        <label className="agent-profile-field">
          <span className="agent-profile-field-label">Prompt style</span>
          <div className="sandbox3-settings-providers">
            {PROMPT_STYLE_OPTIONS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === form.promptStyle ? 'on' : ''}
                onClick={() => setForm((f) => ({ ...f, promptStyle: p.id }))}
                disabled={saving || generating}
                title={p.hint}
              >
                {p.label.split(' ')[0]}
              </button>
            ))}
          </div>
          <small className="agent-profile-field-hint">
            {PROMPT_STYLE_OPTIONS.find((p) => p.id === form.promptStyle)?.hint || ''}
          </small>
        </label>
        </div>
      </details>

      <form onSubmit={save} className="agent-profile-actions" noValidate>
        <span style={{ flex: 1 }} />
        {isDirty && <span className="agent-profile-dirty-flag" title="Unsaved changes">●</span>}
        <button
          type="submit"
          disabled={saving || generating || !isDirty}
          className={`primary${isDirty ? ' dirty' : ''}`}
          title={isDirty ? 'Save changes' : 'No changes to save'}
        >
          {saving ? 'Saving…' : isDirty ? 'Save *' : 'Saved'}
        </button>
      </form>

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
