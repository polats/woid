import { useEffect, useMemo, useState } from 'react'
import {
  listAnimations, fetchAnimation, deleteAnimation, generateAnimation,
} from './lib/animationStore.js'
import { animationLibrary } from './lib/shelterWorld/animationLibrary.js'
import AnimationPreview from './views/AnimationPreview.jsx'

export default function AnimationsSandbox() {
  const [items, setItems] = useState([])
  const [listError, setListError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [motion, setMotion] = useState(null)
  const [loadingMotion, setLoadingMotion] = useState(false)

  const [prompt, setPrompt] = useState('')
  const [seconds, setSeconds] = useState(2.5)
  const [creating, setCreating] = useState(false)
  // Anchor-in-place mirrors how Shelter renders avatars: the wrapper Group
  // owns world position, so the motion's pelvis translation is suppressed.
  // Off by default — the preview shows the authored translation, which is
  // useful when judging walk distance / cadence before assigning roles.
  const [anchorInPlace, setAnchorInPlace] = useState(false)
  const [genStage, setGenStage] = useState({ stage: null, message: '', elapsedMs: 0, error: null })

  // Seam pose: optional reference to a frame of an existing animation. When
  // set, kimodo pins the new motion's first and last frames to that pose so
  // the result loops cleanly. seamSource holds the resolved record so we
  // know how many frames it has and whether it carries posed_joints (older
  // clips do not and the server will reject them).
  const [seamSourceId, setSeamSourceId] = useState('')
  const [seamFrame, setSeamFrame] = useState(0)
  const [seamSource, setSeamSource] = useState(null)
  const [seamLoading, setSeamLoading] = useState(false)
  // When `useDirection` is false the loop is in-place (no XZ delta between
  // the two seam keyframes). When true, `directionAngle` (radians, 0 =
  // forward / +Z, increasing clockwise viewed top-down) chooses the
  // translation heading; the API rotates this seam-local direction into
  // world frame using the seam's own heading.
  const [useDirection, setUseDirection] = useState(false)
  const [directionAngle, setDirectionAngle] = useState(0)
  const seamEligible = !!seamSource?.posed_joints
  const seamMaxFrame = seamSource ? Math.max(0, (seamSource.num_frames ?? 1) - 1) : 0
  const seamPose = seamEligible && seamSourceId
    ? {
        anim_id: seamSourceId,
        frame_idx: Math.min(seamFrame, seamMaxFrame),
        direction: useDirection
          ? [Math.sin(directionAngle), Math.cos(directionAngle)]
          : null,
      }
    : null

  useEffect(() => {
    if (!seamSourceId) { setSeamSource(null); return }
    let cancelled = false
    setSeamLoading(true)
    fetchAnimation(seamSourceId)
      .then((m) => { if (!cancelled) { setSeamSource(m); setSeamFrame(0) } })
      .catch(() => { if (!cancelled) setSeamSource(null) })
      .finally(() => { if (!cancelled) setSeamLoading(false) })
    return () => { cancelled = true }
  }, [seamSourceId])

  async function refresh() {
    try {
      setListError(null)
      const list = await listAnimations()
      setItems(list)
      // Auto-select most-recent on first load.
      if (list.length && !selectedId) {
        const id = list[0].id ?? list[0].name
        if (id) setSelectedId(id)
      }
    } catch (err) {
      setListError(err.message || String(err))
    }
  }

  useEffect(() => { refresh() /* on mount */ }, []) // eslint-disable-line

  useEffect(() => {
    if (!selectedId) { setMotion(null); return }
    let cancelled = false
    setLoadingMotion(true)
    fetchAnimation(selectedId)
      .then((m) => { if (!cancelled) setMotion(m) })
      .catch(() => { if (!cancelled) setMotion(null) })
      .finally(() => { if (!cancelled) setLoadingMotion(false) })
    return () => { cancelled = true }
  }, [selectedId])

  async function onSubmit(e) {
    e.preventDefault()
    if (!prompt.trim() || creating) return
    setCreating(true)
    setGenStage({ stage: 'starting', message: 'sending to kimodo…', elapsedMs: 0, error: null })
    try {
      const anim = await generateAnimation({
        prompt: prompt.trim(),
        seconds,
        seamPose,
        onStage: (stage, message) => setGenStage((s) => ({ ...s, stage, message, error: null })),
        onHeartbeat: (elapsedMs) => setGenStage((s) => ({ ...s, elapsedMs })),
      })
      setGenStage({ stage: 'done', message: 'done', elapsedMs: 0, error: null })
      setPrompt('')
      await refresh()
      const id = anim?.id ?? anim?.animation_id ?? anim?.name
      if (id) setSelectedId(id)
    } catch (err) {
      setGenStage({ stage: 'error', message: '', elapsedMs: 0, error: err.message || String(err) })
    } finally {
      setCreating(false)
    }
  }

  async function onDelete(id, e) {
    e.stopPropagation()
    if (!confirm(`Delete animation ${id}?`)) return
    try {
      await deleteAnimation(id)
      if (selectedId === id) setSelectedId(null)
      await refresh()
    } catch (err) {
      alert(err.message || String(err))
    }
  }

  const selected = useMemo(
    () => items.find((a) => (a.id ?? a.name) === selectedId) ?? null,
    [items, selectedId],
  )

  // Live view of tag list + assignments so the UI reacts to set / add /
  // remove events from animationLibrary (which persists to localStorage).
  const [tags, setTags] = useState(() => animationLibrary.getTags())
  // For each tag we track both the resolved id (what the game will play —
  // explicit assignment or built-in default) and an `explicit` flag so the
  // UI can distinguish assigned vs. defaulted vs. cleared.
  const buildAssignmentMap = () => {
    const m = {}
    for (const t of animationLibrary.getTags()) {
      const explicit = animationLibrary.getAssignment(t)
      m[t] = { id: animationLibrary.getRoleId(t), explicit: !!explicit }
    }
    return m
  }
  const [assignments, setAssignments] = useState(buildAssignmentMap)
  useEffect(() => {
    return animationLibrary.subscribe(() => {
      setTags(animationLibrary.getTags())
      setAssignments(buildAssignmentMap())
    })
  }, [])

  const [newTag, setNewTag] = useState('')
  const [tagError, setTagError] = useState(null)

  function assignTag(tag) {
    if (!selectedId) return
    animationLibrary.setRoleId(tag, selectedId)
  }
  function clearTag(tag) {
    animationLibrary.setRoleId(tag, null)
  }
  function deleteTag(tag) {
    if (!confirm(`Remove tag "${tag}"?`)) return
    animationLibrary.removeTag(tag)
  }
  function onAddTag(e) {
    e.preventDefault()
    setTagError(null)
    const slug = animationLibrary.addTag(newTag)
    if (!slug) {
      setTagError('Use lowercase letters, digits, dash or underscore (e.g. wave-left)')
      return
    }
    setNewTag('')
  }

  return (
    <div className="studio">
      <header className="studio-header">
        <h1>Animations</h1>
        <p className="studio-tagline">
          Generate motions on the built-in stylized male — preview plays as soon as the model returns.
        </p>
      </header>

      <div className="studio-hero">
        <div className="studio-hero-preview">
          <div className="studio-hero-preview-frame">
            {motion ? (
              <AnimationPreview key={selectedId} motion={motion} anchorInPlace={anchorInPlace} />
            ) : (
              <div className="studio-hero-preview-empty">
                {loadingMotion ? 'loading motion…' : 'no motion selected — describe one →'}
              </div>
            )}
          </div>
          {selected && (
            <>
              <div className="studio-hero-preview-meta">
                <strong>{selected.id ?? selected.name}</strong>
                <span className="prompt">
                  {selected.prompt || motion?.prompt || ''}
                </span>
                {selected.seconds && (
                  <span className="studio-card-meta">
                    {selected.seconds}s · {selected.fps ?? '?'}fps
                  </span>
                )}
                <label className="studio-anchor-toggle" title="Suppress root translation — like Shelter avatars">
                  <input
                    type="checkbox"
                    checked={anchorInPlace}
                    onChange={(e) => setAnchorInPlace(e.target.checked)}
                  />
                  <span>anchor in place</span>
                </label>
              </div>
              <div className="studio-hero-roles">
                <span className="studio-hero-roles-label">Use as</span>
                {tags.length === 0 && (
                  <span className="studio-hero-roles-hint">no tags — add one below</span>
                )}
                {tags.map((tag) => {
                  const isAssigned = assignments[tag]?.id === selectedId
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`studio-role-btn${isAssigned ? ' is-assigned' : ''}`}
                      onClick={() => assignTag(tag)}
                      title={isAssigned ? `Currently assigned as ${tag}` : `Set as ${tag}`}
                    >
                      {tag}
                      {isAssigned && <span className="studio-role-btn-mark"> ✓</span>}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div className="studio-hero-input">
          <form onSubmit={onSubmit}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A figure crouches low and pounces forward."
              disabled={creating}
            />
            <label className="anim-seconds">
              <span>Length</span>
              <input
                type="range"
                min="1"
                max="6"
                step="0.5"
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
                disabled={creating}
              />
              <span className="anim-seconds-val">{seconds.toFixed(1)}s</span>
            </label>

            <div className="seam-picker">
              <div className="seam-picker-head">
                <span className="seam-picker-label">Loop seam</span>
                <select
                  className="seam-picker-source"
                  value={seamSourceId}
                  onChange={(e) => setSeamSourceId(e.target.value)}
                  disabled={creating}
                >
                  <option value="">— none —</option>
                  {items.map((a) => {
                    const id = a.id ?? a.name
                    return (
                      <option key={id} value={id}>
                        {id}{a.prompt ? ` · ${a.prompt.slice(0, 40)}` : ''}
                      </option>
                    )
                  })}
                </select>
              </div>

              {seamSourceId && (
                <div className="seam-picker-body">
                  <div className="seam-picker-frame">
                    {seamSource && seamEligible ? (
                      <AnimationPreview
                        key={seamSourceId}
                        motion={seamSource}
                        frame={Math.min(seamFrame, seamMaxFrame)}
                        anchorInPlace={false}
                      />
                    ) : (
                      <div className="seam-picker-empty">
                        {seamLoading
                          ? 'loading source…'
                          : seamSource && !seamEligible
                            ? 'source has no posed_joints — regenerate it'
                            : 'source unavailable'}
                      </div>
                    )}
                  </div>
                  {seamSource && seamEligible && (
                    <div className="seam-picker-scrub">
                      <input
                        type="range"
                        min="0"
                        max={seamMaxFrame}
                        step="1"
                        value={Math.min(seamFrame, seamMaxFrame)}
                        onChange={(e) => setSeamFrame(Number(e.target.value))}
                        disabled={creating}
                      />
                      <span className="seam-picker-frame-val">
                        f{String(Math.min(seamFrame, seamMaxFrame)).padStart(3, '0')}
                        <span className="seam-picker-frame-total"> / {seamMaxFrame}</span>
                      </span>
                    </div>
                  )}
                  {seamSource && seamEligible && (
                    <div className="seam-picker-direction">
                      <label className="seam-picker-direction-toggle">
                        <input
                          type="checkbox"
                          checked={useDirection}
                          onChange={(e) => setUseDirection(e.target.checked)}
                          disabled={creating}
                        />
                        <span>movement direction</span>
                      </label>
                      {useDirection && (
                        <div className="seam-picker-direction-dial">
                          <DirectionDial
                            angle={directionAngle}
                            onChange={setDirectionAngle}
                            disabled={creating}
                          />
                          <button
                            type="button"
                            className="seam-picker-direction-reset"
                            onClick={() => setDirectionAngle(0)}
                            disabled={creating || directionAngle === 0}
                            title="Reset to forward"
                          >
                            reset to forward
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="studio-hero-actions">
              <button
                type="submit"
                className="spells-btn primary"
                disabled={creating || !prompt.trim()}
              >
                {creating ? 'Generating…' : 'Generate motion'}
              </button>
            </div>

            {creating && (
              <p className="spells-status">
                {genStage.message}
                {genStage.elapsedMs > 0 && ` · ${(genStage.elapsedMs / 1000).toFixed(1)}s`}
              </p>
            )}
            {genStage.error && <p className="spells-error">{genStage.error}</p>}
            {listError && <p className="spells-error">kimodo offline? {listError}</p>}
          </form>
        </div>
      </div>

      <section className="anim-tags-section">
        <div className="studio-grid-head">
          <h2>Animation tags</h2>
          <span className="spells-count">{tags.length}</span>
        </div>

        <div className="anim-tags-grid">
          {tags.map((tag) => {
            const entry = assignments[tag] ?? { id: null, explicit: false }
            const animId = entry.id
            const item = animId ? items.find((a) => (a.id ?? a.name) === animId) : null
            const isBuiltin = animationLibrary.BUILTIN_TAGS.includes(tag)
            const isDefault = !entry.explicit && !!animId
            return (
              <div
                key={tag}
                className={`anim-tag-card${animId ? ' is-assigned' : ''}${animId && animId === selectedId ? ' is-selected' : ''}`}
              >
                <div className="anim-tag-card-head">
                  <strong>{tag}</strong>
                  {isBuiltin && <span className="anim-tag-card-pill">built-in</span>}
                  {!isBuiltin && (
                    <button
                      type="button"
                      className="anim-tag-card-x"
                      title={`Remove tag ${tag}`}
                      onClick={() => deleteTag(tag)}
                    >×</button>
                  )}
                </div>
                {animId ? (
                  <button
                    type="button"
                    className="anim-tag-card-body"
                    onClick={() => setSelectedId(animId)}
                    title="Jump to this clip"
                  >
                    <span className="anim-tag-card-id">
                      {animId}
                      {isDefault && <span className="anim-tag-card-default"> · default</span>}
                    </span>
                  </button>
                ) : (
                  <div className="anim-tag-card-body anim-tag-card-empty">
                    unassigned
                  </div>
                )}
              </div>
            )
          })}

          <form className="anim-tag-card anim-tag-add" onSubmit={onAddTag}>
            <div className="anim-tag-card-head">
              <strong>+ new tag</strong>
            </div>
            <input
              type="text"
              value={newTag}
              onChange={(e) => { setNewTag(e.target.value); setTagError(null) }}
              placeholder="e.g. wave, sit, dance"
              maxLength={24}
            />
            <button type="submit" className="studio-role-btn" disabled={!newTag.trim()}>
              add
            </button>
            {tagError && <p className="spells-error">{tagError}</p>}
          </form>
        </div>
      </section>

      <section>
        <div className="studio-grid-head">
          <h2>Library</h2>
          <span className="spells-count">{items.length}</span>
        </div>

        {!listError && items.length === 0 ? (
          <p className="studio-empty">No motions yet — generate one.</p>
        ) : (
          <div className="studio-grid">
            {items.map((a) => {
              const id = a.id ?? a.name
              const assignedRoles = tags.filter((t) => assignments[t]?.id === id)
              return (
                <button
                  key={id}
                  type="button"
                  className={`studio-card${selectedId === id ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(id)}
                >
                  <strong>{id}</strong>
                  <span className="studio-card-prompt">{a.prompt || a.label || '—'}</span>
                  <span className="studio-card-meta">
                    {a.seconds ? `${a.seconds}s · ${a.fps ?? '?'}fps` : ''}
                  </span>
                  {assignedRoles.length > 0 && (
                    <span className="studio-card-roles">
                      {assignedRoles.map((r) => (
                        <span key={r} className="studio-card-role-badge">{r}</span>
                      ))}
                    </span>
                  )}
                  <span
                    className="studio-card-delete"
                    role="button"
                    aria-label="Delete animation"
                    title="Delete animation"
                    onClick={(e) => onDelete(id, e)}
                  >×</span>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

// Compass-style picker. Bottom of the circle = forward (+Z, the avatar's
// natural forward), right = +X (the avatar's right). `angle` is in radians:
// 0 = forward, π/2 = right, π = back, -π/2 = left. The data sent to the API
// is unchanged — `[sin(angle), cos(angle)]` already maps these correctly.
// Click or drag inside the circle to set the direction; the handle
// projects to the rim regardless of click radius so distance stays
// implicit (controlled server-side by a duration heuristic).
function DirectionDial({ angle, onChange, disabled, size = 96 }) {
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 8
  // Place angle 0 at the bottom of the dial (SVG y is down). Right (+π/2)
  // stays at right because sin > 0 there; back (π) goes to the top; left
  // (-π/2) at left.
  const hx = cx + Math.sin(angle) * r
  const hy = cy + Math.cos(angle) * r
  const setFromPointer = (clientX, clientY, target) => {
    if (disabled) return
    const rect = target.getBoundingClientRect()
    const dx = clientX - rect.left - cx
    const dy = clientY - rect.top - cy
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return
    // Inverse of the placement above: dy positive (below center) → angle 0.
    onChange(Math.atan2(dx, dy))
  }
  return (
    <svg
      className={`seam-dial${disabled ? ' is-disabled' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onMouseDown={(e) => setFromPointer(e.clientX, e.clientY, e.currentTarget)}
      onMouseMove={(e) => { if (e.buttons === 1) setFromPointer(e.clientX, e.clientY, e.currentTarget) }}
      onTouchStart={(e) => {
        const t = e.touches[0]; if (t) setFromPointer(t.clientX, t.clientY, e.currentTarget)
      }}
      onTouchMove={(e) => {
        const t = e.touches[0]; if (t) setFromPointer(t.clientX, t.clientY, e.currentTarget)
      }}
    >
      <circle cx={cx} cy={cy} r={r} className="seam-dial-bg" />
      {/* compass ticks at 0, 90, 180, 270 */}
      {[0, 1, 2, 3].map((q) => {
        const a = q * Math.PI / 2
        const x1 = cx + Math.sin(a) * (r - 4)
        const y1 = cy + Math.cos(a) * (r - 4)
        const x2 = cx + Math.sin(a) * r
        const y2 = cy + Math.cos(a) * r
        return <line key={q} x1={x1} y1={y1} x2={x2} y2={y2} className="seam-dial-tick" />
      })}
      <text x={cx} y={size - 3} className="seam-dial-label">F</text>
      <line x1={cx} y1={cy} x2={hx} y2={hy} className="seam-dial-pointer" />
      <circle cx={hx} cy={hy} r={5} className="seam-dial-handle" />
      <circle cx={cx} cy={cy} r={2} className="seam-dial-center" />
    </svg>
  )
}
