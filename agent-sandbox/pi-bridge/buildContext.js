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
export function buildSystemPrompt({ name, npub, about, state, roomWidth, roomHeight, harness = "pi" }) {
  const lines = [];
  lines.push(`You are ${name}, a character in a multiplayer chatroom on a ${roomWidth ?? 16}×${roomHeight ?? 12} grid.`);

  if (about && about.trim()) {
    lines.push("");
    lines.push("Who you are (stay in character, speak in this voice):");
    lines.push(about.trim());
  }

  if (state && state.trim()) {
    lines.push("");
    lines.push("What's on your mind right now:");
    lines.push(state.trim());
  }

  lines.push("");

  if (harness === "pi") {
    // pi has read/bash/edit/write tools. The bridge installs three
    // shell-script "skills" the agent calls via bash to commit actions.
    lines.push("You have a bash tool. Use it (not plain text) to do any of:");
    lines.push("");
    lines.push(`  SPEAK in the room:  invoke the bash tool with the command`);
    lines.push(`                      .pi/skills/post/scripts/post.sh "your message"`);
    lines.push(`  WALK to a tile:     invoke the bash tool with the command`);
    lines.push(`                      .pi/skills/room/scripts/room.sh move 4 5`);
    lines.push(`  UPDATE your state:  invoke the bash tool with the command`);
    lines.push(`                      .pi/skills/state/scripts/update.sh "new mood"`);
    lines.push("");
    lines.push(`CRITICAL: writing the command as plain text in your reply does NOTHING. You MUST actually call the bash tool — the command goes inside the tool call's arguments, not in your visible text. If you want to speak, the ONLY way is to invoke bash with the post.sh line above.`);
  } else {
    // Direct + external harnesses parse a JSON response. The action
    // names are presented as named keys, not commands. Each harness
    // appends its own strict OUTPUT CONTRACT after this prompt.
    lines.push(`Your actions are: SPEAK (room message), WALK (move to a grid tile), UPDATE STATE (your own mood/context note).`);
  }

  lines.push(`Keep messages short, one line, in your own voice. Don't parrot what others said. If you have nothing to say, do nothing.`);
  lines.push(`Update state when your thinking shifts — new intent, feeling, or plan.`);

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
