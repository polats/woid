/**
 * Scene awareness — proximity-based grouping derived from the live
 * room snapshot.
 *
 * Two characters are "in a scene together" when they share a room and
 * are within `SCENE_RADIUS` tiles (Chebyshev distance — same metric the
 * existing `nearby` helper in buildContext.js uses for the "adjacent"
 * check). A character is "in a scene" if at least one other character
 * is within radius.
 *
 * No state of its own — every helper is a pure function over a
 * snapshot. That keeps scene awareness fully derivable from positions,
 * which already replicate through Colyseus, and avoids us having to
 * keep a parallel scene table in sync. Slice 5 (conversation gate)
 * adds the per-pair scene-id + cooldown layer on top.
 *
 * The pubkey-or-name resolver is here too — `say_to`'s recipient
 * argument is whatever the LLM emitted (a name, an npub, a hex
 * pubkey), and the GM needs to map it to a real pubkey to validate
 * scene-mate membership.
 */

export const SCENE_RADIUS = 3;

/**
 * Chebyshev distance — `max(|dx|, |dy|)`. Diagonal-friendly metric.
 */
export function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs((a.x ?? 0) - (b.x ?? 0)), Math.abs((a.y ?? 0) - (b.y ?? 0)));
}

/**
 * Are these two characters in a scene together?
 *
 * @param {{ agents?: Array<{ npub?: string, x?: number, y?: number }> }} snapshot
 * @param {string} pubkeyA
 * @param {string} pubkeyB
 * @param {number} [radius]
 */
export function inScene(snapshot, pubkeyA, pubkeyB, radius = SCENE_RADIUS) {
  if (!snapshot || pubkeyA === pubkeyB) return false;
  const a = findAgent(snapshot, pubkeyA);
  const b = findAgent(snapshot, pubkeyB);
  if (!a || !b) return false;
  return chebyshev(a, b) <= radius;
}

/**
 * Return the pubkeys of every character within radius of `pubkey`,
 * not including the actor themselves. If the actor isn't in the
 * snapshot, returns [].
 *
 * @param {object} snapshot
 * @param {string} pubkey
 * @param {number} [radius]
 * @returns {string[]}
 */
export function sceneMatesOf(snapshot, pubkey, radius = SCENE_RADIUS) {
  if (!snapshot || !pubkey) return [];
  const me = findAgent(snapshot, pubkey);
  if (!me) return [];
  const out = [];
  for (const a of snapshot.agents ?? []) {
    if (!a?.npub || a.npub === pubkey) continue;
    if (chebyshev(me, a) <= radius) out.push(a.npub);
  }
  return out;
}

/**
 * Convenience: is this character in any scene at all?
 */
export function isInScene(snapshot, pubkey, radius = SCENE_RADIUS) {
  return sceneMatesOf(snapshot, pubkey, radius).length > 0;
}

/**
 * Resolve a recipient string emitted by the LLM (name, npub, or hex
 * pubkey) to a hex pubkey present in the snapshot. Returns null if no
 * agent matches.
 *
 * Matching priority:
 *   1. Exact npub match (already a hex/npub form).
 *   2. Exact name match (case-insensitive).
 *   3. Prefix match on hex pubkey (>= 8 chars).
 *
 * Names are not unique by design (two agents can be called Bob), so
 * exact-match-first then prefix-match keeps the obvious cases working
 * without surprising fuzzy hits.
 *
 * @param {object} snapshot
 * @param {string} recipient
 * @returns {string|null}
 */
export function resolveRecipient(snapshot, recipient) {
  if (!snapshot || typeof recipient !== "string") return null;
  const trimmed = recipient.trim().replace(/^@/, "");
  if (trimmed === "") return null;
  const agents = snapshot.agents ?? [];

  // 1) exact npub / pubkey
  for (const a of agents) {
    if (a?.npub && a.npub === trimmed) return a.npub;
  }

  // 2) case-insensitive name
  const lower = trimmed.toLowerCase();
  for (const a of agents) {
    if (a?.name && a.name.toLowerCase() === lower) return a.npub ?? null;
  }

  // 3) hex prefix (>= 8 chars). Cheap protection against single-letter
  //    matches resolving silently.
  if (trimmed.length >= 8 && /^[0-9a-f]+$/i.test(trimmed)) {
    for (const a of agents) {
      if (a?.npub?.startsWith(trimmed)) return a.npub;
    }
  }

  return null;
}

// ── helpers ──

function findAgent(snapshot, pubkey) {
  if (!snapshot || !pubkey) return null;
  for (const a of snapshot.agents ?? []) {
    if (a?.npub === pubkey) return a;
  }
  return null;
}
