import { useEffect, useMemo, useRef, useState } from 'react'
import { listSpells, deleteSpell, generateSpell, suggestSpells } from './lib/spellStore.js'
import SpellPreview from './views/SpellPreview.jsx'

export default function SpellsSandbox() {
  const [spells, setSpells] = useState(() => listSpells())
  const [selectedId, setSelectedId] = useState(() => listSpells()[0]?.id ?? null)
  const [prompt, setPrompt] = useState('')

  const [creating, setCreating] = useState(false)
  const [genState, setGenState] = useState({ stage: null, message: '', error: null })
  const [streamText, setStreamText] = useState('')
  const streamRef = useRef(null)

  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [suggestError, setSuggestError] = useState(null)

  useEffect(() => {
    const refresh = () => setSpells(listSpells())
    window.addEventListener('storage', refresh)
    return () => window.removeEventListener('storage', refresh)
  }, [])

  // Keep selection valid as the library mutates.
  useEffect(() => {
    if (!spells.length) { setSelectedId(null); return }
    if (!spells.some((s) => s.id === selectedId)) setSelectedId(spells[0].id)
  }, [spells, selectedId])

  const selected = useMemo(
    () => spells.find((s) => s.id === selectedId) ?? null,
    [spells, selectedId],
  )

  async function onSubmit(e) {
    e.preventDefault()
    if (!prompt.trim() || creating) return
    const sent = prompt.trim()
    setCreating(true)
    setStreamText('')
    setGenState({ stage: 'starting', message: 'sending to local Claude…', error: null })
    try {
      const spell = await generateSpell({
        prompt: sent,
        onStage: (stage, message) => setGenState({ stage, message, error: null }),
        onPartial: (text) => setStreamText(text),
      })
      setSpells(listSpells())
      setSelectedId(spell.id)
      setPrompt('')
      setSuggestions([])
      setGenState({ stage: 'done', message: 'done', error: null })
    } catch (err) {
      setGenState({ stage: 'error', message: '', error: err.message || String(err) })
    } finally {
      setCreating(false)
      setTimeout(() => setStreamText(''), 600)
    }
  }

  async function onSurprise() {
    if (suggesting || creating) return
    setSuggesting(true)
    setSuggestError(null)
    setSuggestions([null, null, null])
    try {
      const list = await suggestSpells({
        onItem: (item, idx) => {
          setSuggestions((prev) => {
            const next = prev.length ? [...prev] : [null, null, null]
            next[idx] = item
            return next
          })
        },
      })
      setSuggestions(list)
    } catch (err) {
      setSuggestError(err.message || String(err))
      setSuggestions([])
    } finally {
      setSuggesting(false)
    }
  }

  function onPickSuggestion(s) {
    setPrompt(s.prompt)
    setSuggestions([])
  }

  function onDelete(id, e) {
    e.stopPropagation()
    if (!confirm('Delete this spell?')) return
    deleteSpell(id)
    setSpells(listSpells())
    if (selectedId === id) setSelectedId(null)
  }

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [streamText])

  return (
    <div className="studio">
      <header className="studio-header">
        <h1>Ghost powers</h1>
        <p className="studio-tagline">
          Conjure particle &amp; shader effects with a sentence — preview lands as soon as it's ready.
        </p>
      </header>

      <div className="studio-hero">
        <div className="studio-hero-preview">
          <div className="studio-hero-preview-frame">
            {selected ? (
              <SpellPreview key={selected.id} spell={selected} />
            ) : (
              <div className="studio-hero-preview-empty">
                no spell yet — describe one →
              </div>
            )}
          </div>
          {selected && (
            <div className="studio-hero-preview-meta">
              <strong>{selected.name}</strong>
              <span className="prompt">{selected.prompt}</span>
            </div>
          )}
        </div>

        <div className="studio-hero-input">
          <form onSubmit={onSubmit}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A spectral chill that drifts from the body in pale blue wisps, leaving the air shimmering."
              disabled={creating}
            />
            <div className="studio-hero-actions">
              <button
                type="button"
                className="spells-btn ghost"
                onClick={onSurprise}
                disabled={suggesting || creating}
              >
                {suggesting ? 'Divining…' : '✦ Surprise me'}
              </button>
              <button
                type="submit"
                className="spells-btn primary"
                disabled={creating || !prompt.trim()}
              >
                {creating ? 'Conjuring…' : 'Conjure'}
              </button>
            </div>

            {(creating && streamText) && (
              <div className="spells-stream">
                <div className="spells-stream-head">
                  <span className="spells-stream-dot" />
                  <strong>Conjuring…</strong>
                  <span className="spells-stream-msg">{genState.message}</span>
                </div>
                <pre ref={streamRef} className="spells-stream-code"><code>{streamText}</code></pre>
              </div>
            )}
            {genState.error && <p className="spells-error">{genState.error}</p>}
            {suggestError && <p className="spells-error">{suggestError}</p>}

            {suggestions.length > 0 && (
              <ul className="spells-suggestions">
                {suggestions.map((s, i) => (
                  <li key={i} className={s ? '' : 'is-loading'}>
                    {s ? (
                      <button type="button" onClick={() => onPickSuggestion(s)}>
                        <strong>{s.name}</strong>
                        <span>{s.prompt}</span>
                      </button>
                    ) : (
                      <div className="spells-suggestion-skeleton" aria-busy="true">
                        <span className="skeleton-line skeleton-name" />
                        <span className="skeleton-line" />
                        <span className="skeleton-line skeleton-short" />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </form>
        </div>
      </div>

      <section>
        <div className="studio-grid-head">
          <h2>Library</h2>
          <span className="spells-count">{spells.length}</span>
        </div>

        {spells.length === 0 ? (
          <p className="studio-empty">No spells yet — conjure one above.</p>
        ) : (
          <div className="studio-grid">
            {spells.map((s) => (
              <SpellCard
                key={s.id}
                spell={s}
                selected={selectedId === s.id}
                onSelect={() => setSelectedId(s.id)}
                onDelete={(e) => onDelete(s.id, e)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// Compact spell tile. Pulls a few dominant colors out of the schema's color
// curves so each card has a visual fingerprint without needing to render.
function SpellCard({ spell, selected, onSelect, onDelete }) {
  const swatches = useMemo(() => extractSwatches(spell.schema), [spell.schema])
  return (
    <button
      type="button"
      className={`studio-card${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
    >
      <strong>{spell.name}</strong>
      <span className="studio-card-prompt">{spell.prompt}</span>
      {swatches.length > 0 && (
        <div className="studio-card-swatches">
          {swatches.map((c, i) => (
            <span key={i} className="studio-card-swatch" style={{ background: c }} />
          ))}
        </div>
      )}
      <span className="studio-card-meta">{new Date(spell.createdAt).toLocaleDateString()}</span>
      <span
        className="studio-card-delete"
        role="button"
        aria-label="Delete spell"
        title="Delete spell"
        onClick={onDelete}
      >×</span>
    </button>
  )
}

function extractSwatches(schema, n = 5) {
  const out = []
  const layers = schema?.layers ?? []
  for (const layer of layers) {
    const stops = layer?.curves?.color
    if (!Array.isArray(stops)) continue
    for (const stop of stops) {
      if (Array.isArray(stop) && typeof stop[1] === 'string') {
        out.push(stop[1])
        if (out.length >= n) return out
      }
    }
  }
  return out
}
