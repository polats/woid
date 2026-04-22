/**
 * Build the full prompt context for a character.
 * Mirrors call-my-agent/_shared/buildContext.ts so logic can port across
 * projects. Character-agnostic — works for any agent.
 *
 * Split into two exports:
 *   buildSystemPrompt(character)   — static-ish identity + tools manual.
 *                                    Passed to pi as --system-prompt.
 *   buildUserTurn({ trigger, ... }) — the dynamic delta for this turn.
 *                                    Becomes the positional user message on
 *                                    each pi --print invocation.
 *
 * The system prompt rarely changes across turns (same identity, same tool
 * manual); the user turn carries everything that changed since the last
 * run so pi's --session-backed history sees it as a normal user message.
 */

const TRIGGER_MAP = {
  spawn: () => `You just stepped into the room.`,
  message_received: (ctx) =>
    `You received a message from ${ctx.fromName ?? "someone"}.`,
  arrival: (ctx) =>
    `${ctx.fromName ?? "Someone"} just arrived at (${ctx.x ?? "?"}, ${ctx.y ?? "?"}).`,
  departure: (ctx) =>
    `${ctx.fromName ?? "Someone"} just left the room.`,
  heartbeat: () =>
    `A moment has passed. You're still here, still listening.`,
  conversation_idle: () =>
    `The room has gone quiet — nobody has said anything in a while.`,
  compaction_requested: () =>
    `The bridge asked you to summarize what's been happening.`,
};

function formatTrigger(trigger, ctx = {}) {
  const fn = TRIGGER_MAP[trigger];
  if (typeof fn === "function") return fn(ctx);
  return trigger;
}

function nearby(me, agents, maxDist = 1) {
  return agents.filter(
    (a) =>
      a.npub !== me.pubkey &&
      Math.max(Math.abs((a.x ?? 0) - me.x), Math.abs((a.y ?? 0) - me.y)) <= maxDist,
  );
}

// ── buildSystemPrompt ─────────────────────────────────────────────────
// Called on every pi invocation. Passed via --system-prompt. Varies
// slowly: identity never changes, `state` evolves (Phase C), tool manual
// is static. Keep short — every character counts against context.
export function buildSystemPrompt({ name, npub, about, state, roomWidth, roomHeight }) {
  const lines = [];
  lines.push(`You are ${name}.`);
  lines.push(`Your Nostr pubkey (hex) is ${npub}.`);

  if (about && about.trim()) {
    lines.push("");
    lines.push("This is who you are — stay in character, speak in this voice:");
    lines.push(about.trim());
  }

  if (state && state.trim()) {
    lines.push("");
    lines.push("Where your head is right now (you update this as you go):");
    lines.push(state.trim());
  }

  lines.push("");
  lines.push(
    `The room is a ${roomWidth ?? 16}×${roomHeight ?? 12} grid. Coordinates are 0-indexed. Your recent conversation and the room state arrive in each user message as a prefixed block.`,
  );

  lines.push("");
  lines.push(`Tools available to you (run them via bash):`);
  lines.push(`  bash .pi/skills/post/scripts/post.sh "your message"       — speak in the room`);
  lines.push(`  bash .pi/skills/room/scripts/room.sh move <x> <y>         — move to a tile`);
  lines.push("");
  lines.push(
    `Read .pi/skills/*/SKILL.md for each tool's details. Use ONLY these scripts — do not try curl or nostr-tools directly.`,
  );
  lines.push(`Keep posts short. Write in your own voice. Don't repeat what someone else just said.`);
  lines.push(`You don't have to move or speak every turn. Standing still and saying nothing is a valid choice.`);

  return lines.join("\n");
}

// ── buildUserTurn ─────────────────────────────────────────────────────
// Called on every pi invocation. Becomes the positional user message.
// Carries:
//   - Trigger line (oriented English, not a raw enum)
//   - Current position + nearby agents
//   - Roster with positions
//   - Messages since last turn (pi sees older ones via its --session history)
//
// In --no-session mode this would replicate the full recent chat each turn.
// In --session mode (Phase A.5), we only include the delta since lastSeenMessageTs.
export function buildUserTurn({
  character,
  trigger,
  triggerContext = {},
  roomSnapshot,
  lastSeenMessageTs,
  seedMessage,
}) {
  const lines = [];

  // Trigger orientation — matches call-my-agent's style verbatim.
  lines.push(`Trigger: ${formatTrigger(trigger, triggerContext)}`);
  lines.push("");

  // Situation
  const me = {
    pubkey: character.pubkey,
    x: character.x ?? 0,
    y: character.y ?? 0,
  };
  lines.push(`You are at (${me.x}, ${me.y}).`);

  const adj = nearby(me, roomSnapshot?.agents ?? []);
  if (adj.length > 0) {
    const names = adj.map((a) => `${a.name} (${a.x}, ${a.y})`).join(", ");
    lines.push(`Also on your tile or adjacent: ${names}.`);
  }

  // Roster
  const others = (roomSnapshot?.agents ?? []).filter((a) => a.npub !== me.pubkey);
  if (others.length > 0) {
    lines.push("");
    lines.push("Others in the room:");
    for (const a of others.slice(0, 20)) lines.push(`  - ${a.name} (${a.x}, ${a.y})`);
  }

  // New messages since last turn. Pi's session history carries anything
  // the agent saw in earlier turns — we only include the *delta* here so
  // we don't duplicate context pi already has. On the very first turn
  // (spawn) lastSeenMessageTs will be undefined; we still skip replaying
  // pre-spawn history since the agent wasn't there for it.
  const allMsgs = roomSnapshot?.messages ?? [];
  const msgs = typeof lastSeenMessageTs === "number"
    ? allMsgs.filter((m) => (m.ts ?? 0) > lastSeenMessageTs)
    : [];
  if (msgs.length > 0) {
    lines.push("");
    lines.push("New in the room since your last turn:");
    for (const m of msgs) lines.push(`  ${m.from}: "${(m.text ?? "").slice(0, 200)}"`);
  }

  // Seed message — only used on the very first turn (spawn trigger) or
  // when the caller wants to nudge the agent with an instruction.
  if (seedMessage) {
    lines.push("");
    lines.push(seedMessage);
  }

  return lines.join("\n");
}

// Back-compat export so existing callers keep working while we migrate.
// Returns the concatenation; equivalent to --no-session's old behavior.
export function buildSystemPromptLegacy(args) {
  const sys = buildSystemPrompt({
    name: args.name,
    npub: args.npub,
    about: args.about,
    roomWidth: args.roomSnapshot?.width,
    roomHeight: args.roomSnapshot?.height,
  });
  const user = buildUserTurn({
    character: { pubkey: args.npub, x: 0, y: 0 },
    trigger: "spawn",
    triggerContext: {},
    roomSnapshot: args.roomSnapshot,
    seedMessage: args.seedMessage,
  });
  return `${sys}\n\n${user}`;
}
