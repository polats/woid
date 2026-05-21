import { useState } from 'react'
import { motion } from 'framer-motion'
import { useShelterStore } from '../hooks/useShelterStore.js'
import {
  MANAGER_KEY, pairKey, relationshipBandForScore,
} from '../lib/shelterStore/index.js'

/**
 * Top-of-screen card for the focused character — replaces the
 * dossier card while the player is zoomed in. Slice 1 is a chat
 * input shell from the PLAYER's perspective: name of the character
 * being addressed, the player's bond level with them, a text
 * input, a mic button (voice → text wiring lands later), and a
 * send button.
 *
 * Props:
 *   agent — focused-agent payload from the stage
 *   onClose — fired when the player taps × to dismiss focus
 *   onSend — async callback with the typed text. Optional.
 *   onVoice — fired when the player taps the mic. Optional.
 */
export default function ShelterInteractionCard({
  agent, onClose, onSend = null, onVoice = null,
  bondFlashing = false, toast = null,
}) {
  const [text, setText] = useState('')
  const snap = useShelterStore()
  if (!agent) return null

  const bondScore = (() => {
    if (!agent.pubkey) return 0
    const key = pairKey(agent.pubkey, MANAGER_KEY)
    return key ? (snap?.relationships?.[key]?.score ?? 0) : 0
  })()
  const bondBand = relationshipBandForScore(bondScore)

  const submit = (e) => {
    e?.preventDefault?.()
    const v = text.trim()
    if (!v) return
    setText('')
    onSend?.(v)
  }

  return (
    <motion.aside
      className="shelter-interaction-card"
      role="status"
      aria-live="polite"
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -20, opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <form className="shelter-interaction-card-form" onSubmit={submit}>
        <div className="shelter-interaction-card-header">
          <div className="shelter-interaction-card-addressing">
            <span className="shelter-interaction-card-prefix">Talking to</span>
            <span className="shelter-interaction-card-name">{agent.name ?? '—'}</span>
          </div>
          <PlayerBondMini score={bondScore} band={bondBand} flashing={bondFlashing} />
        </div>
        <div className="shelter-interaction-card-row">
          <input
            type="text"
            className="shelter-interaction-card-input"
            placeholder="Say something…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className="shelter-interaction-card-mic"
            onClick={() => onVoice?.()}
            title="Voice"
            aria-label="Hold to talk"
          >
            <MicIcon />
          </button>
          <button
            type="submit"
            className="shelter-interaction-card-send"
            disabled={!text.trim()}
          >Send</button>
        </div>
      </form>
      {onClose && (
        <button
          type="button"
          className="shelter-interaction-card-close"
          onClick={onClose}
          aria-label="Close interaction"
          title="Close"
        >×</button>
      )}
      {toast && (
        <div className="shelter-interaction-card-toast" role="status">
          {toast}
        </div>
      )}
    </motion.aside>
  )
}

const BOND_BREAKS = [10, 30, 60, 85]

function PlayerBondMini({ score, band, flashing = false }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0))
  return (
    <div
      className={`shelter-interaction-card-bond shelter-card-bond-bar shelter-card-bond-bar-${band}${flashing ? ' is-flashing' : ''}`}
      title={`Player bond — ${band} (${pct}/100)`}
    >
      <div className="shelter-card-bond-bar-scrim" style={{ width: `${100 - pct}%` }} />
      <span className="shelter-card-bar-thumb" style={{ left: `${pct}%` }} />
      {BOND_BREAKS.map((t) => (
        <div key={t} className="shelter-card-bond-bar-divider" style={{ left: `${t}%` }} />
      ))}
      <span className="shelter-card-bond-bar-value">{pct}</span>
    </div>
  )
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M9 21h6" />
    </svg>
  )
}
