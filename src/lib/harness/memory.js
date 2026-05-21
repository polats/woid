/**
 * Memory injection — when two characters are in scene together, look
 * up their past closed scenes from the journal and format the most
 * recent dialogue as a context block to inject into the next user
 * turn.
 *
 * The deliberate choice: NO LLM SUMMARIZATION. The LLM reads its own
 * past words verbatim. This is the cheapest possible "memory" model
 * (one journal read per turn), and it produces drift over time
 * naturally — turn 100's perception literally contains turns 1-99's
 * dialogue, so the character's voice evolves as their record grows.
 *
 * Budget knobs (defaults from #225):
 *   maxScenesPerMate   — last N scenes between this pair (2)
 *   maxTurnsPerScene   — last M turns per scene (6)
 *   maxBlockChars      — hard ceiling on total injected size (~3200
 *                        chars ≈ 800 tokens)
 *
 * If a scene's tail exceeds the per-scene turn cap, we keep the most
 * recent turns (closer to the "current" tone). If the total block
 * exceeds maxBlockChars, we drop oldest scenes first.
 */

export const DEFAULTS = {
  maxScenesPerMate: 2,
  maxTurnsPerScene: 6,
  maxBlockChars: 3200,
};

/**
 * Build the memory block to inject into a user turn for `selfPubkey`,
 * given the current scene-mates (other pubkeys in scene with self).
 *
 * @param {{
 *   selfPubkey: string,
 *   selfName?: string,
 *   sceneMates: Array<{ pubkey: string, name?: string }>,
 *   recentScenesBetween: (a: string, b: string, opts: { limit: number }) => Array<object>,
 * }} ctx
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {string} the formatted block ("" if no past)
 */
export function buildMemoryBlock(ctx, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!ctx?.selfPubkey || !Array.isArray(ctx.sceneMates) || ctx.sceneMates.length === 0) {
    return "";
  }

  const sections = [];
  for (const mate of ctx.sceneMates) {
    if (!mate?.pubkey) continue;
    const past = ctx.recentScenesBetween(ctx.selfPubkey, mate.pubkey, {
      limit: cfg.maxScenesPerMate,
    });
    if (!past || past.length === 0) continue;

    const lines = [`You and ${mate.name || shortPub(mate.pubkey)} have spoken before:`];
    // Render oldest → newest within this mate so the chronology reads
    // top-to-bottom. We received newest-first from the journal.
    const ordered = [...past].reverse();
    for (const scene of ordered) {
      lines.push("");
      lines.push(`[scene ${scene.scene_id} · ended: ${scene.end_reason || "?"}]`);
      const tail = (scene.turns || []).slice(-cfg.maxTurnsPerScene);
      for (const t of tail) {
        const rendered = renderTurn(t, ctx.selfPubkey);
        if (rendered) lines.push("  " + rendered);
      }
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return "";

  // Concatenate sections separated by a blank line. Trim from the
  // OLDEST sections forward (mate by mate) until the total is within
  // the char budget. The most recently-relevant memories survive.
  let block = sections.join("\n\n");
  while (block.length > cfg.maxBlockChars && sections.length > 1) {
    sections.shift();
    block = sections.join("\n\n");
  }
  // If a single section is still too long, hard-truncate with an
  // ellipsis marker so the LLM knows the memory was abbreviated.
  if (block.length > cfg.maxBlockChars) {
    block = block.slice(0, cfg.maxBlockChars - 24) + "\n…(memory truncated)";
  }
  return block;
}

// ── helpers ──

function renderTurn(turn, selfPubkey) {
  if (!turn || typeof turn.verb !== "string") return null;
  const who = turn.actor_pubkey === selfPubkey
    ? "you"
    : (turn.actor_name || shortPub(turn.actor_pubkey));
  const args = turn.args || {};
  switch (turn.verb) {
    case "say":
      return `${who}: "${truncate(args.text)}"`;
    case "say_to": {
      const to = args.recipient || "?";
      return `${who} → ${to}: "${truncate(args.text)}"`;
    }
    case "post":
      return `${who} posted: "${truncate(args.text)}"`;
    case "move":
      return `${who} moved to (${args.x}, ${args.y}).`;
    case "face":
      return `${who} turned toward ${args.target}.`;
    case "emote":
      return `${who} ${args.kind}.`;
    case "set_state":
      return `${who} (state shift).`;
    case "set_mood":
      return `${who} (mood shift).`;
    case "wait":
      return `${who} waited.`;
    case "idle":
      return null; // skip — pure no-ops add noise
    default:
      return `${who} ${turn.verb}.`;
  }
}

function truncate(s, max = 240) {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function shortPub(p) {
  return typeof p === "string" ? p.slice(0, 8) : "someone";
}
