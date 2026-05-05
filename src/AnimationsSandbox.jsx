import { useEffect, useMemo, useState } from 'react'
import {
  listAnimations, fetchAnimation, deleteAnimation, generateAnimation,
} from './lib/animationStore.js'
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
  const [genStage, setGenStage] = useState({ stage: null, message: '', elapsedMs: 0, error: null })

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
              <AnimationPreview key={selectedId} motion={motion} />
            ) : (
              <div className="studio-hero-preview-empty">
                {loadingMotion ? 'loading motion…' : 'no motion selected — describe one →'}
              </div>
            )}
          </div>
          {selected && (
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
            </div>
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
