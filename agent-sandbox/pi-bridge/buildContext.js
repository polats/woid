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
// Called on every pi invocation. Passed via --system-prompt.
//
// `promptStyle` selects between two variants for non-pi harnesses:
//
//   minimal — short, generic. The original DirectHarness shape:
//             "speak/walk/update", terse rules, no anti-silence guidance.
//             Existing characters default to this so behavior stays
//             identical until the user opts in.
//
//   dynamic — adapted from the call-my-ghost prompt comparison:
//             * numeric mood lever ({ energy, social } 0–100)
//             * anti-silence rule for addressed/adjacent agents
//             * one-action-per-turn emphasis
//             * tone lock against the LLM's helpful-assistant default
//             New characters spawned without an explicit style get
//             this; users can A/B by setting one character's style to
//             "minimal" and another's to "dynamic" in the same room.
//
// Pi's prompt is unaffected by promptStyle — its skill/bash machinery
// is the same regardless of which prompt the bridge would have built
// for an in-process brain.
export function buildSystemPrompt({
  name, npub, about, state,
  roomWidth, roomHeight,
  harness = "pi",
  promptStyle = "minimal",
}) {
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
    lines.push(`Keep messages short, one line, in your own voice. Don't parrot what others said. If you have nothing to say, do nothing.`);
    lines.push(`Update state when your thinking shifts — new intent, feeling, or plan.`);
    return lines.join("\n");
  }

  // ── direct + external paths ──

  if (promptStyle === "dynamic") {
    lines.push("Your actions are: SPEAK (room message), WALK (move to a grid tile), UPDATE STATE (your own mood/context note), ADJUST MOOD (two numeric levers).");
    lines.push("");
    lines.push("RULES:");
    lines.push("- Pick the SINGLE most-important action this turn. Multiple actions are allowed but rarely the right call.");
    lines.push("- Stay in your own voice. Do NOT slip into a helpful-assistant register or narrate from outside the character.");
    lines.push("- Don't parrot what others said.");
    lines.push("- ANTI-SILENCE: if anyone uses your name, replies to you, or is on/adjacent to your tile, you SHOULD respond. Pure silence is a last resort, only when alone with nothing happening.");
    lines.push("- Short messages. One line in your character's voice. Banter and small talk fill the space.");
    lines.push("- If your inner thinking has shifted (new intent, feeling, plan), update `state` to reflect it.");
    lines.push("");
    lines.push("MOOD: a quantized read on your current vibe. Adjust as turns unfold; the bridge persists it across spawns.");
    lines.push("  energy 0–100 — 0=drained/quiet, 50=baseline, 100=wired/excited.");
    lines.push("  social 0–100 — 0=withdrawn/wary, 50=neutral, 100=chatty/curious.");
    lines.push("Examples:");
    lines.push("  - high social + room is silent → start a conversation. raise mood.social slightly.");
    lines.push("  - low social + addressed by name → reply briefly, drop mood.social a notch.");
    lines.push("  - low energy after lots of chatter → consider a move/state turn instead of more speech.");
    lines.push("");
    lines.push("OUTPUT CONTRACT");
    lines.push('Respond with ONLY a single JSON object, no prose, no markdown fences.');
    lines.push('Shape: { "thinking"?: string, "say"?: string, "move"?: { "x": int, "y": int }, "state"?: string, "mood"?: { "energy": int, "social": int } }');
    lines.push("Omit any key you don't want to act on. Do not invent new keys.");
    lines.push("`thinking` is a private scratchpad — never visible in the room.");
    lines.push("`say` is shown in the room as your character's message (≤ 200 chars).");
    lines.push("`move` moves your character to tile (x,y) within the room bounds.");
    lines.push("`state` updates your own short mood/context note (≤ 200 chars).");
    lines.push("`mood` updates one or both of your numeric levers (0–100 each).");
    lines.push("If you're alone and nothing demands action, return {} — but only after considering whether a brief `state` or `mood` adjustment fits.");
    return lines.join("\n");
  }

  // promptStyle === "minimal" (legacy default for existing characters)
  lines.push(`Your actions are: SPEAK (room message), WALK (move to a grid tile), UPDATE STATE (your own mood/context note).`);
  lines.push(`Keep messages short, one line, in your own voice. Don't parrot what others said. If you have nothing to say, do nothing.`);
  lines.push(`Update state when your thinking shifts — new intent, feeling, or plan.`);
  lines.push("");
  lines.push("OUTPUT CONTRACT");
  lines.push('Respond with ONLY a single JSON object, no prose, no markdown fences.');
  lines.push('Shape: { "thinking"?: string, "say"?: string, "move"?: { "x": int, "y": int }, "state"?: string }');
  lines.push("Omit any key you don't want to act on. Do not invent new keys.");
  lines.push("`say` is shown in the room as your character's message.");
  lines.push("`move` moves your character to tile (x,y) within the room bounds.");
  lines.push("`state` updates your own short mood/context note (≤ 200 chars).");
  lines.push("If you have nothing to say or do this turn, return {}");
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
