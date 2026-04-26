/**
 * Perception event ring buffer — typed log of "what each character
 * has observed since their last turn."
 *
 * This is the substrate every later phase reads from: schedule events
 * (#235), object state changes (#245), relationship transitions
 * (#255), scare events (haunted-house campaign), all become more
 * event kinds appended here.
 *
 * What we already had: room snapshots (positions, message tail) in
 * Colyseus state. That's adequate for "what does the world look like
 * right now" but blind to *moments*. Perception events fill that gap.
 *
 * Slice 3 ships four event kinds:
 *
 *   speech          — another character spoke (in scene, addressed, or
 *                     ambient). Speech also lives in roomSnapshot.messages
 *                     today; this typed copy is what slice 4 will filter
 *                     by scene-mate when scenes land.
 *   movement        — another character moved.
 *   presence        — another character joined or left the room.
 *   action_rejected — the actor's own attempt was rejected by the GM;
 *                     they see the reason on their next turn.
 *
 * Each character has a per-pubkey ring buffer (default 50 entries).
 * `buildUserTurn` calls `drainSince(pubkey, lastSeenTs)` to get
 * everything they haven't yet been told, formats it as a "Recent
 * events:" block, and updates `lastSeenTs` to the newest event.
 *
 * No persistence. The bridge dies, the buffers die. That's deliberate
 * for slice 3 — perception is a hot signal, not a record. Scene
 * transcripts (slice 6) are the durable record.
 */

const DEFAULT_BUFFER_SIZE = 50;

/**
 * Create a fresh perception store.
 *
 * @param {{ bufferSize?: number, now?: () => number }} [opts]
 */
export function createPerception(opts = {}) {
  const bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const now = opts.now ?? (() => Date.now());

  /** @type {Map<string, Array<object>>} pubkey → ring buffer (newest at end) */
  const buffers = new Map();

  function getBuffer(pubkey) {
    let buf = buffers.get(pubkey);
    if (!buf) {
      buf = [];
      buffers.set(pubkey, buf);
    }
    return buf;
  }

  /**
   * Append a single event to one character's buffer.
   * If `event.ts` is missing, it's set to now() automatically.
   * If `event.kind` is missing, the call is a no-op.
   */
  function appendOne(targetPubkey, event) {
    if (!targetPubkey || !event || typeof event !== "object") return;
    if (typeof event.kind !== "string" || event.kind === "") return;
    const stamped = { ts: event.ts ?? now(), ...event };
    const buf = getBuffer(targetPubkey);
    buf.push(stamped);
    while (buf.length > bufferSize) buf.shift();
  }

  /**
   * Append the same event to every character in `targets` except
   * the optional `exceptPubkey` (typically the actor themselves —
   * you don't perceive your own action this way).
   *
   * @param {string[]} targets
   * @param {object} event
   * @param {string} [exceptPubkey]
   */
  function broadcastTo(targets, event, exceptPubkey) {
    if (!Array.isArray(targets)) return;
    const stamped = { ts: event?.ts ?? now(), ...event };
    for (const pk of targets) {
      if (!pk || pk === exceptPubkey) continue;
      appendOne(pk, stamped);
    }
  }

  /**
   * Return all events with `ts > sinceTs` for `pubkey`. The buffer is
   * not mutated — the caller bumps `lastSeenEventTs` itself once the
   * events have been delivered (matches how the existing
   * `lastSeenMessageTs` filter works in buildUserTurn).
   *
   * @param {string} pubkey
   * @param {number} [sinceTs] — filter out events at or before this ts
   * @returns {Array<object>}
   */
  function eventsSince(pubkey, sinceTs) {
    const buf = buffers.get(pubkey);
    if (!buf || buf.length === 0) return [];
    if (typeof sinceTs !== "number") return buf.slice();
    return buf.filter((e) => (e.ts ?? 0) > sinceTs);
  }

  /** Clear a single character's buffer (e.g. on agent stop). */
  function clear(pubkey) {
    buffers.delete(pubkey);
  }

  /** Clear everything (e.g. on test teardown). */
  function clearAll() {
    buffers.clear();
  }

  /** Inspect a buffer (for tests / debugging). */
  function snapshot(pubkey) {
    const buf = buffers.get(pubkey);
    return buf ? buf.slice() : [];
  }

  return {
    appendOne,
    broadcastTo,
    eventsSince,
    clear,
    clearAll,
    snapshot,
  };
}

/**
 * Format an array of perception events as a human-readable block to
 * inject into the LLM's user-turn prompt. Returns "" for empty input.
 */
export function formatPerceptionEvents(events, { selfPubkey } = {}) {
  if (!Array.isArray(events) || events.length === 0) return "";
  const lines = ["Recent events:"];
  for (const ev of events) {
    const formatted = formatOne(ev, selfPubkey);
    if (formatted) lines.push("  " + formatted);
  }
  return lines.length === 1 ? "" : lines.join("\n");
}

function formatOne(ev, selfPubkey) {
  if (!ev || typeof ev.kind !== "string") return null;
  switch (ev.kind) {
    case "speech": {
      const who = ev.from_name || (ev.from_pubkey ? ev.from_pubkey.slice(0, 8) : "someone");
      if (ev.addressed_to_npub && ev.addressed_to_npub === selfPubkey) {
        return `${who} (to you): "${truncate(ev.text)}"`;
      }
      if (ev.addressed_to_name) {
        return `${who} → ${ev.addressed_to_name}: "${truncate(ev.text)}"`;
      }
      return `${who}: "${truncate(ev.text)}"`;
    }
    case "movement": {
      const who = ev.who_name || (ev.who_pubkey ? ev.who_pubkey.slice(0, 8) : "someone");
      return `${who} moved to (${ev.x}, ${ev.y}).`;
    }
    case "presence": {
      const who = ev.who_name || (ev.who_pubkey ? ev.who_pubkey.slice(0, 8) : "someone");
      return ev.what === "left"
        ? `${who} left the room.`
        : `${who} joined the room.`;
    }
    case "action_rejected":
      return `(your attempt to ${ev.verb || "act"} was rejected: ${ev.reason || "unknown reason"})`;
    case "scene_open": {
      const others = (ev.with_pubkeys || []).filter((p) => p !== selfPubkey);
      const who = others.length === 1 ? others[0].slice(0, 8) : others.join(", ");
      return `(scene opened — you and ${who} are now in conversation)`;
    }
    case "scene_close": {
      const others = (ev.with_pubkeys || []).filter((p) => p !== selfPubkey);
      const who = others.length === 1 ? others[0].slice(0, 8) : others.join(", ");
      const reasonText = SCENE_CLOSE_REASONS[ev.reason] || `closed (${ev.reason || "?"})`;
      return `(scene with ${who} ${reasonText})`;
    }
    case "need_low": {
      const flavor = NEED_LOW_FLAVOR[ev.axis] || `low on ${ev.axis}`;
      const v = typeof ev.value === "number" ? ` (${ev.value})` : "";
      return `(your ${ev.axis} just dropped${v} — ${flavor})`;
    }
    default:
      return null;
  }
}

const NEED_LOW_FLAVOR = {
  energy: "feeling drained",
  social: "feeling withdrawn",
  curiosity: "feeling bored, restless",
};

const SCENE_CLOSE_REASONS = {
  budget: "ended naturally — give them space for a few minutes",
  soft_stop: "wound down quietly",
  hard_cap: "ran long; stepping back",
  proximity_lost: "ended when you parted",
};

function truncate(s, max = 240) {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
