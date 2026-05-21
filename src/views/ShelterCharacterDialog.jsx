import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

/**
 * Speech-bubble dialog shown when a character is focused (zoomed
 * in). Mirrors the tutorial dialog visual so the player reads it
 * as the same "someone's talking" affordance. Default opening line
 * is "Yes?" — the character acknowledging being approached.
 *
 * Props:
 *   agent   — { id, pubkey, name, avatarUrl } | null
 *   text    — line to display (default "Yes?")
 *   pending — when true, show an animated ellipsis instead of text
 *             (model is "thinking"). When it flips to false, the
 *             current `text` streams in via typewriter.
 */
export default function ShelterCharacterDialog({ agent, text = 'Yes?', pending = false }) {
  const [revealed, setRevealed] = useState('')
  const [dotCount, setDotCount] = useState(1)

  // Typewriter — runs whenever `text` changes and we're not in the
  // pending state. Resets to '' first so a new line never appears
  // mid-stream from a prior one.
  useEffect(() => {
    if (pending) { setRevealed(''); return }
    setRevealed('')
    let i = 0
    const id = setInterval(() => {
      i += 1
      setRevealed(text.slice(0, i))
      if (i >= text.length) clearInterval(id)
    }, 24)
    return () => clearInterval(id)
  }, [text, pending])

  // Animated ellipsis while pending. Three-dot cycle, ~280ms/dot so
  // the user reads it as "thinking" rather than as a typed line.
  useEffect(() => {
    if (!pending) return
    setDotCount(1)
    const id = setInterval(() => {
      setDotCount((c) => (c % 3) + 1)
    }, 280)
    return () => clearInterval(id)
  }, [pending])

  if (!agent) return null
  const speakerInitial = (agent.name ?? '?').trim().charAt(0).toUpperCase()
  const body = pending ? '.'.repeat(dotCount) : revealed
  return (
    <motion.div
      className="shelter-character-dialog"
      role="dialog"
      aria-live="polite"
      initial={{ y: 24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 24, opacity: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="shelter-character-dialog-portrait">
        {agent.avatarUrl
          ? <img src={agent.avatarUrl} alt="" />
          : <span>{speakerInitial}</span>}
      </div>
      <div className="shelter-character-dialog-text">
        <strong>{agent.name ?? '—'}</strong>
        <p className={pending ? 'is-pending' : ''}>{body}</p>
      </div>
    </motion.div>
  )
}
