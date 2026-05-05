// Compact popover that appears when the player taps an agent in the Stage.
// Lists locally-stored spells; selecting one casts it on the tapped agent.
import { useEffect, useMemo, useState } from 'react'
import { listSpells } from '../lib/spellStore.js'

export default function SpellPicker({ npub, agentName, screenPos, onPick, onCancel }) {
  const [spells, setSpells] = useState(() => listSpells())
  // Refresh when something else writes to localStorage (e.g. user generates
  // a new spell in another tab while the picker is open).
  useEffect(() => {
    const refresh = () => setSpells(listSpells())
    window.addEventListener('storage', refresh)
    return () => window.removeEventListener('storage', refresh)
  }, [])

  // Position so the popover stays inside the stage even at the edge.
  const style = useMemo(() => {
    const x = Math.max(8, Math.min((screenPos?.x ?? 0) + 8, 9999))
    const y = Math.max(8, (screenPos?.y ?? 0) - 8)
    return { left: x, top: y }
  }, [screenPos])

  return (
    <>
      <div className="spell-picker-backdrop" onClick={onCancel} />
      <div className="spell-picker" style={style} role="menu">
        <div className="spell-picker-head">
          <span className="spells-step">Cast on</span>
          <strong>{agentName || 'agent'}</strong>
        </div>
        {spells.length === 0 ? (
          <p className="spells-empty">
            No spells yet — open <a href="#/spells" onClick={onCancel}>Ghost powers</a>.
          </p>
        ) : (
          <ul className="spell-picker-list">
            {spells.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s)}
                  className="spell-picker-item"
                >
                  <strong>{s.name}</strong>
                  <span>{s.prompt}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
