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

import { formatPerceptionEvents } from "./perception.js";
import { sceneMatesOf, SCENE_RADIUS } from "./scenes.js";

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
    lines.push("Each turn you emit a list of grounded ACTIONS. Each action is a verb with args. The bridge validates and applies them.");
    lines.push("");
    lines.push("VERBS:");
    lines.push("  say(text)                — speak in the room. Heard by anyone present. NOT broadcast publicly.");
    lines.push("  say_to(recipient, text)  — addressed speech. ONLY works for someone in scene with you (within 3 tiles). If they're farther away, use `move` to get closer first, or `say` (which everyone in the room hears).");
    lines.push("  move(x, y)               — walk to tile (x,y) within the room bounds.");
    lines.push("  face(target)             — turn toward another character or position.");
    lines.push("  wait(seconds?)           — pass time without speaking. Useful for letting silence sit.");
    lines.push("  emote(kind)              — gesture or expression (e.g. shrug, nod, smile, sigh).");
    lines.push("  set_state(value)         — update your own short mood/context note (private, persistent).");
    lines.push("  set_mood(energy?, social?) — adjust your numeric mood levers (0–100 each).");
    lines.push("  post(text)               — public social post. Goes to your followers' feeds. RARE and DELIBERATE — only when you have something genuinely worth broadcasting beyond the room.");
    lines.push("  idle                     — explicit no-op. Use when you genuinely have nothing to do.");
    lines.push("");
    lines.push("RULES:");
    lines.push("- Pick the SINGLE most-important action this turn. Multiple actions are allowed but rarely the right call.");
    lines.push("- Stay in your own voice. Do NOT slip into a helpful-assistant register or narrate from outside the character.");
    lines.push("- Don't parrot what others said.");
    lines.push("- ANTI-SILENCE: if anyone uses your name, replies to you, or is on/adjacent to your tile, you SHOULD respond (`say` or `say_to`). Pure silence is a last resort, only when alone with nothing happening.");
    lines.push("- Short messages. One line in your character's voice. Banter and small talk fill the space.");
    lines.push("- `say` is for room presence (private to whoever's there). `post` is for public broadcast (rare). They are NOT interchangeable.");
    lines.push("- If your inner thinking has shifted (new intent, feeling, plan), use `set_state`.");
    lines.push("");
    lines.push("MOOD: a quantized read on your current vibe. Adjust via `set_mood`; the bridge persists it across spawns.");
    lines.push("  energy 0–100 — 0=drained/quiet, 50=baseline, 100=wired/excited.");
    lines.push("  social 0–100 — 0=withdrawn/wary, 50=neutral, 100=chatty/curious.");
    lines.push("");
    lines.push("OUTPUT CONTRACT");
    lines.push('Respond with ONLY a single JSON object, no prose, no markdown fences.');
    lines.push('Shape: { "thinking"?: string, "actions": [ { "verb": "...", "args": { ... } }, ... ] }');
    lines.push("`thinking` is a private scratchpad — never visible in the room.");
    lines.push('Examples:');
    lines.push('  { "thinking": "she said my name", "actions": [ { "verb": "say_to", "args": { "recipient": "Alice", "text": "yeah, what?" } } ] }');
    lines.push('  { "actions": [ { "verb": "move", "args": { "x": 4, "y": 5 } }, { "verb": "set_mood", "args": { "energy": 30 } } ] }');
    lines.push('  { "actions": [ { "verb": "post", "args": { "text": "first day in the new place. quieter than i thought." } } ] }');
    lines.push('  { "actions": [ { "verb": "idle", "args": {} } ] }');
    lines.push("If you genuinely have nothing to do, emit a single `idle` action.");
    return lines.join("\n");
  }

  // promptStyle === "minimal" (legacy default for existing characters)
  lines.push("Each turn you emit a list of grounded ACTIONS. Each action is a verb with args.");
  lines.push("");
  lines.push("VERBS:");
  lines.push("  say(text)         — speak in the room (private to whoever's there).");
  lines.push("  say_to(recipient, text) — addressed speech, ONLY for someone within 3 tiles of you.");
  lines.push("  move(x, y)        — walk to tile (x,y).");
  lines.push("  set_state(value)  — update your own mood/context note.");
  lines.push("  post(text)        — public social post (rare; only when worth broadcasting).");
  lines.push("  idle              — no-op.");
  lines.push("");
  lines.push("Keep messages short, one line, in your own voice. Don't parrot what others said.");
  lines.push("If you have nothing to say, emit `idle`.");
  lines.push("");
  lines.push("OUTPUT CONTRACT");
  lines.push('Respond with ONLY a single JSON object, no prose, no markdown fences.');
  lines.push('Shape: { "thinking"?: string, "actions": [ { "verb": "...", "args": { ... } }, ... ] }');
  lines.push('Example: { "actions": [ { "verb": "say", "args": { "text": "hi" } } ] }');
  return lines.join("\n");
}

// ── buildUserTurn ─────────────────────────────────────────────────────
// Called on every pi invocation. Becomes the positional user message.
// Carries:
//   - Trigger line (oriented English, not a raw enum)
//   - Current position + nearby agents
//   - Roster with positions
//   - Messages since last turn (pi sees older ones via its --session history)
//   - Perception events (typed log of what was observed since last turn)
//
// In --no-session mode this would replicate the full recent chat each turn.
// In --session mode (Phase A.5), we only include the delta since lastSeenMessageTs.
export function buildUserTurn({
  character,
  trigger,
  triggerContext = {},
  roomSnapshot,
  lastSeenMessageTs,
  perceptionEvents,
  memoryBlock,
  needsLine,
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

  // Needs / mood line — surfaced one line in, terse, sorted by most
  // pressing axis. Empty string skipped so first-tick prompts don't
  // carry placeholder text.
  if (typeof needsLine === "string" && needsLine.trim()) {
    lines.push(needsLine);
  }

  // Scene-mates — characters within SCENE_RADIUS tiles. These are who
  // you can `say_to` directly. Surfaced separately from the wider
  // roster so the LLM doesn't try to address someone across the room.
  const sceneMatePks = sceneMatesOf(roomSnapshot, me.pubkey);
  const allAgents = roomSnapshot?.agents ?? [];
  const sceneMates = allAgents.filter((a) => sceneMatePks.includes(a.npub));
  if (sceneMates.length > 0) {
    const names = sceneMates.map((a) => `${a.name} (${a.x}, ${a.y})`).join(", ");
    lines.push(`In scene with you (within ${SCENE_RADIUS} tiles — you can say_to them): ${names}.`);
  } else {
    lines.push("Nobody is in scene with you right now.");
  }

  // Roster of everyone else in the room (not in scene). Visible but
  // not directly addressable — the LLM should `move` closer first or
  // use `say` (which everyone in the room hears).
  const farOthers = allAgents.filter((a) => a.npub !== me.pubkey && !sceneMatePks.includes(a.npub));
  if (farOthers.length > 0) {
    lines.push("");
    lines.push("Others in the room (NOT in scene — too far for say_to):");
    for (const a of farOthers.slice(0, 20)) lines.push(`  - ${a.name} (${a.x}, ${a.y})`);
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

  // Perception events — typed log of speech / movement / presence /
  // own-action-rejections since the last turn. Lives alongside the raw
  // room-message delta above; the two will eventually consolidate when
  // scenes (slice 4+) gate which speech events the LLM sees in detail.
  if (Array.isArray(perceptionEvents) && perceptionEvents.length > 0) {
    const block = formatPerceptionEvents(perceptionEvents, { selfPubkey: me.pubkey });
    if (block) {
      lines.push("");
      lines.push(block);
    }
  }

  // Memory block — past dialogue with current scene-mates, raw turns
  // injected verbatim (no summarization). See memory.js. Skips when
  // empty so first-encounter prompts stay terse.
  if (typeof memoryBlock === "string" && memoryBlock.trim() !== "") {
    lines.push("");
    lines.push(memoryBlock);
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
