import { useEffect, useMemo, useRef, useState } from 'react'
import config from './config.js'
import { useBridgeModels } from './hooks/useBridgeModels.js'
import { extractLivePersona, streamGenerateProfile } from './lib/personaStream.js'

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

// Need axes (matches NEED_AXES on the bridge). Order = display order.
// Narrowed from 3-axis (#235) to 2-axis (#275) — psychological state
// moved to moodlets.
const NEEDS_AXES = ['energy', 'social']

// Compute the 4-state wellbeing level from a needs vector. Mirrors
// computeWellbeing() in agent-sandbox/pi-bridge/needs.js — kept
// duplicated rather than shared because the frontend doesn't import
// server-side modules.
// Loosened bands (mirrors needs.js DEFAULTS.wellbeingBands).
// All axes ≥ 50 → thriving. Below 50 → uneasy. Below 30 → distressed.
// Below 15 → in_crisis.
const WELLBEING_BANDS = [
  { name: 'thriving',   min: 50 },
  { name: 'uneasy',     min: 30 },
  { name: 'distressed', min: 15 },
  { name: 'in_crisis',  min: 0  },
]
function wellbeingFromNeeds(needs) {
  if (!needs) return 'thriving'
  let min = 100
  for (const axis of NEEDS_AXES) {
    const v = typeof needs[axis] === 'number' ? needs[axis] : 100
    if (v < min) min = v
  }
  for (const b of WELLBEING_BANDS) if (min >= b.min) return b.name
  return 'in_crisis'
}

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
  // Debounce handle for auto-persisting slider changes. Slider drags
  // produce many onChange events per second; coalesce into a single
  // PATCH after the user pauses ~250ms.
  const needsPersistTimer = useRef(null)

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
          needs: {
            energy: c.needs?.energy ?? 75,
            social: c.needs?.social ?? 75,
          },
        })
      })
      .catch((err) => setError(err.message || String(err)))
  }, [pubkey])

  // Auto-persist needs after a short debounce — slider drags produce
  // a flood of onChange events; we coalesce and PATCH once when the
  // user pauses. This keeps the manifest in sync with what the user
  // sees, so a drag-to-spawn picks up the correct initial values.
  function scheduleNeedsPersist(nextNeeds) {
    if (!cfg.bridgeUrl || !pubkey) return
    if (needsPersistTimer.current) clearTimeout(needsPersistTimer.current)
    needsPersistTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${cfg.bridgeUrl}/characters/${pubkey}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ needs: nextNeeds }),
        })
        if (!r.ok) return
        // Update local character so isDirty() doesn't keep flagging
        // needs as changed against a now-stale snapshot.
        setCharacter((c) => (c ? { ...c, needs: nextNeeds } : c))
      } catch { /* transient — next slider change retries */ }
    }, 250)
  }

  // Cancel any pending needs PATCH on unmount so a closing drawer
  // doesn't leak an in-flight write.
  useEffect(() => () => {
    if (needsPersistTimer.current) clearTimeout(needsPersistTimer.current)
  }, [])

  // Live needs poll — character.needs in state is whatever was loaded
  // at fetch time; the bridge persists every 5s after a 2-point drift,
  // so polling /health/needs gives us closer-to-real-time values for
  // the bars and wellbeing badge.
  const [liveNeeds, setLiveNeeds] = useState(null)
  useEffect(() => {
    if (!cfg.bridgeUrl || !pubkey) return
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch(`${cfg.bridgeUrl}/health/needs`)
        if (!r.ok) return
        const j = await r.json()
        const me = (j.characters || []).find((c) => c.pubkey === pubkey)
        if (!cancelled && me) setLiveNeeds({ needs: me.needs, wellbeing: me.wellbeing })
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [pubkey])

  // Live moodlets poll (#275 slice 1.4). Per-character endpoint —
  // returns active moodlets + derived mood + band. Same 4s cadence
  // as needs so the Vitals panel reads as a single coherent surface.
  const [liveMood, setLiveMood] = useState(null)
  useEffect(() => {
    if (!cfg.bridgeUrl || !pubkey) return
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch(`${cfg.bridgeUrl}/moodlets/${pubkey}`)
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled) {
          setLiveMood({ active: j.active || [], mood: j.mood, band: j.band })
        }
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(t) }
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
      (form.promptStyle || 'minimal') !== (character.promptStyle || 'minimal') ||
      NEEDS_AXES.some((a) => (form.needs?.[a] ?? 75) !== (character.needs?.[a] ?? 75))
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
          needs: form.needs ?? undefined,
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      const next = await r.json()
      setCharacter(next)
      // Re-sync form with the server's normalised response. Without
      // this, trim()/null-coercion on the bridge can leave form and
      // character disagreeing on whitespace or empty strings, which
      // keeps isDirty stuck at true and the Save button never flips
      // to "Saved". Symptom seen on prod: 4 PATCH calls in 6s because
      // the user kept hitting Save expecting the label to change.
      setForm((f) => ({
        ...f,
        name: next.name ?? f.name,
        about: next.about ?? '',
        state: next.state ?? '',
        model: next.model ?? '',
        harness: next.harness ?? 'direct',
        promptStyle: next.promptStyle ?? 'minimal',
        needs: { ...(f.needs || {}), ...(next.needs || {}) },
      }))
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
      let rawDelta = ''
      await streamGenerateProfile({
        bridgeUrl: cfg.bridgeUrl,
        pubkey,
        body: {
          seed: seed.trim() || undefined,
          overwriteName: true,
          model: genModel || undefined,
        },
        signal: ctrl.signal,
        onEvent: (evt, parsed) => {
          if (!parsed) return
          if (evt === 'model') {
            setStreamModel(parsed.model)
          } else if (evt === 'delta') {
            rawDelta += parsed.content ?? ''
            // Stream directly into the name + about inputs.
            const live = extractLivePersona(rawDelta)
            setForm((f) => ({
              ...f,
              name: live.name || f.name,
              about: live.about || f.about,
            }))
          } else if (evt === 'persona-done') {
            // Snap to the clean final values parsed on the server.
            setForm((f) => ({
              ...f,
              name: parsed.name ?? f.name,
              about: parsed.about ?? f.about,
            }))
          } else if (evt === 'avatar-start') {
            setAvatarLoading(true)
            setAvatarError(null)
          } else if (evt === 'avatar-done') {
            setAvatarLoading(false)
            setCharacter((prev) => ({ ...prev, avatarUrl: parsed.avatarUrl }))
          } else if (evt === 'avatar-error') {
            setAvatarLoading(false)
            setAvatarError(parsed.error || 'avatar generation failed')
          } else if (evt === 'done') {
            setCharacter((prev) => ({ ...prev, ...parsed }))
            onUpdated?.(parsed)
          }
        },
      })
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
        {/* Vitals — derived wellbeing badge + 2 needs bars + active
            moodlets. Live values poll every 4s. Character voice lives
            in `about`; there is no personality / vibe enum. */}
        <Vitals
          form={form}
          setForm={setForm}
          characterNeeds={character?.needs}
          live={liveNeeds}
          liveMood={liveMood}
          disabled={saving || generating}
          onNeedsChange={scheduleNeedsPersist}
        />
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

/**
 * Vitals — derived wellbeing badge + two needs axes (energy, social).
 * Mood / moodlets are layered on top by slice 4 of #275; this panel
 * owns the biological-pressure surface.
 *
 * Two modes, picked by whether the character is currently running:
 *   - RUNNING (live data present)  → read-only bars from the live
 *                                    tracker, polled every 4s. The
 *                                    server-side decay loop is the
 *                                    source of truth.
 *   - NOT RUNNING (no live data)   → sliders bound to form.needs.
 *                                    The user dials in INITIAL spawn
 *                                    values. Wellbeing badge updates
 *                                    live as you drag. Save persists
 *                                    via PATCH /characters/:pubkey.
 */
function Vitals({ form, setForm, characterNeeds, live, liveMood, disabled, onNeedsChange }) {
  // Editable when no live tracker entry — i.e. character isn't being
  // ticked yet. As soon as it spawns, /health/needs starts returning
  // data and the panel flips back to read-only bars.
  const editable = !live

  // For the badge / bars, prefer the freshest source available.
  const sourceNeeds = editable
    ? (form?.needs ?? characterNeeds)
    : (live?.needs ?? characterNeeds)
  const wellbeing = !editable && live?.wellbeing
    ? live.wellbeing
    : wellbeingFromNeeds(sourceNeeds)

  function setAxis(axis, value) {
    setForm((f) => {
      const nextNeeds = { ...(f?.needs || {}), [axis]: value }
      // Auto-persist the new needs vector so spawn picks them up
      // without requiring a separate Save click.
      onNeedsChange?.(nextNeeds)
      return { ...f, needs: nextNeeds }
    })
  }

  // Moodlets are an additional surface — independent of needs. The
  // mood band derives from sum-of-active-moodlets; we show it as a
  // small chip under the wellbeing badge so the two are legible at
  // a glance.
  const moodletsActive = liveMood?.active || []
  const moodBand = liveMood?.band || null

  return (
    <div className="agent-profile-vitals">
      <div className="agent-profile-vitals-row">
        <span className="agent-profile-field-label">Wellbeing</span>
        <span
          className={`agent-profile-wellbeing-badge wellbeing-${wellbeing}`}
          title={editable
            ? 'Initial wellbeing on spawn — drag the sliders to dial it in'
            : 'Derived from current needs (worst axis wins)'}
        >
          {wellbeing.replace('_', ' ')}
        </span>
        {moodBand && (
          <span
            className={`agent-profile-mood-badge mood-${moodBand}`}
            title="Mood — derived from the sum of active moodlets (event-driven, not decay)"
          >
            mood: {moodBand}
          </span>
        )}
      </div>
      <div className="agent-profile-needs-grid">
        {NEEDS_AXES.map((axis) => {
          const v = typeof sourceNeeds?.[axis] === 'number' ? Math.round(sourceNeeds[axis]) : null
          const tier = v == null ? null : v >= 50 ? 'thriving' : v >= 30 ? 'uneasy' : v >= 15 ? 'distressed' : 'in_crisis'
          return (
            <div key={axis} className={`agent-profile-need need-${axis}${tier ? ` tier-${tier}` : ''}${editable ? ' editable' : ''}`}>
              <span className="agent-profile-need-label">{axis}</span>
              {editable ? (
                <input
                  type="range"
                  min={0} max={100} step={1}
                  value={v ?? 75}
                  onChange={(e) => setAxis(axis, Number(e.target.value))}
                  disabled={disabled}
                  className="agent-profile-need-slider"
                  style={{ '--fill': `${v ?? 75}%` }}
                  aria-label={`set initial ${axis} need`}
                />
              ) : (
                <div className="agent-profile-need-bar">
                  <div className="agent-profile-need-fill" style={{ width: `${v ?? 0}%` }} />
                </div>
              )}
              <span className="agent-profile-need-value">{v ?? '—'}</span>
            </div>
          )
        })}
      </div>
      <Moodlets active={moodletsActive} />
    </div>
  )
}

/**
 * Active moodlets list — small chips beneath the needs bars showing
 * what's currently weighing on the character. Each chip carries a
 * signed-weight pill, the human reason, and a "fades in N" countdown.
 * Sticky moodlets (expires_at: null) show "ongoing" instead.
 *
 * Empty state collapses to a single muted line so the panel doesn't
 * flap height when the list is empty.
 */
function Moodlets({ active }) {
  const sorted = [...active].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  return (
    <div className="agent-profile-moodlets">
      <div className="agent-profile-moodlets-header">
        <span className="agent-profile-field-label">Moodlets</span>
        <span className="agent-profile-moodlets-count">{sorted.length || 'none active'}</span>
      </div>
      {sorted.length > 0 && (
        <ul className="agent-profile-moodlet-list">
          {sorted.map((m) => {
            const sign = m.weight >= 0 ? '+' : ''
            const polarity = m.weight > 0 ? 'positive' : m.weight < 0 ? 'negative' : 'neutral'
            return (
              <li key={m.id} className={`agent-profile-moodlet polarity-${polarity}`}>
                <span className={`agent-profile-moodlet-weight polarity-${polarity}`}>
                  {sign}{m.weight}
                </span>
                <span className="agent-profile-moodlet-reason" title={m.tag}>
                  {m.reason || m.tag}
                </span>
                <span className="agent-profile-moodlet-fade muted">
                  {fadesInLabel(m.expires_at)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function fadesInLabel(expiresAt) {
  if (expiresAt == null) return 'ongoing'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'fading'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'fades soon'
  if (min < 60) return `fades in ${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `fades in ${hr}h`
  const d = Math.floor(hr / 24)
  return `fades in ${d}d`
}
