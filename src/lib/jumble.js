import { nip19 } from 'nostr-tools'

/**
 * Build URLs pointing into the Jumble Nostr web client. Jumble routes
 * any NIP-19 identifier off its root (`/:identifier`), so we just need
 * to encode to npub / nevent / note and concatenate with the base URL
 * from config (local docker vs Railway per environment).
 *
 * All helpers return `null` if inputs are missing, so callers can
 * render the link conditionally without guard clauses.
 */

function normalizeBase(base) {
  if (!base) return null
  return base.replace(/\/+$/, '')
}

/** `profileUrl(jumbleBase, pubkeyOrNpub)` → `https://.../npub1...` */
export function profileUrl(base, id) {
  const b = normalizeBase(base)
  if (!b || !id) return null
  const npub = id.startsWith('npub1') ? id : safeEncode(() => nip19.npubEncode(id))
  return npub ? `${b}/${npub}` : null
}

/** `eventUrl(jumbleBase, eventId, { author, kind, relays })` → `https://.../nevent1...`.
 *  Falls back to note1 encoding if nevent metadata can't be assembled. */
export function eventUrl(base, id, meta = {}) {
  const b = normalizeBase(base)
  if (!b || !id) return null
  const nevent = safeEncode(() => nip19.neventEncode({
    id,
    author: meta.author,
    kind: meta.kind,
    relays: meta.relays ?? [],
  }))
  if (nevent) return `${b}/${nevent}`
  const note = safeEncode(() => nip19.noteEncode(id))
  return note ? `${b}/${note}` : null
}

function safeEncode(fn) {
  try { return fn() } catch { return null }
}
