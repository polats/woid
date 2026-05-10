import { useEffect, useState } from 'react'
import ShelterRoomDetail from './ShelterRoomDetail.jsx'
import { ROOM_TYPES } from '../lib/shelterWorld/roomTypes.js'
import {
  ROOM_ASSET_STATUS,
  getAll as getAllAssets,
  subscribe as subRoomAssets,
  summarizeRoom as summarizeRoomAssets,
} from '../lib/roomAssetStore.js'
import {
  conceptUrl as conceptUrlFor,
  createInitialRoom,
  getInitialRoomPrompt,
  listLayouts,
  listLlmProviders,
  resetInitialRoomPrompt,
  setInitialRoomPrompt,
  setRoomStatus,
} from '../lib/roomLayoutStore.js'
import SplitButton from '../components/SplitButton.jsx'

/**
 * Dedicated /rooms page. Mirrors the NPCs view layout — left card list,
 * right detail panel — so the room previews, mockups, scene viewer, and
 * prop list have room to breathe instead of being squeezed into the
 * sandbox sidebar drawer.
 */
export default function Rooms() {
  const staticTypes = Object.values(ROOM_TYPES)
  const [bridgeLayouts, setBridgeLayouts] = useState([])
  const [selectedId, setSelectedId] = useState(staticTypes[0]?.id || null)
  const [, setTick] = useState(0)
  useEffect(() => subRoomAssets(() => setTick((t) => t + 1)), [])

  const refreshLayouts = async () => {
    const list = await listLayouts()
    setBridgeLayouts(list)
  }
  useEffect(() => { refreshLayouts() }, [])

  // Tab filter — three buckets:
  //   built-in : tutorial-bundled rooms from the static ROOM_TYPES
  //              catalogue (lobby, pattern-sorting, break-room).
  //   drafts   : LLM-generated rooms whose status is not 'added'.
  //   added    : LLM-generated rooms flagged 'added' (also visible in
  //              the shelter build menu).
  const [statusTab, setStatusTab] = useState('built-in')

  // Merge: bridge listing first (newest mtime first), then any static
  // rooms not yet on disk. The bridge already lists migrated rooms, so
  // most cards come from the bridge; statics serve as the fallback.
  const allCards = mergeRoomCards(bridgeLayouts, staticTypes)
  const cards = allCards.filter((c) => {
    if (statusTab === 'built-in') return !c.generated
    if (statusTab === 'added') return c.generated && c.status === 'added'
    return c.generated && c.status !== 'added'
  })
  const builtInCount = allCards.filter((c) => !c.generated).length
  const draftCount = allCards.filter((c) => c.generated && c.status !== 'added').length
  const addedCount = allCards.filter((c) => c.generated && c.status === 'added').length

  async function toggleRoomStatus(roomId, currentStatus) {
    const next = currentStatus === 'added' ? 'draft' : 'added'
    try {
      await setRoomStatus(roomId, next)
      await refreshLayouts()
    } catch (err) { console.error('[setRoomStatus]', err) }
  }

  const [showSettings, setShowSettings] = useState(false)

  // Right sidebar — Prop library. Vertical tab is always visible at
  // the page's right edge; clicking it toggles a 300px panel.
  const [propLibOpen, setPropLibOpen] = useState(false)
  const [assets, setAssets] = useState(() => getAllAssets())
  useEffect(() => subRoomAssets((s) => setAssets({ ...s })), [])

  return (
    <div className="rooms-page">
      <aside className="rooms-page-sidebar">
        <header>
          <h2>Rooms</h2>
          <div className="rooms-page-sidebar-actions">
            <small className="muted">{cards.length} rooms</small>
            <button
              type="button"
              className={`npcs-btn small${showSettings ? ' active' : ''}`}
              onClick={() => setShowSettings((v) => !v)}
              title="LLM settings"
            >
              ⚙
            </button>
          </div>
        </header>
        {showSettings && <LlmSettingsPanel onClose={() => setShowSettings(false)} />}
        <NewRoomFromPromptForm
          onCreated={(newId) => { setSelectedId(newId); refreshLayouts() }}
        />
        <nav className="rooms-status-tabs" role="tablist" aria-label="room status">
          <button
            type="button" role="tab"
            aria-selected={statusTab === 'built-in'}
            className={`rooms-status-tab${statusTab === 'built-in' ? ' active' : ''}`}
            onClick={() => setStatusTab('built-in')}
          >
            Built-in <span className="rooms-status-tab-count">{builtInCount}</span>
          </button>
          <button
            type="button" role="tab"
            aria-selected={statusTab === 'drafts'}
            className={`rooms-status-tab${statusTab === 'drafts' ? ' active' : ''}`}
            onClick={() => setStatusTab('drafts')}
          >
            Drafts <span className="rooms-status-tab-count">{draftCount}</span>
          </button>
          <button
            type="button" role="tab"
            aria-selected={statusTab === 'added'}
            className={`rooms-status-tab${statusTab === 'added' ? ' active' : ''}`}
            onClick={() => setStatusTab('added')}
          >
            Added <span className="rooms-status-tab-count">{addedCount}</span>
          </button>
        </nav>
        <ul className="sandbox3-card-list room-card-list">
          {cards.map((rt) => {
            const summary = summarizeRoomAssets(rt.id)
            const selected = selectedId === rt.id
            const palette = rt.palette || {}
            const wallHex = palette.wall || rt.color || '#c8c8be'
            const floorHex = palette.floor || '#a89878'
            const accentHex = palette.accent || '#c8a868'
            return (
              <li
                key={rt.id}
                className={`sandbox3-card room-card${selected ? ' selected' : ''}`}
                onClick={() => setSelectedId(rt.id)}
                role="button"
                tabIndex={0}
                title={rt.description}
              >
                <RoomCardThumb
                  roomId={rt.id}
                  fallbackColors={[wallHex, floorHex, accentHex]}
                />
                <div className="sandbox3-card-body">
                  <div className="sandbox3-card-name">{rt.name}</div>
                  {rt.vibe && <p className="sandbox3-card-about">{rt.vibe}</p>}
                  <div className="sandbox3-card-tags">
                    <span className="sandbox3-card-tag">{rt.category}</span>
                    <span className="sandbox3-card-tag" title="Tier">t{rt.tier}</span>
                    {summary.total > 0 && (
                      <span
                        className={`sandbox3-card-tag room-card-progress${
                          summary.ready === summary.total ? ' is-complete' : ''
                        }${summary.failed ? ' has-failed' : ''}${summary.inFlight ? ' in-flight' : ''}`}
                        title={
                          `${summary.ready} ready, ${summary.inFlight} in flight, `
                          + `${summary.failed} failed`
                        }
                      >
                        {summary.ready}/{summary.total} assets
                      </span>
                    )}
                  </div>
                  {rt.generated && (
                    <button
                      type="button"
                      className={`room-card-status-btn${rt.status === 'added' ? ' is-added' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleRoomStatus(rt.id, rt.status) }}
                      title={
                        rt.status === 'added'
                          ? 'Move back to drafts (hides from shelter build menu)'
                          : 'Add to shelter build menu'
                      }
                    >
                      {rt.status === 'added' ? '✓ added · move to drafts' : '+ add to shelter'}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </aside>

      <main className="rooms-page-main">
        <ShelterRoomDetail
          roomId={selectedId}
          onSelectRoom={(rid) => setSelectedId(rid)}
        />
      </main>

      <aside className="rooms-page-right">
        <button
          type="button"
          className={`rooms-page-right-tab${propLibOpen ? ' active' : ''}`}
          onClick={() => setPropLibOpen((v) => !v)}
          aria-label={propLibOpen ? 'Close prop library' : 'Open prop library'}
          title={propLibOpen ? 'Close prop library' : 'Open prop library'}
        >
          <span className="rooms-page-right-tab-arrow" aria-hidden="true">
            {propLibOpen ? '›' : '‹'}
          </span>
          <span className="rooms-page-right-tab-label">Props</span>
        </button>
        {propLibOpen && (
          <PropLibraryPanel
            assets={assets}
            onClose={() => setPropLibOpen(false)}
          />
        )}
      </aside>
    </div>
  )
}

// ─── Prop library (right sidebar) ────────────────────────────────

function PropLibraryPanel({ assets, onClose }) {
  // Show every prop with status:ready (i.e. has a generated GLB).
  // Each card is draggable; the 3D canvas's drop handler reads the
  // propId from the dataTransfer and clones it into the current layout.
  const ready = Object.entries(assets || {})
    .filter(([, a]) => a?.status === ROOM_ASSET_STATUS.ready)
    .map(([id, a]) => ({ id, ...a }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return (
    <div className="rooms-page-right-panel">
      <header>
        <h3>Prop library <small className="muted">{ready.length} ready</small></h3>
        <button type="button" className="room-detail-close" onClick={onClose} title="Close">×</button>
      </header>
      <p className="muted room-prop-library-help">
        Drag any prop into the 3D layout to add a copy at the drop point.
      </p>
      <ul className="room-prop-library-list">
        {ready.length === 0 && (
          <li className="muted room-prop-library-empty">
            No props with generated GLBs yet. Generate one from the Props sidebar
            and it'll appear here.
          </li>
        )}
        {ready.map((p) => (
          <li
            key={p.id}
            className="room-prop-library-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-woid-prop-id', p.id)
              e.dataTransfer.effectAllowed = 'copy'
              const img = e.currentTarget.querySelector('img')
              if (img) {
                try { e.dataTransfer.setDragImage(img, 24, 24) } catch {}
              }
            }}
            title={p.sourcePrompt || p.id}
          >
            <div className="room-prop-library-thumb">
              {p.imageUrl ? (
                <img src={p.imageUrl} alt={p.id} draggable={false} />
              ) : (
                <div className="room-prop-library-thumb-fallback">
                  {p.id.split('-').map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
                </div>
              )}
            </div>
            <div className="room-prop-library-body">
              <div className="room-prop-library-id">{p.id}</div>
              {p.sourceKind && (
                <span className="room-prop-library-kind">{p.sourceKind}</span>
              )}
              {p.sourcePrompt && (
                <p className="room-prop-library-prompt">{p.sourcePrompt}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Merge bridge-listed layouts with static seeds so the sidebar shows
 * everything: migrated statics (named via roomTypes when available),
 * LLM-generated rooms (only on the bridge), and any static room that
 * hasn't been migrated yet. Bridge order is newest-mtime-first.
 */
function mergeRoomCards(bridgeLayouts, staticTypes) {
  const byId = new Map(staticTypes.map((rt) => [rt.id, rt]))
  const seen = new Set()
  const cards = []
  for (const b of bridgeLayouts) {
    seen.add(b.id)
    const stat = byId.get(b.id)
    cards.push(stat ? { ...stat } : {
      id: b.id,
      name: b.name || b.id,
      vibe: 'generated',
      category: 'work',
      tier: 1,
      palette: {},
      props: [],
      generated: true,
      mtime: b.mtime,
      status: b.status || 'draft',
    })
  }
  for (const rt of staticTypes) {
    if (!seen.has(rt.id)) cards.push(rt)
  }
  return cards
}

// ─── New room prompt form ────────────────────────────────────────

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `room-${Date.now().toString(36)}`
}


function NewRoomFromPromptForm({ onCreated }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [error, setError] = useState(null)
  const [thinking, setThinking] = useState('')
  const [tokens, setTokens] = useState('')
  const [activeTab, setActiveTab] = useState('thinking') // 'thinking' | 'tokens'

  // LLM provider selection — same dropdown shape as the per-room
  // reroll buttons. Persists across sessions.
  const [providers, setProviders] = useState([])
  const [providerId, setProviderId] = useState(() => {
    try { return localStorage.getItem('woid:newRoomProvider') || 'default' } catch { return 'default' }
  })
  useEffect(() => {
    listLlmProviders().then(setProviders).catch(() => setProviders([]))
  }, [])
  useEffect(() => {
    try { localStorage.setItem('woid:newRoomProvider', providerId) } catch { /* ignore */ }
  }, [providerId])

  async function submit(e) {
    e?.preventDefault?.()
    if (!prompt.trim() || busy) return
    setBusy(true); setStage(null); setError(null); setThinking(''); setTokens('')
    // Slug derived from the first 5 words of the prompt + short ts
    // suffix so re-runs don't collide. The LLM may also propose its
    // own id, but the bridge forces ours.
    const slug = `${slugify(prompt.split(/\s+/).slice(0, 5).join(' '))}-${Date.now().toString(36).slice(-4)}`
    try {
      await createInitialRoom({
        roomId: slug,
        prompt,
        providerId,
        onProgress: (event, data) => {
          if (event === 'stage') {
            setStage(data.message || data.stage)
          } else if (event === 'thinking') {
            setThinking((t) => t + (data.text || ''))
            setActiveTab('thinking')
          } else if (event === 'token') {
            setTokens((t) => t + (data.text || ''))
            if (!data.text || data.text.length === 0) return
            setActiveTab((cur) => cur === 'thinking' ? 'tokens' : cur)
          }
        },
      })
      onCreated?.(slug)
      setPrompt('')
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  return (
    <form className="rooms-prompt-form" onSubmit={submit}>
      <label className="rooms-prompt-label">
        Generate room
        <textarea
          rows={2}
          placeholder="a cramped server closet"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className="rooms-prompt-actions">
        <SplitButton
          primary
          options={(providers.length ? providers : [{ id: 'default', label: 'Gemma 4 31B (self-hosted)' }]).map((p) => ({
            id: p.id,
            label: p.label,
            description: `${p.model || ''}${p.configured === false ? ' · not configured' : ''}`,
            disabled: p.configured === false,
          }))}
          selectedId={providerId}
          onSelect={setProviderId}
          onAction={() => submit()}
          disabled={busy || !prompt.trim()}
          title="Create a new room concept (name, description, prompt, palette + image). Layout structure is generated separately."
        >
          Generate
        </SplitButton>
        <small className="muted">
          {busy
            ? (stage || 'working…')
            : `via ${providers.find((p) => p.id === providerId)?.label || 'Gemma 4 31B'}`}
        </small>
      </div>
      {error && <p className="agent-sandbox-error">{error}</p>}
      {(thinking || tokens) && (
        <div className="rooms-prompt-stream">
          <nav className="rooms-prompt-stream-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'thinking'}
              className={`rooms-prompt-stream-tab${activeTab === 'thinking' ? ' active' : ''}`}
              onClick={() => setActiveTab('thinking')}
              disabled={!thinking}
            >
              Thinking{thinking ? ` (${thinking.length})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tokens'}
              className={`rooms-prompt-stream-tab${activeTab === 'tokens' ? ' active' : ''}`}
              onClick={() => setActiveTab('tokens')}
              disabled={!tokens}
            >
              Output{tokens ? ` (${tokens.length})` : ''}
            </button>
          </nav>
          <pre className="rooms-prompt-stream-pane">
            {activeTab === 'thinking' ? (thinking || '(no reasoning yet)') : (tokens || '(no output yet)')}
          </pre>
        </div>
      )}
    </form>
  )
}

// ─── LLM settings panel ──────────────────────────────────────────

function LlmSettingsPanel({ onClose }) {
  return (
    <section className="rooms-llm-settings">
      <header>
        <h3>Rooms settings</h3>
        <button type="button" className="room-detail-close" onClick={onClose} title="Close">×</button>
      </header>
      <InitialPromptEditor />
    </section>
  )
}

/**
 * Editor for the system prompt the bridge uses on /rooms/:id/initial.
 * Lets the user inspect / override / revert the default. Stored at
 * /workspace/initial-room-prompt.txt server-side.
 */
function InitialPromptEditor() {
  const [data, setData] = useState(null)  // { text, default, overridden }
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState(null)

  useEffect(() => {
    getInitialRoomPrompt().then((d) => {
      setData(d)
      setDraft(d?.text || '')
    }).catch((err) => setStatus(`error: ${err.message}`))
  }, [])

  const dirty = data && draft.trim() && draft !== data.text

  async function save() {
    setStatus('saving…')
    try {
      const next = await setInitialRoomPrompt(draft)
      setData(next)
      setStatus('saved')
      setTimeout(() => setStatus(null), 1500)
    } catch (err) {
      setStatus(`error: ${err.message}`)
    }
  }
  async function revert() {
    setStatus('reverting…')
    try {
      const next = await resetInitialRoomPrompt()
      setData(next)
      setDraft(next.text)
      setStatus('reverted')
      setTimeout(() => setStatus(null), 1500)
    } catch (err) {
      setStatus(`error: ${err.message}`)
    }
  }

  if (!data) return null
  return (
    <div className="rooms-initial-prompt-editor">
      <header>
        <h4>
          Initial room prompt
          <SourceTag s={data.overridden ? 'override' : 'env'} />
        </h4>
      </header>
      <p className="muted">
        System prompt sent to the LLM when you click <strong>Generate</strong>.
        Defines what fields the model returns (name, description, vibe, palette, FLUX prompt).
      </p>
      <textarea
        rows={10}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
      />
      <div className="rooms-llm-settings-actions">
        <button
          type="button"
          className="npcs-btn primary"
          onClick={save}
          disabled={!dirty}
        >
          Save
        </button>
        <button
          type="button"
          className="npcs-btn"
          onClick={revert}
          disabled={!data.overridden}
          title={data.overridden ? 'Revert to the built-in default' : 'Already on default'}
        >
          Revert to default
        </button>
        {status && <small className="muted">{status}</small>}
      </div>
    </div>
  )
}

function SourceTag({ s }) {
  return <span className={`rooms-llm-source-tag tag-${s}`}>{s}</span>
}

/**
 * Room thumbnail. Tries the concept mockup image first; falls back to
 * the palette stripe when the image 404s or hasn't been generated yet.
 */
function RoomCardThumb({ roomId, fallbackColors }) {
  const [imgOk, setImgOk] = useState(true)
  const url = conceptUrlFor(roomId)
  if (!imgOk || !url) {
    return (
      <div className="room-card-swatch">
        {(fallbackColors || []).map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </div>
    )
  }
  return (
    <div className="room-card-thumb">
      <img
        src={url}
        alt=""
        onError={() => setImgOk(false)}
        loading="lazy"
      />
    </div>
  )
}
