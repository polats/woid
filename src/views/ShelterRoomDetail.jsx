import { useEffect, useMemo, useRef, useState } from 'react'
import {
  TRIM_STYLES, CEILING_STYLES, FLOOR_STYLES,
} from '../lib/architecturalDetails.js'
import RoomPreview3D from './RoomPreview3D.jsx'
import Lightbox from '../components/Lightbox.jsx'
import {
  ROOM_LAYOUT_STATUS,
  conceptUrl as conceptUrlFor,
  fetchLayout,
  getLayout,
  listImageProviders,
  listLlmProviders,
  regenerateConcept,
  regenerateLayoutOnly,
  regeneratePromptAndPalette,
  saveLayout,
  subscribe as subLayouts,
} from '../lib/roomLayoutStore.js'
import SplitButton from '../components/SplitButton.jsx'
import GlbViewer from '../GlbViewer.jsx'
import {
  ROOM_SCENE_STATUS,
  generate as generateScene,
  getScene,
  refreshFromBridge as refreshScenesFromBridge,
  subscribe as subScenes,
} from '../lib/roomSceneStore.js'
import { ROOM_TYPES } from '../lib/shelterWorld/roomTypes.js'
import { PALETTE } from '../lib/shelterWorld/officeStyle.js'
import {
  ROOM_ASSET_STATUS,
  generate as generateAsset,
  generateRoom,
  getAll as getAllAssets,
  getRoomsForProp,
  refreshRoomFromBridge,
  reset as resetAsset,
  subscribe as subAssets,
  summarizeRoom,
} from '../lib/roomAssetStore.js'
import {
  ROOM_MOCK_STATUS,
  captureReferences as captureMockRefs,
  generate as generateMock,
  getMock,
  refreshFromBridge as refreshMocksFromBridge,
  reset as resetMock,
  subscribe as subMocks,
} from '../lib/roomMockStore.js'

/**
 * Drawer that opens when a Rooms-sidebar card is clicked. Layout:
 *   ┌──────────────────────────────────────┐
 *   │  Header (name + vibe + close)        │
 *   ├──────────────────────────────────────┤
 *   │  3D preview (interactive orbit)      │
 *   ├──────────────────────────────────────┤
 *   │  Palette swatches                    │
 *   ├──────────────────────────────────────┤
 *   │  Props list — thumbnail + status     │
 *   │  per row, with reuse badges          │
 *   ├──────────────────────────────────────┤
 *   │  Bulk actions (Generate all / Reset) │
 *   └──────────────────────────────────────┘
 */
export default function ShelterRoomDetail({ roomId, onSelectRoom }) {
  const [assets, setAssets] = useState(() => getAllAssets())
  const [selectedPropId, setSelectedPropId] = useState(null)
  const [transformMode, setTransformMode] = useState('translate')
  // Manual rebuild trigger — Apply palette bumps it so the gray-box
  // picks up the latest palette colours without the user clicking
  // Reroll graybox.
  const [previewRebuildKey, setPreviewRebuildKey] = useState(0)
  // Add a prop instance to the current layout from a drag-drop. The
  // source propId may already be used in this room, so we suffix to
  // make the new one unique. Size + kind + prompt come from the
  // source asset record (or the prop list of any room that uses it).
  async function addPropFromLibrary({ propId, position }) {
    const layout = getLayout(roomId)?.layout
    if (!layout) return
    const usedIds = new Set((layout.props || []).map((p) => p.id))
    let newId = propId
    let i = 2
    while (usedIds.has(newId)) { newId = `${propId}-${i}`; i += 1 }
    // Look for an existing instance of this prop in the current
    // layout to inherit size + prompt + kind. Otherwise use defaults.
    const seed = (layout.props || []).find((p) => p.id === propId || p.id.startsWith(`${propId}-`))
    const sourceAsset = assets[propId]
    // Resolve the asset to share until this duplicate gets its own
    // generation. Follow any existing chain so duplicates of duplicates
    // still point back at the original asset record.
    const sourceAssetId = seed?.sourceAssetId || propId
    const next = {
      id: newId,
      kind: seed?.kind || sourceAsset?.sourceKind || 'misc',
      prompt: seed?.prompt || sourceAsset?.sourcePrompt || propId.replace(/-/g, ' '),
      position: { x: position.x, y: position.y, z: position.z },
      rotation_y: 0,
      size: seed?.size || { w: 0.6, h: 0.7, d: 0.6 },
      materials: [],
      // Only set when this is actually a duplicate — if the propId
      // was free, the prop owns its own asset slot from the start.
      ...(newId !== propId ? { sourceAssetId } : {}),
    }
    try {
      await saveLayout({ ...layout, props: [...(layout.props || []), next] })
      setSelectedPropId(newId)
    } catch (err) { console.error('[saveLayout addProp]', err) }
  }
  // Clear prop selection when switching rooms.
  useEffect(() => { setSelectedPropId(null) }, [roomId])

  // Keyboard shortcuts (Unity / Maya convention): W=move, E=rotate, R=scale.
  useEffect(() => {
    if (!selectedPropId) return
    function onKey(e) {
      // Skip when typing in a text field
      if (e.target?.matches?.('input, textarea, [contenteditable]')) return
      if (e.key === 'w' || e.key === 'W') setTransformMode('translate')
      else if (e.key === 'e' || e.key === 'E') setTransformMode('rotate')
      else if (e.key === 'r' || e.key === 'R') setTransformMode('scale')
      else if (e.key === 'Escape') setSelectedPropId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedPropId])

  // Commit a transform from the 3D gizmo to the layout JSON. Reads
  // the freshest layout from the store (not the captured one) so
  // multiple drags in a row chain cleanly.
  async function commitPropTransform(propId, next) {
    const layout = getLayout(roomId)?.layout
    if (!layout) return
    try {
      await saveLayout({
        ...layout,
        props: layout.props.map((p) => p.id === propId ? { ...p, ...next } : p),
      })
    } catch (err) { console.error('[saveLayout transform]', err) }
  }

  // Layout-regen state lives at this level so both the Mockup section
  // (which previously hosted it) and the new gear overlay above the
  // 3D preview can reach it.
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [layoutStage, setLayoutStage] = useState(null)
  const [layoutThinking, setLayoutThinking] = useState('')
  const [layoutTokens, setLayoutTokens] = useState('')
  const [layoutProviders, setLayoutProviders] = useState([])
  const [layoutProviderId, setLayoutProviderId] = useState(() => {
    // k2-instruct is the bench winner: 100% reliable, ~5× faster than
    // Gemma. Frees Gemma up for the heavier prompt+palette flows.
    try { return localStorage.getItem('woid:layoutProvider') || 'nim-kimi-k2-instruct' } catch { return 'nim-kimi-k2-instruct' }
  })
  useEffect(() => {
    listLlmProviders().then(setLayoutProviders).catch(() => setLayoutProviders([]))
  }, [])
  useEffect(() => {
    try { localStorage.setItem('woid:layoutProvider', layoutProviderId) } catch { /* ignore */ }
  }, [layoutProviderId])

  async function regenerateLayout() {
    if (layoutBusy || !roomId) return
    setLayoutBusy(true)
    setLayoutStage(null)
    setLayoutThinking('')
    setLayoutTokens('')
    try {
      await regenerateLayoutOnly({
        roomId,
        providerId: layoutProviderId,
        onProgress: (event, data) => {
          if (event === 'stage') setLayoutStage(data.message || data.stage || '')
          else if (event === 'thinking') setLayoutThinking((s) => s + (data.text || ''))
          else if (event === 'token') setLayoutTokens((s) => s + (data.text || ''))
        },
      })
    } catch (err) {
      console.error('[regenerateLayout]', err)
    } finally {
      setLayoutBusy(false); setLayoutStage(null)
    }
  }

  useEffect(() => subAssets((s) => setAssets({ ...s })), [])
  // When this room opens, hydrate prop state from disk so previously
  // generated GLBs surface in the preview without needing a regen.
  useEffect(() => {
    if (roomId) refreshRoomFromBridge(roomId)
  }, [roomId])

  // Track layout state for the status badge in the header.
  const [layoutTick, setLayoutTick] = useState(0)
  useEffect(() => {
    if (!roomId) return
    fetchLayout(roomId)
    return subLayouts(() => setLayoutTick((t) => t + 1))
  }, [roomId])
  void layoutTick
  const layoutEntry = roomId ? getLayout(roomId) : null

  // Resolve the room data: prefer the static registry (richer gameplay
  // metadata) and fall back to the layout JSON (LLM-generated rooms
  // exist only on disk, not in ROOM_TYPES). When neither is loaded yet,
  // distinguish "no selection" from "loading".
  const staticRoom = roomId ? ROOM_TYPES[roomId] : null
  // Prefer the validated layout; fall back to rawLayout when validation
  // failed so a single bad re-roll doesn't make the whole room
  // inaccessible. The badge shows "invalid" so the user knows.
  const layoutForRender = layoutEntry?.layout || layoutEntry?.rawLayout || null
  // For static rooms the bridge layout is the source of truth once it
  // exists — overlay its palette / name / dimensions on top of the
  // catalogue entry so palette swatches reflect saved edits instead of
  // re-rendering the original ROOM_TYPES palette every time.
  // For built-in rooms the bridge layout is the source of truth once
  // it exists — overlay its palette / name / dimensions / props on top
  // of the catalogue entry so the editor reflects saved edits and
  // matches what the shelter renders (which also reads from the
  // bridge layout via addLayoutDressing).
  const room = staticRoom
    ? (layoutForRender
        ? {
            ...staticRoom,
            name: layoutForRender.name || staticRoom.name,
            palette: layoutForRender.palette || staticRoom.palette,
            dimensions: layoutForRender.dimensions || staticRoom.dimensions,
            // Prefer the placed props (what shelter actually renders);
            // fall back to proposedProps then the static catalogue.
            props: layoutForRender.props?.length
              ? layoutForRender.props
              : (layoutForRender.proposedProps?.length
                  ? layoutForRender.proposedProps
                  : staticRoom.props),
          }
        : staticRoom)
    : (layoutForRender ? roomFromLayout(layoutForRender) : null)

  const summary = useMemo(
    () => (room ? summarizeRoom(room.id) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room?.id, assets],
  )

  if (!roomId) {
    return (
      <div className="room-detail room-detail-empty">
        <p className="muted">Select a room from the list to inspect it.</p>
      </div>
    )
  }
  if (!room) {
    // Layout still loading or missing on disk.
    const loading = layoutEntry?.status === ROOM_LAYOUT_STATUS.loading
    return (
      <div className="room-detail room-detail-empty">
        <p className="muted">{loading ? 'Loading layout…' : `No layout found for "${roomId}".`}</p>
      </div>
    )
  }

  const palette = room.palette || {}

  return (
    <div className="room-detail" aria-label={`${room.name} details`}>
      <RoomDetailHeader
        room={room}
        layoutEntry={layoutEntry}
      />

      <ConceptSection
        roomId={room.id}
        layoutEntry={layoutEntry}
        layoutForRender={layoutForRender}
        selectedPropId={selectedPropId}
        palette={palette}
        onPaletteChange={async (label, hex) => {
          const cur = layoutForRender
          if (!cur) return
          try {
            await saveLayout({
              ...cur,
              palette: { ...cur.palette, [label]: hex },
            })
          } catch (err) { console.error('[saveLayout palette]', err) }
        }}
        onApplyPalette={() => setPreviewRebuildKey((k) => k + 1)}
        layoutProviders={layoutProviders}
        layoutProviderId={layoutProviderId}
        onLayoutProviderChange={setLayoutProviderId}
      />

      <section className="room-preview-row">
        <div className="room-preview-canvas">
          <RoomPreview3D
            roomId={room.id}
            room={room}
            interactive
            height={420}
            selectedPropId={selectedPropId}
            onPropSelect={setSelectedPropId}
            transformMode={transformMode}
            onPropTransform={commitPropTransform}
            rebuildKey={previewRebuildKey}
            onPropDrop={addPropFromLibrary}
          />
          {selectedPropId && (
            <div className="room-preview-transform-toolbar" role="toolbar" aria-label="Transform mode">
              <button
                type="button"
                className={`room-preview-transform-btn${transformMode === 'translate' ? ' active' : ''}`}
                onClick={() => setTransformMode('translate')}
                title="Move (W)"
              >⤢</button>
              <button
                type="button"
                className={`room-preview-transform-btn${transformMode === 'rotate' ? ' active' : ''}`}
                onClick={() => setTransformMode('rotate')}
                title="Rotate (E)"
              >⟳</button>
              <button
                type="button"
                className={`room-preview-transform-btn${transformMode === 'scale' ? ' active' : ''}`}
                onClick={() => setTransformMode('scale')}
                title="Scale (R)"
              >⊕</button>
              <span className="room-preview-transform-hint">W / E / R · Esc to deselect</span>
            </div>
          )}
          <LayoutJsonOverlay
            layout={layoutForRender}
            selectedPropId={selectedPropId}
            busy={layoutBusy}
            stage={layoutStage}
            thinking={layoutThinking}
            tokens={layoutTokens}
            providers={layoutProviders}
            providerId={layoutProviderId}
            onProviderChange={setLayoutProviderId}
            onRegenerate={regenerateLayout}
          />
        </div>
        <PropsSidebar
          room={room}
          summary={summary}
          assets={assets}
          selectedPropId={selectedPropId}
          onSelect={setSelectedPropId}
          onGenerateAll={() => generateRoom(room.id, {
            props: room.props,
            palette: room.palette,
          })}
          onRemoveProp={async (propId) => {
            const layout = getLayout(roomId)?.layout
            if (!layout) return
            try {
              await saveLayout({
                ...layout,
                props: (layout.props || []).filter((p) => p.id !== propId),
              })
              if (selectedPropId === propId) setSelectedPropId(null)
            } catch (err) { console.error('[saveLayout removeProp]', err) }
          }}
          onPropRename={async (oldId, rawNewId) => {
            const layout = getLayout(roomId)?.layout
            if (!layout) return
            const used = new Set((layout.props || []).map((p) => p.id))
            used.delete(oldId)
            const newId = uniquePropId(slugifyPropId(rawNewId) || oldId, used)
            if (newId === oldId) return
            try {
              await saveLayout({
                ...layout,
                props: (layout.props || []).map((p) =>
                  p.id === oldId ? { ...p, id: newId } : p,
                ),
              })
              if (selectedPropId === oldId) setSelectedPropId(newId)
            } catch (err) { console.error('[saveLayout rename]', err) }
          }}
          onPropPromptChange={async (propId, newPrompt) => {
            const layout = getLayout(roomId)?.layout
            if (!layout) return
            try {
              await saveLayout({
                ...layout,
                props: (layout.props || []).map((p) =>
                  p.id === propId ? { ...p, prompt: newPrompt } : p,
                ),
              })
            } catch (err) { console.error('[saveLayout prompt]', err) }
          }}
          onPropRegenerate={async (prop) => {
            // Versioned regenerate: gives the prop a fresh id (`-v2`, `-v3` …)
            // so the previous GLB stays in the library and can be dragged
            // back if the new render is worse. Then kicks off generation
            // under the new id.
            const layout = getLayout(roomId)?.layout
            if (!layout) return
            const used = new Set((layout.props || []).map((p) => p.id))
            used.delete(prop.id)
            const newId = nextVersionId(prop.id, used)
            try {
              await saveLayout({
                ...layout,
                props: (layout.props || []).map((p) =>
                  p.id === prop.id ? { ...p, id: newId } : p,
                ),
              })
              if (selectedPropId === prop.id) setSelectedPropId(newId)
              generateAsset(newId, prop.prompt, {
                kind: prop.kind,
                roomId: room.id,
                palette: room.palette,
              })
            } catch (err) { console.error('[regenerate prop]', err) }
          }}
        />
      </section>

    </div>
  )
}

// ─── prop row ────────────────────────────────────────────────────

function PropRow({ prop, status, ownRoomId, onSelectRoom }) {
  const sharedRooms = getRoomsForProp(prop.id).filter((id) => id !== ownRoomId)
  const s = status?.status || ROOM_ASSET_STATUS.idle
  const inFlight =
    s === ROOM_ASSET_STATUS.queued
    || s === ROOM_ASSET_STATUS.generatingImage
    || s === ROOM_ASSET_STATUS.generatingModel

  return (
    <li className={`room-prop-row status-${s}`}>
      <div className="room-prop-thumb">
        {status?.imageUrl ? (
          <img src={status.imageUrl} alt={prop.id} />
        ) : (
          <div className="room-prop-thumb-fallback">{prop.id.split('-').map((w) => w[0]).join('').slice(0, 3).toUpperCase()}</div>
        )}
        <span className={`room-prop-slot slot-${prop.slot}`}>{prop.slot}</span>
      </div>
      <div className="room-prop-body">
        <div className="room-prop-name">
          {prop.id}
          {prop.count > 1 && <span className="room-prop-count">×{prop.count}</span>}
        </div>
        <div className="room-prop-prompt" title={prop.prompt}>{prop.prompt}</div>
        <div className="room-prop-meta">
          <PropStatusPill status={s} error={status?.error} />
          {sharedRooms.length > 0 && (
            <span className="room-prop-shared" title={`Reused in: ${sharedRooms.join(', ')}`}>
              shared with {sharedRooms.length} room{sharedRooms.length === 1 ? '' : 's'}
              <span className="room-prop-shared-list">
                {sharedRooms.map((rid) => (
                  <button
                    type="button"
                    key={rid}
                    className="room-prop-shared-link"
                    onClick={() => onSelectRoom?.(rid)}
                    title={`Open ${ROOM_TYPES[rid]?.name || rid}`}
                  >
                    {ROOM_TYPES[rid]?.name || rid}
                  </button>
                ))}
              </span>
            </span>
          )}
        </div>
      </div>
      <div className="room-prop-actions">
        {s === ROOM_ASSET_STATUS.ready ? (
          <button type="button" className="npcs-btn" onClick={() => { resetAsset(prop.id); generateAsset(prop.id, prop.prompt, { kind: prop.kind }) }}>Regenerate</button>
        ) : inFlight ? (
          <button type="button" className="npcs-btn" disabled>…</button>
        ) : (
          <button type="button" className="npcs-btn primary" onClick={() => generateAsset(prop.id, prop.prompt, { kind: prop.kind })}>Generate</button>
        )}
      </div>
    </li>
  )
}

function PropStatusPill({ status, error }) {
  const label = {
    [ROOM_ASSET_STATUS.idle]: 'not generated',
    [ROOM_ASSET_STATUS.queued]: 'queued',
    [ROOM_ASSET_STATUS.generatingImage]: 'flux…',
    [ROOM_ASSET_STATUS.generatingModel]: 'trellis…',
    [ROOM_ASSET_STATUS.ready]: 'ready',
    [ROOM_ASSET_STATUS.failed]: error ? `failed: ${error}` : 'failed',
  }[status] || status
  return <span className={`room-prop-pill pill-${status}`}>{label}</span>
}

// ─── palette ─────────────────────────────────────────────────────

// ─── architecture picker ──────────────────────────────────────────

function ArchitectureRow({ architecture, onChange }) {
  // Three small dropdowns — trim / ceiling / floor — under the palette.
  // Empty value === 'auto' (the category preset's choice). Persists
  // through saveLayout into layout.architecture.
  const rows = [
    { key: 'trim', label: 'Trim', options: TRIM_STYLES },
    { key: 'ceiling', label: 'Ceiling', options: CEILING_STYLES },
    { key: 'floor', label: 'Floor', options: FLOOR_STYLES },
  ]
  return (
    <div className="room-mockup-architecture-row">
      {rows.map((r) => (
        <label key={r.key} className="room-architecture-control">
          <small>{r.label}</small>
          <select
            value={architecture[r.key] || ''}
            onChange={(e) => onChange(r.key, e.target.value)}
          >
            <option value="">auto (category)</option>
            {r.options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </label>
      ))}
    </div>
  )
}

function paletteEntries(palette) {
  // Five named swatches: wall, floor, accent, ceiling, trim. Each one
  // prefers the room's override (so colour-picker edits stick) and
  // falls back to the global PALETTE default when missing.
  const entries = []
  entries.push(['wall', palette.wall || '#888888'])
  entries.push(['floor', palette.floor || '#888888'])
  entries.push(['accent', palette.accent || '#888888'])
  entries.push(['ceiling', palette.ceiling || PALETTE.ceilingTile])
  entries.push(['trim', palette.trim || PALETTE.trimWood])
  return entries
}

function PaletteSwatch({ label, hex, onChange, pickingLabel, onArmPick }) {
  // Native color picker. The <input type="color"> doubles as the chip;
  // CSS strips the browser frame so it reads as a flat color square.
  // Eyedropper: arms a pick mode that the mockup image listens to —
  // implemented via canvas pixel sampling so it works on every browser
  // (the native window.EyeDropper API isn't widely available yet).
  const armed = pickingLabel === label
  return (
    <div className="room-palette-swatch-row">
      <label className="room-palette-swatch" title={`${label} ${hex} — click to change`}>
        <input
          type="color"
          className="room-palette-chip"
          value={normaliseHex(hex)}
          onChange={(e) => onChange?.(label, e.target.value)}
          disabled={!onChange}
          aria-label={`${label} colour`}
        />
        <small>{label}</small>
        <code>{hex}</code>
      </label>
      <button
        type="button"
        className={`room-palette-eyedropper${armed ? ' armed' : ''}`}
        onClick={() => onArmPick?.(armed ? null : label)}
        disabled={!onChange || !onArmPick}
        title={armed ? 'Click the mockup to pick — click again to cancel' : 'Pick a colour from the mockup'}
        aria-label={`Pick ${label} colour from mockup`}
        aria-pressed={armed}
      >
        💧
      </button>
    </div>
  )
}

function normaliseHex(s) {
  // <input type="color"> requires #rrggbb. Lowercase, default if invalid.
  if (typeof s !== 'string') return '#888888'
  const m = s.match(/^#([0-9a-f]{6})$/i)
  return m ? `#${m[1].toLowerCase()}` : '#888888'
}

// ─── Mocks section ───────────────────────────────────────────────

function MockSection({ roomId }) {
  const [mock, setMock] = useState(() => getMock(roomId))
  useEffect(() => {
    setMock(getMock(roomId))
    refreshMocksFromBridge(roomId)
    return subMocks(() => setMock(getMock(roomId)))
  }, [roomId])

  const status = mock?.status || ROOM_MOCK_STATUS.idle
  const refs = mock?.references || []
  const outputs = mock?.outputs || []
  const busy =
    status === ROOM_MOCK_STATUS.capturing
    || status === ROOM_MOCK_STATUS.generating

  return (
    <section className="room-detail-section room-mock-section">
      <div className="room-detail-section-head">
        <h3>
          Mocks
          <small className="muted">
            {status === ROOM_MOCK_STATUS.idle && 'no references yet'}
            {status === ROOM_MOCK_STATUS.capturing && 'capturing references…'}
            {status === ROOM_MOCK_STATUS.captured && `${refs.length} references ready`}
            {status === ROOM_MOCK_STATUS.generating && 'flux-kontext is composing…'}
            {status === ROOM_MOCK_STATUS.ready && `${outputs.length} mockup${outputs.length === 1 ? '' : 's'}`}
            {status === ROOM_MOCK_STATUS.failed && (mock?.error || 'failed')}
          </small>
        </h3>
        <div className="room-detail-actions">
          <button
            type="button"
            className="npcs-btn"
            disabled={busy}
            onClick={() => captureMockRefs(roomId)}
            title="Render the 3D preview from 4 angles for use as FLUX references"
          >
            Capture refs
          </button>
          <button
            type="button"
            className="npcs-btn primary"
            disabled={busy}
            onClick={() => generateMock(roomId)}
            title="Send references + prompt to FLUX-Kontext to produce a 2D mockup"
          >
            Generate mock
          </button>
          {(refs.length > 0 || outputs.length > 0) && !busy && (
            <button
              type="button"
              className="npcs-btn"
              onClick={() => resetMock(roomId)}
              title="Clear references and mockups"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {refs.length > 0 && (
        <>
          <h4 className="room-mock-subhead">References ({refs.length})</h4>
          <div className="room-mock-refs">
            {refs.map((r) => (
              <figure key={r.angle} className="room-mock-ref-thumb">
                <img src={r.dataUri} alt={r.angle} />
                <figcaption>{r.angle}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}

      {outputs.length > 0 && (
        <>
          <h4 className="room-mock-subhead">Mockup output</h4>
          <div className="room-mock-outputs">
            {outputs.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer" className="room-mock-output">
                <img src={url} alt={`mockup ${i + 1}`} />
              </a>
            ))}
          </div>
        </>
      )}

      {mock?.prompt && (
        <details className="room-mock-prompt">
          <summary>Prompt sent to FLUX</summary>
          <pre>{mock.prompt}</pre>
        </details>
      )}

      {refs.length === 0 && outputs.length === 0 && (
        <p className="muted room-mock-help">
          Capture references first to render the 3D shell from multiple angles, then Generate to ship them
          to FLUX-Kontext along with the prop list. The mockup informs the per-prop generation below.
        </p>
      )}
    </section>
  )
}

// ─── Scene section ───────────────────────────────────────────────

function SceneSection({ roomId }) {
  const [scene, setScene] = useState(() => getScene(roomId))
  useEffect(() => {
    setScene(getScene(roomId))
    refreshScenesFromBridge(roomId)
    return subScenes(() => setScene(getScene(roomId)))
  }, [roomId])

  const status = scene?.status || ROOM_SCENE_STATUS.idle
  const busy = status === ROOM_SCENE_STATUS.generating

  return (
    <section className="room-detail-section room-scene-section">
      <div className="room-detail-section-head">
        <h3>
          3D Scene
          <small className="muted">
            {status === ROOM_SCENE_STATUS.idle && 'no 3D yet'}
            {status === ROOM_SCENE_STATUS.generating && (scene?.stageMessage || 'trellis is working…')}
            {status === ROOM_SCENE_STATUS.ready && 'ready'}
            {status === ROOM_SCENE_STATUS.failed && (scene?.error || 'failed')}
          </small>
        </h3>
        <div className="room-detail-actions">
          <button
            type="button"
            className="npcs-btn primary"
            disabled={busy}
            onClick={() => generateScene(roomId)}
            title="Run TRELLIS over the latest mockup to produce a single GLB scene"
          >
            {status === ROOM_SCENE_STATUS.ready ? 'Regenerate scene' : 'Generate scene'}
          </button>
        </div>
      </div>
      {scene?.modelUrl ? (
        <div className="room-scene-viewer">
          <GlbViewer src={scene.modelUrl} autoRotate />
        </div>
      ) : (
        <p className="muted room-scene-help">
          {status === ROOM_SCENE_STATUS.generating
            ? 'TRELLIS cold-starts can take 30–90s. Heartbeat pings the bridge every 5s.'
            : 'Generate a mock first, then run it through TRELLIS to produce a single GLB of the room.'}
        </p>
      )}
    </section>
  )
}

// ─── layout status badge ─────────────────────────────────────────

function LayoutBadge({ entry }) {
  if (!entry) return null
  const s = entry.status
  if (s === ROOM_LAYOUT_STATUS.ready) {
    const n = entry.layout?.props?.length ?? 0
    return <span className="room-layout-badge ok" title={`Layout loaded · ${n} props`}>layout</span>
  }
  if (s === ROOM_LAYOUT_STATUS.loading) {
    return <span className="room-layout-badge loading" title="Loading layout">…</span>
  }
  if (s === ROOM_LAYOUT_STATUS.missing) {
    return <span className="room-layout-badge missing" title="No layout on disk — using fallback">no layout</span>
  }
  if (s === ROOM_LAYOUT_STATUS.invalid) {
    return <span className="room-layout-badge bad" title={(entry.errors || []).join('; ')}>invalid</span>
  }
  if (s === ROOM_LAYOUT_STATUS.error) {
    return <span className="room-layout-badge bad" title={(entry.errors || []).join('; ')}>error</span>
  }
  return null
}

// ─── Concept image section ───────────────────────────────────────

function ConceptSection({ roomId, layoutEntry, palette, onPaletteChange, onApplyPalette, layoutProviders, layoutProviderId, onLayoutProviderChange }) {
  // Mirror the parent's fallback so saveLayout-driven edits (palette,
  // architecture) read the validated layout when present, the raw one
  // when validation failed.
  const layoutForRender = layoutEntry?.layout || layoutEntry?.rawLayout || null
  // Eyedropper: which palette slot is awaiting a pick. While set, the
  // mockup img's click handler samples the clicked pixel from a hidden
  // canvas (img drawn at naturalWidth/Height) and commits it.
  const [pickingLabel, setPickingLabel] = useState(null)
  const mockupImgRef = useRef(null)
  const pickFromMockup = (e) => {
    if (!pickingLabel) return
    const img = mockupImgRef.current
    if (!img?.complete || !img.naturalWidth) return
    const rect = img.getBoundingClientRect()
    const xRel = (e.clientX - rect.left) / rect.width
    const yRel = (e.clientY - rect.top) / rect.height
    if (xRel < 0 || xRel > 1 || yRel < 0 || yRel > 1) return
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    try {
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(
        Math.floor(xRel * img.naturalWidth),
        Math.floor(yRel * img.naturalHeight),
        1, 1,
      )
      const hex = '#' + [data[0], data[1], data[2]]
        .map((v) => v.toString(16).padStart(2, '0')).join('')
      onPaletteChange?.(pickingLabel, hex)
    } catch (err) {
      // CORS taint — fall back to a status nudge. Bridge already
      // sends Access-Control-Allow-Origin so this is rare.
      console.warn('[eyedropper] canvas read failed:', err?.message || err)
    }
    setPickingLabel(null)
  }
  const layout = layoutEntry?.layout
  const fluxPrompt = layout?.fluxPrompt || ''
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [draftPrompt, setDraftPrompt] = useState(fluxPrompt)

  // Prompt+palette reroll state — shares the LLM provider list with
  // the layout regen since both call Gemma.
  const [promptRerollBusy, setPromptRerollBusy] = useState(false)
  const [promptStage, setPromptStage] = useState(null)
  const [promptThinking, setPromptThinking] = useState('')
  const [promptTokens, setPromptTokens] = useState('')

  async function rerollPromptFromTitle() {
    if (promptRerollBusy) return
    setPromptRerollBusy(true)
    setError(null)
    setPromptStage(null)
    setPromptThinking('')
    setPromptTokens('')
    try {
      await regeneratePromptAndPalette({
        roomId,
        providerId: layoutProviderId,
        onProgress: (event, data) => {
          if (event === 'stage') setPromptStage(data.message || data.stage || '')
          else if (event === 'thinking') setPromptThinking((s) => s + (data.text || ''))
          else if (event === 'token') setPromptTokens((s) => s + (data.text || ''))
        },
      })
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setPromptRerollBusy(false)
      setPromptStage(null)
    }
  }
  // Image provider picker — fetched from the bridge's IMAGE_PROVIDERS
  // registry. Persists across renders via localStorage so the user's
  // pick sticks. flux.1-schnell is the default.
  const [imageProviders, setImageProviders] = useState([])
  const [imageProviderId, setImageProviderId] = useState(() => {
    try { return localStorage.getItem('woid:imageProvider') || 'flux.1-schnell' } catch { return 'flux.1-schnell' }
  })
  useEffect(() => {
    listImageProviders().then(setImageProviders).catch(() => setImageProviders([]))
  }, [])
  useEffect(() => {
    try { localStorage.setItem('woid:imageProvider', imageProviderId) } catch { /* ignore */ }
  }, [imageProviderId])
  // The image URL is stored explicitly so a re-roll's response URL
  // (which the bridge stamps with a fresh cache-buster) overrides the
  // initial url derived from layoutEntry.mtime. Mirrors the agent
  // avatar pattern: trust whatever URL the bridge hands back.
  const [imageUrl, setImageUrl] = useState(() => conceptUrlFor(roomId, layoutEntry?.mtime))

  // Sync the draft when switching rooms / on save.
  useEffect(() => { setDraftPrompt(fluxPrompt) }, [fluxPrompt, roomId])
  // Re-seed imageUrl ONLY when switching rooms — layout mtime changes
  // on every prop / palette / name edit, but those don't change the
  // concept image bytes. Tying imageUrl to layout.mtime caused a brief
  // flash on every palette pick. Concept regen calls setImageUrl()
  // directly with the bridge's freshly cache-busted URL.
  useEffect(() => {
    setImageUrl(conceptUrlFor(roomId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  const dirty = draftPrompt !== fluxPrompt && draftPrompt.trim().length > 0
  const [lightboxOpen, setLightboxOpen] = useState(false)

  async function rollImage() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await regenerateConcept({
        roomId,
        // If the user has unsaved edits, persist them as part of this
        // re-roll. Otherwise just use the stored prompt with a new seed.
        prompt: dirty ? draftPrompt : undefined,
        persistPrompt: dirty,
        imageProviderId,
      })
      // The bridge response URL already includes a `?t=<ms>` buster.
      if (result?.url) setImageUrl(result.url)
      if (dirty) await fetchLayout(roomId)
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="room-detail-section room-mockup-section">
      <h3 className="room-mockup-header">Mockup</h3>
      <div className="room-mockup-grid">
        <div className="room-mockup-left">
          <div className="room-mockup-prompt-panel">
            <div className="room-mockup-prompt-head">
              <span className="room-json-summary">
                Prompt
                <small className="muted">{draftPrompt.length} chars</small>
              </span>
            </div>
            <textarea
              className="room-concept-prompt-input"
              value={draftPrompt}
              placeholder={fluxPrompt ? '' : 'No FLUX prompt yet — type one and re-roll'}
              onChange={(e) => setDraftPrompt(e.target.value)}
              disabled={busy}
              spellCheck={false}
              aria-label="FLUX prompt — click to edit"
            />
          </div>
          {palette && (
            <div className="room-mockup-architecture">
              <div className="room-mockup-palette-head">
                <span className="room-json-summary">Architecture</span>
              </div>
              <ArchitectureRow
                architecture={layoutForRender?.architecture || {}}
                onChange={async (field, value) => {
                  const cur = layoutForRender
                  if (!cur) return
                  const next = { ...(cur.architecture || {}) }
                  if (value) next[field] = value
                  else delete next[field]
                  try {
                    await saveLayout({ ...cur, architecture: next })
                  } catch (err) { console.error('[saveLayout arch]', err) }
                }}
              />
            </div>
          )}
          {palette && (
            <div className="room-mockup-palette">
              <div className="room-mockup-palette-head">
                <span className="room-json-summary">Palette</span>
              </div>
              <div className="room-mockup-palette-row">
                {paletteEntries(palette).map(([label, hex]) => (
                  <PaletteSwatch
                    key={label}
                    label={label}
                    hex={hex}
                    onChange={onPaletteChange}
                    pickingLabel={pickingLabel}
                    onArmPick={setPickingLabel}
                  />
                ))}
              </div>
              {onApplyPalette && (
                <div className="room-mockup-palette-actions">
                  <button
                    type="button"
                    className="npcs-btn small"
                    onClick={onApplyPalette}
                    title="Re-render the 3D view with the current palette colours"
                  >
                    Apply palette to 3D
                  </button>
                </div>
              )}
            </div>
          )}
          <PromptPaletteRerollFooter
            busy={promptRerollBusy}
            stage={promptStage}
            thinking={promptThinking}
            tokens={promptTokens}
            providers={layoutProviders}
            providerId={layoutProviderId}
            onProviderChange={onLayoutProviderChange}
            onAction={rerollPromptFromTitle}
          />
        </div>
        <div className="room-mockup-right">
          <div className="room-mockup-image-cell">
            {fluxPrompt && imageUrl ? (
              <button
                type="button"
                className={`room-mockup-image-btn${pickingLabel ? ' picking' : ''}`}
                onClick={(e) => {
                  if (pickingLabel) { pickFromMockup(e); return }
                  setLightboxOpen(true)
                }}
                title={pickingLabel
                  ? `Click anywhere on the mockup to sample ${pickingLabel}`
                  : 'Click to view full-size'}
                aria-label={pickingLabel ? `Pick ${pickingLabel} from mockup` : 'Open mockup full-size'}
              >
                <img
                  key={imageUrl}
                  ref={mockupImgRef}
                  src={imageUrl}
                  alt="mockup"
                  className={`room-mockup-image${pickingLabel ? ' picking' : ''}`}
                  crossOrigin="anonymous"
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              </button>
            ) : (
              <p className="muted room-concept-help">No mockup yet.</p>
            )}
            {busy && (
              <div className="room-mockup-image-overlay" aria-label="Re-rolling mockup">
                <div className="spinner" />
              </div>
            )}
          </div>
          <div className="room-mockup-action-row">
            <SplitButton
              primary={dirty}
              disabled={busy || !draftPrompt.trim()}
              options={(imageProviders.length ? imageProviders : [{ id: 'flux.1-schnell', label: 'FLUX.1 schnell (NIM, fast)' }]).map((p) => ({
                id: p.id,
                label: p.label,
                description: `${p.model || ''}${p.steps ? ` · ${p.steps} steps` : ''}${p.configured === false ? ' · not configured' : ''}`,
                disabled: p.configured === false,
              }))}
              selectedId={imageProviderId}
              onSelect={setImageProviderId}
              onAction={rollImage}
              title={dirty ? 'Save edited prompt and reroll' : 'Reroll image, same prompt + new seed'}
            >
              {dirty ? 'Save & reroll image' : 'Reroll image'}
            </SplitButton>
            <small className="muted room-mockup-provider-hint">
              {busy ? 'working…' : 'via '}
              {(imageProviders.find((p) => p.id === imageProviderId)?.label) || 'FLUX.1 schnell'}
            </small>
          </div>
        </div>
      </div>
      {error && <p className="agent-sandbox-error">{error}</p>}
      {lightboxOpen && imageUrl && (
        <Lightbox src={imageUrl} alt="mockup" onClose={() => setLightboxOpen(false)} />
      )}
    </section>
  )
}

/** Floating gear-toggled panel anchored to the top-left of the 3D
 *  preview canvas. Two states: collapsed (compact) and expanded
 *  (taller JSON pane). Holds the layout JSON view + Reroll graybox
 *  split-button. Closing returns to a single floating ⚙ button. */
function LayoutJsonOverlay({
  layout,
  selectedPropId,
  busy,
  stage,
  thinking,
  tokens,
  providers,
  providerId,
  onProviderChange,
  onRegenerate,
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const propCount = (layout?.props || []).length

  if (!open) {
    // When the room has no layout yet, swap the dice for a construction
    // icon + an amber pulsing ring so the user is nudged to generate.
    // Once a layout exists the button reverts to a quiet dice (reroll).
    const empty = propCount === 0
    return (
      <button
        type="button"
        className={`room-preview-gear room-preview-dice${empty ? ' room-preview-gear-empty' : ''}`}
        onClick={() => setOpen(true)}
        aria-label={empty ? 'Generate layout to see the 3D map' : 'Open layout settings'}
        title={empty ? 'Generate layout to see the 3D map' : 'Layout JSON + reroll graybox'}
      >
        {empty ? '🏗️' : '🎲'}
      </button>
    )
  }

  const options = (providers && providers.length)
    ? providers.map((p) => ({
        id: p.id,
        label: p.label,
        description: `${p.model || ''}${p.configured ? '' : ' · not configured'}`,
        disabled: !p.configured,
      }))
    : [{ id: 'default', label: 'Gemma 4 31B (self-hosted)' }]
  const activeProvider = providers.find((p) => p.id === providerId)
  const providerHint = activeProvider ? activeProvider.label : 'Gemma 4 31B'

  const json = layout
    ? JSON.stringify(layout, null, 2).replace(
        selectedPropId ? new RegExp(`"${escapeRe(selectedPropId)}"`, 'g') : /$^/,
        (m) => `«${m}»`,
      )
    : ''

  return (
    <div className={`room-preview-overlay${expanded ? ' expanded' : ''}`} role="dialog">
      <div className="room-preview-overlay-head">
        <span className="room-json-summary">
          Layout JSON
          {layout && (
            <small className="muted">
              {(layout.props || []).length} props · {layout.dimensions?.width}m × {layout.dimensions?.depth}m × {layout.dimensions?.height}m
            </small>
          )}
        </span>
        <div className="room-preview-overlay-buttons">
          <button
            type="button"
            className="room-preview-overlay-btn"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Shrink' : 'Expand'}
            aria-label={expanded ? 'Shrink' : 'Expand'}
          >
            {expanded ? '⊟' : '⊞'}
          </button>
          <button
            type="button"
            className="room-preview-overlay-btn"
            onClick={() => setOpen(false)}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>
      {busy && (thinking || tokens || stage) ? (
        <PromptStreamPane stage={stage} thinking={thinking} tokens={tokens} />
      ) : layout ? (
        <pre className="room-preview-overlay-json">{json}</pre>
      ) : (
        <p className="muted room-preview-overlay-empty">No layout yet.</p>
      )}
      <div className="room-preview-overlay-actions">
        <SplitButton
          options={options}
          selectedId={providerId}
          onSelect={onProviderChange}
          onAction={onRegenerate}
          disabled={busy}
          title={`Regenerate via ${providerHint}`}
        >
          {(layout?.props || []).length === 0 ? 'Generate layout' : 'Reroll graybox'}
        </SplitButton>
        <small className="muted room-mockup-provider-hint">
          {busy ? (stage || 'working…') : 'via '}
          {!busy && providerHint}
        </small>
      </div>
    </div>
  )
}

/**
 * Adapt a layout JSON into the loose "room" shape the detail panel
 * was built around. Static rooms in roomTypes.js carry gameplay
 * metadata (tier, capacity, productionDuration) that LLM-generated
 * rooms lack — those fields stay undefined and the gameplay section
 * silently omits them.
 */
/** Slugify a free-form prop id input (lowercase, dashes, alnum-only). */
function slugifyPropId(s) {
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return out && /^[a-z0-9]/.test(out) ? out : ''
}

/** Resolve to a propId not in `used` by appending `-2`, `-3`, … */
function uniquePropId(base, used) {
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

/** Bump the version suffix on a prop id (`-v2`, `-v3` …) — preserves
 *  the human-readable base so regenerated variants stay grouped. */
function nextVersionId(currentId, used) {
  const m = currentId.match(/^(.*)-v(\d+)$/)
  const base = m ? m[1] : currentId
  let n = m ? Number(m[2]) + 1 : 2
  while (used.has(`${base}-v${n}`)) n += 1
  return `${base}-v${n}`
}

function roomFromLayout(layout) {
  return {
    id: layout.id,
    name: layout.name || layout.id,
    description: layout.description || '',
    vibe: layout.vibe || '',
    category: layout.category || 'work',
    palette: layout.palette || {},
    // Map layout props to the static-room shape used by PropRow. Slot
    // is a hint for the thumbnail badge; we infer from prop kind so
    // chairs/desks/tables read mid, fixtures read ceil, etc.
    props: (layout.props || []).map((p) => ({
      id: p.id,
      slot: slotForKind(p.kind),
      prompt: p.prompt,
      kind: p.kind,
      count: 1,
    })),
    generated: true,
  }
}

function slotForKind(kind) {
  switch (kind) {
    case 'fixture':
    case 'lamp':
      return 'ceil'
    case 'cabinet':
    case 'shelf':
    case 'art':
    case 'sign':
    case 'window':
    case 'door':
      return 'back'
    case 'plant':
    case 'rug':
      return 'fore'
    default:
      return 'mid'
  }
}

// ─── selected prop panel ─────────────────────────────────────────

function SelectedPropPanel({ layout, selectedPropId, onClear }) {
  if (!layout || !selectedPropId) return null
  const prop = (layout.props || []).find((p) => p.id === selectedPropId)
  if (!prop) return null
  return (
    <section className="room-detail-section room-selected-prop">
      <div className="room-detail-section-head">
        <h3>
          Selected · <code>{prop.id}</code>
          <small className="muted">{prop.kind || 'misc'}</small>
        </h3>
        <div className="room-detail-actions">
          <button type="button" className="npcs-btn small" onClick={onClear}>deselect</button>
        </div>
      </div>
      <p className="room-selected-prop-desc">{prop.prompt}</p>
      <dl className="room-selected-prop-meta">
        <dt>position</dt>
        <dd><code>{`x=${fmt(prop.position.x)}  y=${fmt(prop.position.y)}  z=${fmt(prop.position.z)}`}</code></dd>
        <dt>size</dt>
        <dd><code>{`w=${fmt(prop.size.w)}  h=${fmt(prop.size.h)}  d=${fmt(prop.size.d)}`}</code></dd>
        {prop.rotation_y ? (
          <>
            <dt>rotation</dt>
            <dd><code>{fmt(prop.rotation_y)} rad</code></dd>
          </>
        ) : null}
      </dl>
    </section>
  )
}

function fmt(n) {
  if (typeof n !== 'number') return '—'
  return Math.round(n * 1000) / 1000
}

// ─── layout JSON viewer ──────────────────────────────────────────

function LayoutJsonSection({ layout, selectedPropId }) {
  if (!layout) return null
  return (
    <section className="room-detail-section room-json-section">
      <details>
        <summary>
          <span className="room-json-summary">
            Layout JSON
            <small className="muted">{(layout.props || []).length} props · {layout.dimensions?.width}m × {layout.dimensions?.depth}m × {layout.dimensions?.height}m</small>
          </span>
        </summary>
        <pre className="room-json-pane">
          {JSON.stringify(layout, null, 2)
            // Underline the selected prop id so you can find it quickly
            // when scanning the JSON.
            .replace(
              selectedPropId ? new RegExp(`"${escapeRe(selectedPropId)}"`, 'g') : /$^/,
              (m) => `«${m}»`,
            )}
        </pre>
      </details>
    </section>
  )
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Props sidebar (right of 3D preview) ─────────────────────────

function PropsSidebar({
  room, summary, assets, selectedPropId,
  onSelect, onGenerateAll, onRemoveProp,
  onPropRename, onPropPromptChange, onPropRegenerate,
}) {
  const props = room.props || []
  // Count GLBs ready against the live layout's total — `summary` is
  // derived from the static-room registry which is empty for
  // LLM-generated rooms. Always trust the layout for the denominator.
  const total = props.length
  const ready = props.filter((p) => assets?.[p.id]?.status === ROOM_ASSET_STATUS.ready).length
  return (
    <aside className="room-props-sidebar" aria-label="Props">
      <header>
        <h3>
          Props
          <small className="muted">{ready}/{total}</small>
        </h3>
        <button
          type="button"
          className="npcs-btn small"
          onClick={onGenerateAll}
          disabled={!props.length}
          title="Generate every prop's image + GLB"
        >
          Gen all
        </button>
      </header>
      <ul className="room-props-list">
        {props.map((prop) => (
          <PropListItem
            key={prop.id}
            prop={prop}
            room={room}
            asset={assets?.[prop.id] || (prop.sourceAssetId ? assets?.[prop.sourceAssetId] : null)}
            selected={prop.id === selectedPropId}
            onSelect={onSelect}
            onRemove={onRemoveProp}
            onRename={onPropRename}
            onPromptChange={onPropPromptChange}
            onRegenerate={onPropRegenerate}
          />
        ))}
        {!props.length && <li className="muted room-props-empty">No props.</li>}
      </ul>
    </aside>
  )
}

// ─── Room detail header with inline name + description editing ───

function RoomDetailHeader({ room, layoutEntry }) {
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [draftName, setDraftName] = useState(room.name || '')
  const [draftDesc, setDraftDesc] = useState(room.description || '')
  const [saving, setSaving] = useState(false)

  // Reset drafts when switching rooms or when the layout changes upstream.
  useEffect(() => {
    setDraftName(room.name || '')
    setDraftDesc(room.description || '')
    setEditingName(false)
    setEditingDesc(false)
  }, [room.id, room.name, room.description])

  async function commit({ name, description }) {
    const layout = layoutEntry?.layout
    if (!layout) return
    setSaving(true)
    try {
      await saveLayout({
        ...layout,
        name: name ?? layout.name,
        description: description ?? layout.description,
      })
    } catch (err) {
      console.error('[saveLayout]', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <header className="room-detail-header">
      <div>
        <h2>
          {editingName ? (
            <input
              type="text"
              className="room-detail-edit-input"
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => { setEditingName(false); if (draftName.trim() && draftName !== room.name) commit({ name: draftName.trim() }) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                if (e.key === 'Escape') { setDraftName(room.name || ''); setEditingName(false) }
              }}
            />
          ) : (
            <span
              className="room-detail-name room-detail-editable"
              onClick={() => setEditingName(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setEditingName(true) }}
              title="Click to edit name"
            >
              {room.name}
            </span>
          )}
          <button
            type="button"
            className="room-detail-edit-btn"
            onClick={() => setEditingName((v) => !v)}
            title="Edit room name"
            aria-label="Edit room name"
          >
            📝
          </button>
          <LayoutBadge entry={layoutEntry} />
          {saving && <small className="muted"> saving…</small>}
          <a
            href={`#/shelter-room/${encodeURIComponent(room.id)}`}
            className="room-detail-edit-btn"
            title="View this room in shelter scale with a character"
            style={{ marginLeft: 8, fontSize: 13, textDecoration: 'none' }}
          >
            ▶ shelter
          </a>
        </h2>
        <p className="room-detail-vibe">
          {editingDesc ? (
            <input
              type="text"
              className="room-detail-edit-input"
              value={draftDesc}
              autoFocus
              onChange={(e) => setDraftDesc(e.target.value)}
              onBlur={() => { setEditingDesc(false); if (draftDesc !== (room.description || '')) commit({ description: draftDesc }) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                if (e.key === 'Escape') { setDraftDesc(room.description || ''); setEditingDesc(false) }
              }}
            />
          ) : (
            <span
              className="room-detail-desc-text room-detail-editable"
              onClick={() => setEditingDesc(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setEditingDesc(true) }}
              title="Click to edit description"
            >
              {room.description || room.vibe}
            </span>
          )}
          <button
            type="button"
            className="room-detail-edit-btn"
            onClick={() => setEditingDesc((v) => !v)}
            title="Edit description"
            aria-label="Edit description"
          >
            📝
          </button>
        </p>
      </div>
    </header>
  )
}

// ─── Reroll prompt + palette footer ──────────────────────────────

function PromptPaletteRerollFooter({ busy, stage, thinking, tokens, providers, providerId, onProviderChange, onAction }) {
  const options = (providers && providers.length)
    ? providers.map((p) => ({
        id: p.id,
        label: p.label,
        description: `${p.model || ''}${p.configured ? '' : ' · not configured'}`,
        disabled: !p.configured,
      }))
    : [{ id: 'default', label: 'Gemma 4 31B (self-hosted)' }]
  const activeProvider = providers?.find((p) => p.id === providerId)
  const providerHint = activeProvider ? activeProvider.label : 'Gemma 4 31B'
  const showStream = busy && (thinking || tokens || stage)

  return (
    <div className="room-prompt-palette-footer">
      {showStream && (
        <PromptStreamPane stage={stage} thinking={thinking} tokens={tokens} />
      )}
      <div className="room-mockup-action-row">
        <SplitButton
          options={options}
          selectedId={providerId || 'default'}
          onSelect={onProviderChange}
          onAction={onAction}
          disabled={busy}
          title={`Re-derive prompt + palette via ${providerHint}`}
        >
          Reroll prompt + palette
        </SplitButton>
        <small className="muted room-mockup-provider-hint">
          {busy ? (stage || 'working…') : 'via '}
          {!busy && providerHint}
        </small>
      </div>
    </div>
  )
}

function PromptStreamPane({ stage, thinking, tokens }) {
  const [tab, setTab] = useState('thinking')
  // Auto-flip to tokens when JSON starts arriving.
  useEffect(() => {
    if (tokens && tab === 'thinking') setTab('tokens')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!tokens])
  return (
    <div className="rooms-prompt-stream">
      <nav className="rooms-prompt-stream-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'thinking'}
          className={`rooms-prompt-stream-tab${tab === 'thinking' ? ' active' : ''}`}
          onClick={() => setTab('thinking')}
          disabled={!thinking}
        >
          Thinking{thinking ? ` (${thinking.length})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tokens'}
          className={`rooms-prompt-stream-tab${tab === 'tokens' ? ' active' : ''}`}
          onClick={() => setTab('tokens')}
          disabled={!tokens}
        >
          Output{tokens ? ` (${tokens.length})` : ''}
        </button>
      </nav>
      <pre className="rooms-prompt-stream-pane compact">
        {tab === 'thinking' ? (thinking || stage || '(no reasoning yet)') : (tokens || '(no output yet)')}
      </pre>
    </div>
  )
}

// ─── Prop library drawer ─────────────────────────────────────────

function PropLibraryDrawer({ assets, onClose }) {
  // Show every prop with status:ready (i.e. has a generated GLB).
  // Each card is draggable; the canvas drop handler reads the propId
  // from the dataTransfer and clones it into the current layout.
  const ready = Object.entries(assets || {})
    .filter(([, a]) => a?.status === ROOM_ASSET_STATUS.ready)
    .map(([id, a]) => ({ id, ...a }))
    // Newest first (handy when iterating).
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return (
    <aside
      className="room-prop-library"
      role="complementary"
      aria-label="Prop library"
    >
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
              // Use the thumbnail as the drag preview if we have it.
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
    </aside>
  )
}

/** Single row in the props sidebar.
 *
 * Click the id chip → swap to input → save renames the slug (or
 * suffixes a conflict). Click the prompt → swap to textarea → save
 * updates the description. Buttons:
 *   ➕ generate (when no asset yet, same id)
 *   🔄 regenerate (when asset exists — gives the prop a fresh
 *      versioned id like `mdr-desk-v2` so the previous GLB stays
 *      reusable from the prop library drawer)
 *   ⏳ in flight
 *   🗑 remove from room
 */
function PropListItem({ prop, room, asset, selected, onSelect, onRemove, onRename, onPromptChange, onRegenerate }) {
  const s = asset?.status || ROOM_ASSET_STATUS.idle
  const inFlight =
    s === ROOM_ASSET_STATUS.queued
    || s === ROOM_ASSET_STATUS.generatingImage
    || s === ROOM_ASSET_STATUS.generatingModel
  const [editId, setEditId] = useState(false)
  const [editPrompt, setEditPrompt] = useState(false)
  const [draftId, setDraftId] = useState(prop.id)
  const [draftPrompt, setDraftPrompt] = useState(prop.prompt)
  // Reset drafts whenever the prop changes upstream (rename, regen, etc.)
  useEffect(() => { setDraftId(prop.id); setEditId(false) }, [prop.id])
  useEffect(() => { setDraftPrompt(prop.prompt); setEditPrompt(false) }, [prop.prompt])

  function commitId() {
    setEditId(false)
    if (draftId.trim() && draftId !== prop.id) onRename?.(prop.id, draftId.trim())
  }
  function commitPrompt() {
    setEditPrompt(false)
    if (draftPrompt !== prop.prompt) onPromptChange?.(prop.id, draftPrompt)
  }

  return (
    <li
      className={`room-props-item${selected ? ' selected' : ''} status-${s}`}
      onClick={() => { if (!editId && !editPrompt) onSelect(selected ? null : prop.id) }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (editId || editPrompt) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); onSelect(selected ? null : prop.id)
        }
      }}
    >
      <div className="room-props-item-head">
        {editId ? (
          <input
            type="text"
            className="room-props-item-input"
            value={draftId}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftId(e.target.value)}
            onBlur={commitId}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
              if (e.key === 'Escape') { setDraftId(prop.id); setEditId(false) }
            }}
          />
        ) : (
          <span
            className="room-props-item-id room-detail-editable"
            onClick={(e) => { e.stopPropagation(); setEditId(true) }}
            title="Click to rename"
          >
            {prop.id}
          </span>
        )}
      </div>
      <div className="room-props-item-meta">
        <span className="room-props-item-kind">{prop.kind || 'misc'}</span>
        {editPrompt ? (
          <textarea
            className="room-props-item-input"
            rows={2}
            value={draftPrompt}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftPrompt(e.target.value)}
            onBlur={commitPrompt}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault(); e.currentTarget.blur()
              }
              if (e.key === 'Escape') { setDraftPrompt(prop.prompt); setEditPrompt(false) }
            }}
          />
        ) : (
          <span
            className="room-props-item-prompt room-detail-editable"
            onClick={(e) => { e.stopPropagation(); setEditPrompt(true) }}
            title="Click to edit description"
          >
            {prop.prompt}
          </span>
        )}
      </div>
      <div className="room-props-item-actions">
        {s === ROOM_ASSET_STATUS.ready ? (
          <button
            type="button"
            className="npcs-btn icon"
            onClick={(e) => { e.stopPropagation(); onRegenerate?.(prop) }}
            title="Regenerate as a new versioned prop (keeps the old in library)"
            aria-label="Regenerate"
          >
            🔄
          </button>
        ) : inFlight ? (
          <button type="button" className="npcs-btn icon" disabled aria-label="Generating">⏳</button>
        ) : (
          <button
            type="button"
            className="npcs-btn icon primary"
            onClick={(e) => {
              e.stopPropagation()
              generateAsset(prop.id, prop.prompt, {
                kind: prop.kind,
                roomId: room.id,
                palette: room.palette,
              })
            }}
            title="Generate prop image + GLB"
            aria-label="Generate"
          >
            ➕
          </button>
        )}
        <button
          type="button"
          className="npcs-btn icon danger"
          onClick={(e) => { e.stopPropagation(); onRemove?.(prop.id) }}
          title="Remove prop from this room"
          aria-label="Remove prop"
        >
          🗑
        </button>
      </div>
    </li>
  )
}
