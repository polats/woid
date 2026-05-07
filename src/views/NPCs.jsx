import { useEffect, useMemo, useState, useCallback } from 'react'
import config from '../config.js'
import AgentAssets from '../AgentAssets.jsx'
import Lightbox from '../components/Lightbox.jsx'
import { extractLivePersona, streamGenerateProfile } from '../lib/personaStream.js'

const cfg = config.agentSandbox || {}

// Time helpers — bridge stores shift_start/end as integer minutes since
// midnight (0..1439); native <input type="time"> uses "HH:MM" strings.
function minutesToTime(m) {
  if (m == null) return ''
  const v = Math.max(0, Math.min(1439, Math.round(m)))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
function timeToMinutes(s) {
  if (typeof s !== 'string' || !/^\d{1,2}:\d{2}$/.test(s)) return null
  const [h, m] = s.split(':').map(Number)
  return Math.max(0, Math.min(1439, h * 60 + m))
}

/**
 * NPC management view. Mirrors the agent-sandbox aesthetic — same
 * `.sandbox3` grid, same `.sandbox3-card` list items, same `+ New`
 * header pattern, same Drawer-style tab structure. Reuses
 * <AgentAssets> verbatim for the asset pipeline tab.
 */
export default function NPCs() {
  const bridgeUrl = cfg.bridgeUrl
  const [npcs, setNpcs] = useState([])
  const [rooms, setRooms] = useState([])
  const [error, setError] = useState(null)
  const [selectedPubkey, setSelectedPubkey] = useState(null)
  const [tab, setTab] = useState('profile')
  const [showSettings, setShowSettings] = useState(false)
  // Reset tab to Profile when the user switches NPC.
  useEffect(() => { setTab('profile') }, [selectedPubkey])

  // Persona prompt editor
  const [promptText, setPromptText] = useState('')
  const [promptDefault, setPromptDefault] = useState('')
  const [promptOverridden, setPromptOverridden] = useState(false)
  const [promptStatus, setPromptStatus] = useState(null)
  const promptDirty = promptText !== '' && promptText !== promptDefault

  const refreshNpcs = useCallback(async () => {
    if (!bridgeUrl) return
    try {
      const r = await fetch(`${bridgeUrl}/characters?kind=npc`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      setNpcs(json.characters || [])
    } catch (e) { setError(e.message || String(e)) }
  }, [bridgeUrl])

  const refreshPrompt = useCallback(async () => {
    if (!bridgeUrl) return
    try {
      const r = await fetch(`${bridgeUrl}/v1/prompts/npc-persona`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      setPromptText(json.text || '')
      setPromptDefault(json.default || '')
      setPromptOverridden(!!json.overridden)
    } catch (e) { setError(e.message || String(e)) }
  }, [bridgeUrl])

  useEffect(() => {
    fetch('/shelter-layout.json')
      .then((r) => r.json())
      .then((j) => setRooms(Array.isArray(j?.rooms) ? j.rooms : []))
      .catch(() => {})
  }, [])

  useEffect(() => { refreshNpcs(); refreshPrompt() }, [refreshNpcs, refreshPrompt])

  // Mirrors Sandbox.jsx newCharacter — POST immediately, refresh, select.
  // npc_role stays null (no uniqueness conflict); default position is
  // room-centre of the first available room. The user fills in role
  // and tweaks name from the Profile tab.
  async function newNpc() {
    setError(null)
    if (rooms.length === 0) {
      setError('No rooms in shelter-layout.json — add one before creating NPCs.')
      return
    }
    try {
      const r = await fetch(`${bridgeUrl}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'npc',
          npc_default_pos: { roomId: rooms[0].id, localU: 0.5, localV: 0.5 },
        }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${r.status}`)
      }
      const created = await r.json()
      await refreshNpcs()
      setSelectedPubkey(created.pubkey)
    } catch (e) { setError(e.message || String(e)) }
  }

  async function patchNpc(pubkey, patch) {
    const r = await fetch(`${bridgeUrl}/characters/${pubkey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${r.status}`)
    }
    await refreshNpcs()
  }

  // Persona-only streaming regen. Hits /generate-profile/stream with
  // skipAvatar:true so the avatar isn't touched. Live deltas flow into
  // `onDelta({ name, about })` so the Profile tab updates as tokens
  // arrive. Reuses the shared helpers in lib/personaStream.js.
  async function regeneratePersona(pubkey, seed, onDelta) {
    let rawDelta = ''
    await streamGenerateProfile({
      bridgeUrl,
      pubkey,
      body: {
        seed: seed?.trim() || undefined,
        overwriteName: true,
        skipAvatar: true,
      },
      onEvent: (evt, parsed) => {
        if (evt === 'delta' && parsed?.content) {
          rawDelta += parsed.content
          onDelta?.(extractLivePersona(rawDelta))
        } else if (evt === 'persona-done' && parsed) {
          onDelta?.({ name: parsed.name ?? '', about: parsed.about ?? '' })
        }
      },
    })
    await refreshNpcs()
  }

  // Avatar-only regen — uses /generate-avatar (the standalone endpoint
  // AgentProfile's "Regenerate avatar" button calls). `seed` is a soft
  // nudge appended to the default prompt; empty seed leaves the prompt
  // untouched so a fresh generation just reshuffles the image.
  async function regenerateAvatar(pubkey, seed) {
    const body = seed?.trim() ? { seed: seed.trim() } : {}
    const r = await fetch(`${bridgeUrl}/characters/${pubkey}/generate-avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${r.status}`)
    }
    await refreshNpcs()
  }

  async function deleteNpc(pubkey) {
    const npc = npcs.find((n) => n.pubkey === pubkey)
    const name = npc?.name || pubkey.slice(0, 8)
    if (!confirm(`Delete NPC "${name}"? This permanently removes the character record.`)) return
    try {
      const r = await fetch(`${bridgeUrl}/characters/${pubkey}`, { method: 'DELETE' })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${r.status}`)
      }
      if (selectedPubkey === pubkey) setSelectedPubkey(null)
      await refreshNpcs()
    } catch (e) { setError(e.message || String(e)) }
  }

  async function savePrompt() {
    setPromptStatus('saving…')
    try {
      const r = await fetch(`${bridgeUrl}/v1/prompts/npc-persona`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: promptText }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      setPromptText(json.text || '')
      setPromptOverridden(!!json.overridden)
      setPromptStatus('saved')
    } catch (e) { setPromptStatus(`error: ${e.message || String(e)}`) }
  }

  async function resetPromptToDefault() {
    setPromptStatus('resetting…')
    try {
      const r = await fetch(`${bridgeUrl}/v1/prompts/npc-persona`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      setPromptText(json.text || '')
      setPromptDefault(json.default || '')
      setPromptOverridden(false)
      setPromptStatus('reset')
    } catch (e) { setPromptStatus(`error: ${e.message || String(e)}`) }
  }

  const selected = useMemo(
    () => npcs.find((n) => n.pubkey === selectedPubkey) ?? null,
    [npcs, selectedPubkey],
  )

  if (!bridgeUrl) {
    return <div className="sandbox3"><p style={{ padding: 24 }}>Bridge URL not configured.</p></div>
  }

  return (
    <div className="sandbox3">
      <aside className="sandbox3-cards">
        <header>
          <h2>NPCs</h2>
          <div className="npcs-header-actions">
            <button onClick={newNpc} title="Create a new NPC">+ New</button>
            <button
              type="button"
              className={`npcs-settings-toggle${showSettings ? ' is-open' : ''}`}
              onClick={() => setShowSettings((v) => !v)}
              title={showSettings ? 'Hide settings' : 'NPC settings'}
              aria-expanded={showSettings}
            >
              <IconSettings />
            </button>
          </div>
        </header>
        {showSettings && (
          <div className="npcs-settings-pane">
            <PersonaPromptEditor
              text={promptText}
              setText={setPromptText}
              overridden={promptOverridden}
              dirty={promptDirty}
              status={promptStatus}
              onSave={savePrompt}
              onReset={resetPromptToDefault}
            />
          </div>
        )}
        {error && <p className="agent-sandbox-error">{error}</p>}
        {npcs.length === 0 ? (
          <p className="muted">No NPCs yet. Click + New to create one.</p>
        ) : (
          <ul className="sandbox3-card-list">
            {npcs.map((c) => {
              const initial = (c.name || '?').trim().charAt(0).toUpperCase()
              const isSelected = c.pubkey === selectedPubkey
              return (
                <li
                  key={c.pubkey}
                  className={`sandbox3-card${isSelected ? ' selected' : ''}`}
                  onClick={() => setSelectedPubkey(c.pubkey)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="sandbox3-card-portrait">
                    {c.avatarUrl ? (
                      <img src={c.avatarUrl} alt={c.name} draggable={false} />
                    ) : (
                      <div className="sandbox3-card-portrait-fallback">{initial}</div>
                    )}
                  </div>
                  <div className="sandbox3-card-body">
                    <div className="sandbox3-card-name">{c.name}</div>
                    <div className="sandbox3-card-tags">
                      <span
                        className="sandbox3-card-tag sandbox3-card-tag-harness"
                        title={c.npc_role ? `role: ${c.npc_role}` : 'no role yet'}
                      >
                        {c.npc_role || 'no role'}
                      </span>
                      {c.npc_default_pos?.roomId && (
                        <span className="sandbox3-card-tag sandbox3-card-tag-model" title={`room: ${c.npc_default_pos.roomId}`}>
                          {c.npc_default_pos.roomId}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      <main className="npcs-main">
        <NpcTabs tab={tab} setTab={setTab} disabled={!selected} />
        {selected ? (
          <NpcDetail
            tab={tab}
            npc={selected}
            rooms={rooms}
            bridgeUrl={bridgeUrl}
            onPatch={(patch) => patchNpc(selected.pubkey, patch)}
            onRegenPersona={(seed, onDelta) => regeneratePersona(selected.pubkey, seed, onDelta)}
            onRegenAvatar={(seed) => regenerateAvatar(selected.pubkey, seed)}
            onDelete={() => deleteNpc(selected.pubkey)}
            onClose={() => setSelectedPubkey(null)}
          />
        ) : (
          <section className="npcs-pane is-attached">
            <h2>No NPC selected</h2>
            <p className="muted">
              Click <strong>+ New</strong> in the sidebar to create one, or pick an existing
              NPC from the list. The persona prompt that drives generation lives behind
              the gear icon, top of the sidebar.
            </p>
          </section>
        )}
      </main>
    </div>
  )
}

/* ── Detail pane with tabs ─────────────────────────────────────── */

function NpcTabs({ tab, setTab, disabled }) {
  const tabs = [
    { id: 'profile', label: 'Profile', Icon: IconProfile },
    { id: 'assets', label: 'Assets', Icon: IconAssets },
    { id: 'schedule', label: 'Schedule', Icon: IconSchedule },
  ]
  return (
    <nav className="npcs-tabs" role="tablist">
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={`npcs-tab${tab === id ? ' active' : ''}`}
          onClick={() => setTab(id)}
          disabled={disabled}
        >
          <Icon /><span>{label}</span>
        </button>
      ))}
    </nav>
  )
}

function NpcDetail({ tab, npc, rooms, bridgeUrl, onPatch, onRegenPersona, onRegenAvatar, onDelete, onClose }) {
  const initial = (npc.name || '?').trim().charAt(0).toUpperCase()
  return (
    <section className="npcs-pane is-attached" role="tabpanel">
      <header className="npcs-pane-head">
        <div className="npcs-pane-portrait">
          {npc.avatarUrl
            ? <img src={npc.avatarUrl} alt={npc.name} />
            : <span>{initial}</span>}
        </div>
        <div className="npcs-pane-title">
          <strong>{npc.name}</strong>
          <div className="sandbox3-card-tags">
            <span className="sandbox3-card-tag sandbox3-card-tag-harness">
              {npc.npc_role || 'no role'}
            </span>
            {npc.npc_default_pos?.roomId && (
              <span className="sandbox3-card-tag sandbox3-card-tag-model">
                {npc.npc_default_pos.roomId}
              </span>
            )}
          </div>
          {npc.npub && (
            <code className="muted" style={{ fontSize: 10 }}>{npc.npub.slice(0, 16)}…</code>
          )}
        </div>
        <button type="button" className="npcs-btn" onClick={onClose} aria-label="close">×</button>
      </header>

      <div className="npcs-tab-panel">
        {tab === 'profile' && (
          <ProfileTab
            npc={npc}
            rooms={rooms}
            onPatch={onPatch}
            onRegenPersona={onRegenPersona}
            onRegenAvatar={onRegenAvatar}
            onDelete={onDelete}
          />
        )}
        {tab === 'assets' && <AgentAssets bridgeUrl={bridgeUrl} character={npc} />}
        {tab === 'schedule' && <ScheduleTab npc={npc} onPatch={onPatch} />}
      </div>
    </section>
  )
}

/* ── Profile tab ───────────────────────────────────────────────── */

function ProfileTab({ npc, rooms, onPatch, onRegenPersona, onRegenAvatar, onDelete }) {
  const [name, setName] = useState(npc.name || '')
  const [about, setAbout] = useState(npc.about || '')
  const [role, setRole] = useState(npc.npc_role || '')
  const [roomId, setRoomId] = useState(npc.npc_default_pos?.roomId || '')
  const [seed, setSeed] = useState('')
  const [avatarSeed, setAvatarSeed] = useState('')
  const [saveStatus, setSaveStatus] = useState(null)
  const [personaLoading, setPersonaLoading] = useState(false)
  const [personaStatus, setPersonaStatus] = useState(null)
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarStatus, setAvatarStatus] = useState(null)
  const [lightbox, setLightbox] = useState(null)  // { src, alt } | null

  // Re-sync local state when the underlying NPC changes (switch / regen).
  useEffect(() => {
    setName(npc.name || '')
    setAbout(npc.about || '')
    setRole(npc.npc_role || '')
    setRoomId(npc.npc_default_pos?.roomId || '')
  }, [npc.pubkey, npc.name, npc.about, npc.npc_role, npc.npc_default_pos?.roomId])

  const dirty = name !== (npc.name || '')
    || about !== (npc.about || '')
    || role !== (npc.npc_role || '')
    || roomId !== (npc.npc_default_pos?.roomId || '')

  async function save() {
    setSaveStatus('saving…')
    const patch = {}
    if (name !== (npc.name || '')) patch.name = name.trim() || null
    if (about !== (npc.about || '')) patch.about = about.trim() || null
    if (role !== (npc.npc_role || '')) patch.npc_role = role.trim() || null
    if (roomId !== (npc.npc_default_pos?.roomId || '')) {
      patch.npc_default_pos = roomId
        ? { roomId, localU: npc.npc_default_pos?.localU ?? 0.5, localV: npc.npc_default_pos?.localV ?? 0.5 }
        : null
    }
    try {
      await onPatch(patch)
      setSaveStatus('saved')
    } catch (e) { setSaveStatus(`error: ${e.message || String(e)}`) }
  }

  async function regenPersona() {
    setPersonaLoading(true)
    setPersonaStatus('regenerating…')
    try {
      // Stream deltas straight into the form so the user sees the
      // persona materialise. Snap to the final parsed values when
      // persona-done arrives.
      await onRegenPersona(seed, (live) => {
        if (live.name) setName(live.name)
        if (live.about) setAbout(live.about)
      })
      setPersonaStatus('done')
    } catch (e) { setPersonaStatus(`error: ${e.message || String(e)}`) }
    finally { setPersonaLoading(false) }
  }

  async function regenAvatar() {
    setAvatarLoading(true)
    setAvatarStatus('generating avatar…')
    try {
      await onRegenAvatar(avatarSeed)
      setAvatarStatus('done')
    } catch (e) { setAvatarStatus(`error: ${e.message || String(e)}`) }
    finally { setAvatarLoading(false) }
  }

  const initial = (name || '?').trim().charAt(0).toUpperCase()
  const hasAvatar = !!npc.avatarUrl

  return (
    <div className="npcs-profile">
      {/* All NPC config lives inside a single agent-profile-card, mirroring
          the agent sandbox: portrait + avatar regen on the left; name,
          about, persona regen, role + room, save on the right. */}
      <div className="agent-profile-card">
        <div className="agent-profile-card-top">
          <div className="agent-profile-card-portrait-col">
            <div
              className={`agent-profile-card-portrait${hasAvatar && !avatarLoading ? ' is-clickable' : ''}`}
              onClick={() => {
                if (!avatarLoading && hasAvatar) {
                  setLightbox({ src: npc.avatarUrl, alt: name || 'avatar' })
                }
              }}
              role={hasAvatar && !avatarLoading ? 'button' : undefined}
              tabIndex={hasAvatar && !avatarLoading ? 0 : undefined}
              title={hasAvatar && !avatarLoading ? 'Click to enlarge' : undefined}
            >
              {avatarLoading ? (
                <div className="agent-profile-card-portrait-spinner" aria-label="Generating avatar">
                  <div className="spinner" />
                </div>
              ) : hasAvatar ? (
                <img src={npc.avatarUrl} alt={name || 'avatar'} />
              ) : (
                <div className="agent-profile-card-portrait-fallback">{initial}</div>
              )}
            </div>
            <button
              type="button"
              onClick={regenAvatar}
              disabled={avatarLoading}
              className="agent-profile-avatar-btn"
            >
              {hasAvatar ? 'Regenerate avatar' : 'Generate avatar'}
            </button>
            <input
              type="text"
              className="npcs-avatar-seed"
              value={avatarSeed}
              onChange={(e) => setAvatarSeed(e.target.value)}
              placeholder="Avatar seed"
              title="Optional: a short nudge appended to the avatar prompt (e.g. 'glasses, calm, warm light')."
              disabled={avatarLoading}
            />
            {avatarStatus && <span className="npcs-status">{avatarStatus}</span>}
          </div>
          <div className="agent-profile-card-body">
            <input
              className="agent-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              maxLength={80}
              disabled={personaLoading}
            />
            <textarea
              className="agent-profile-about"
              rows={4}
              placeholder="Short bio."
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              disabled={personaLoading}
            />

            {/* Persona regen — sits directly below the about textarea.
                Seed input on the left, button on the right. */}
            <div className="npcs-persona-row">
              <input
                type="text"
                className="npcs-persona-seed"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="Persona seed (optional)"
                disabled={personaLoading}
              />
              <button
                type="button"
                className="agent-profile-avatar-btn"
                onClick={regenPersona}
                disabled={personaLoading}
              >
                {personaLoading ? 'Regenerating…' : 'Regenerate persona'}
              </button>
            </div>
            {personaStatus && <span className="npcs-status">{personaStatus}</span>}

            {/* Role + default room — same container, below persona regen. */}
            <label className="npcs-card-field">
              <span>Role</span>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="receptionist"
                disabled={personaLoading}
              />
            </label>
            <label className="npcs-card-field">
              <span>Default room</span>
              <select
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                disabled={personaLoading}
              >
                <option value="">— none —</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.id})
                  </option>
                ))}
              </select>
            </label>

            <div className="npcs-form-actions">
              <button
                type="button"
                className="npcs-btn primary"
                onClick={save}
                disabled={!dirty || personaLoading}
              >
                Save
              </button>
              {saveStatus && <span className="npcs-status">{saveStatus}</span>}
            </div>
          </div>
        </div>
      </div>

      <fieldset className="agent-profile-danger">
        <legend>Danger zone</legend>
        <p className="muted">
          Deletes this NPC's keypair, persona, generated avatar / model / rig,
          and any running runtime. Not recoverable.
        </p>
        <button type="button" onClick={onDelete} className="danger">
          Delete NPC
        </button>
      </fieldset>

      <Lightbox
        src={lightbox?.src}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </div>
  )
}

/* ── Schedule tab ──────────────────────────────────────────────── */

function ScheduleTab({ npc, onPatch }) {
  const [start, setStart] = useState(npc.shift_start)
  const [end, setEnd] = useState(npc.shift_end)
  const [status, setStatus] = useState(null)

  useEffect(() => {
    setStart(npc.shift_start)
    setEnd(npc.shift_end)
  }, [npc.pubkey, npc.shift_start, npc.shift_end])

  const dirty = start !== npc.shift_start || end !== npc.shift_end

  async function save() {
    setStatus('saving…')
    try {
      await onPatch({ shift_start: start, shift_end: end })
      setStatus('saved')
    } catch (e) { setStatus(`error: ${e.message || String(e)}`) }
  }

  async function clearShift() {
    setStatus('clearing…')
    setStart(null); setEnd(null)
    try {
      await onPatch({ shift_start: null, shift_end: null })
      setStatus('always present')
    } catch (e) { setStatus(`error: ${e.message || String(e)}`) }
  }

  const isAlwaysOn = start == null && end == null

  return (
    <div className="npcs-form">
      <p className="muted">
        When set, the NPC is only present in the facility between <strong>start</strong> and{' '}
        <strong>end</strong> (sim-time). Leave both empty to make the NPC always present.
      </p>
      <label>
        <span>Shift start</span>
        <input
          type="time"
          value={minutesToTime(start)}
          onChange={(e) => setStart(timeToMinutes(e.target.value))}
        />
      </label>
      <label>
        <span>Shift end</span>
        <input
          type="time"
          value={minutesToTime(end)}
          onChange={(e) => setEnd(timeToMinutes(e.target.value))}
        />
      </label>
      <div className="npcs-form-actions">
        <button type="button" className="npcs-btn primary" onClick={save} disabled={!dirty}>
          Save
        </button>
        <button type="button" className="npcs-btn" onClick={clearShift} disabled={isAlwaysOn}>
          Clear (always present)
        </button>
        {status && <span className="npcs-status">{status}</span>}
      </div>
    </div>
  )
}

/* ── Persona prompt editor ─────────────────────────────────────── */

function PersonaPromptEditor({ text, setText, overridden, dirty, status, onSave, onReset }) {
  return (
    <section className="npcs-pane">
      <h2>Persona prompt</h2>
      <p className="muted">
        System prompt used when generating an NPC's persona.{' '}
        {overridden
          ? <strong>Currently overridden.</strong>
          : <span>Currently the default.</span>}
      </p>
      <textarea
        className="npcs-prompt"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={14}
      />
      <div className="npcs-form-actions">
        <button type="button" className="npcs-btn primary" onClick={onSave} disabled={!dirty}>
          Save
        </button>
        <button type="button" className="npcs-btn" onClick={onReset} disabled={!overridden}>
          Reset to default
        </button>
        {status && <span className="npcs-status">{status}</span>}
      </div>
    </section>
  )
}

/* ── Icons (mirroring AgentDrawer) ─────────────────────────────── */

function IconProfile() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4.5 5-6.5 8-6.5s6.5 2 8 6.5" />
    </svg>
  )
}
function IconAssets() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="M3.5 16l5-5 4 4 3-3 5 5" />
      <circle cx="9" cy="9" r="1.5" />
    </svg>
  )
}
function IconSchedule() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}
