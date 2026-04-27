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

import { formatPerceptionEvents, partitionStorytellerEvents } from "./perception.js";
import { sceneMatesOf, SCENE_RADIUS } from "./scenes.js";
import { OBJECT_TYPES } from "./objects.js";
import { VERBS } from "./gm.js";
import { NEED_AXES, NEED_AXIS_DOCS, DEFAULTS as NEEDS_DEFAULTS } from "./needs.js";

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

function formatRealClock(ms) {
  const t = Number.isFinite(ms) ? ms : Date.now();
  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mn = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mn} UTC`;
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

  // World-fact and rules blocks are shared across all harnesses so
  // every brain sees the same SCENE_RADIUS, NEEDS axes, and prompt
  // style. The action contract differs:
  //   - direct/external: emit JSON
  //   - pi:              invoke bash skills

  if (harness === "pi") {
    lines.push(...formatPiActionsBlock());
    lines.push("");
    lines.push(...formatRulesBlock({ piMode: true }));
    lines.push("");
    lines.push(...formatNeedsBlock({ piMode: true }));
    return lines.join("\n");
  }

  // ── direct + external paths ──

  if (promptStyle === "dynamic") {
    lines.push("Each turn you emit a list of grounded ACTIONS. Each action is a verb with args. The bridge validates and applies them.");
    lines.push("");
    lines.push(...formatVerbsBlock());
    lines.push("");
    lines.push(...formatRulesBlock({ piMode: false }));
    lines.push("");
    lines.push(...formatNeedsBlock());
    lines.push("");
    lines.push(...formatJsonOutputContract());
    return lines.join("\n");
  }

  // promptStyle === "minimal" — terse variant; same structure, less prose.
  lines.push("Each turn you emit a list of grounded ACTIONS. Each action is a verb with args.");
  lines.push("");
  lines.push(...formatVerbsBlock());
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

// ── prompt fragment generators ────────────────────────────────────────
//
// Pulled out so adding a verb / need axis / world signal updates the
// prompt automatically. Keeps the prose (rules, philosophy) authored
// in buildSystemPrompt above; only the *facts* are dynamic.

/**
 * Pi-flavoured actions block. Same verb set as direct/external (sourced
 * from gm.js's VERBS), but only includes verbs with a `piExample` —
 * those are the ones with a corresponding bash skill. Other verbs are
 * not yet accessible to pi (no shell script exists).
 *
 * When a generic dispatch.sh skill ships later, this block can swap to
 * "echo {verb,args} JSON via dispatch" and pi gets full verb parity.
 */
function formatPiActionsBlock() {
  const out = [];
  out.push("You have a bash tool. To take an action, invoke it with the matching command:");
  out.push("");

  // Build aligned verb signature → example pairs. Skip verbs without
  // a shell skill — those simply aren't accessible to pi yet.
  const rows = [];
  let maxSig = 0;
  for (const [name, def] of Object.entries(VERBS)) {
    if (!def?.piExample || !def?.prompt) continue;
    const sig = `${name}${verbSignature(def.args)}`;
    rows.push({ sig, def });
    if (sig.length > maxSig) maxSig = sig.length;
  }
  for (const { sig, def } of rows) {
    out.push(`  ${sig.padEnd(maxSig, " ")}  — ${def.prompt}`);
    out.push(`  ${" ".repeat(maxSig)}    bash: ${def.piExample}`);
  }
  out.push("");
  out.push("CRITICAL: writing the command as plain text in your reply does NOTHING. You MUST actually invoke the bash tool — the command goes inside the tool call's arguments, not in your visible text.");
  return out;
}

/**
 * Shared rules block. The pi-mode flag drops references to verbs that
 * pi can't invoke (`set_mood`, `post`, etc.) and re-anchors the speech-
 * vs-broadcast distinction in pi-friendly terms.
 */
function formatRulesBlock({ piMode }) {
  const out = ["RULES:"];
  out.push("- Pick the SINGLE most-important action this turn.");
  out.push("- Stay in your own voice. Do NOT slip into a helpful-assistant register or narrate from outside the character.");
  out.push("- Don't parrot what others said.");
  out.push(`- ANTI-SILENCE: if anyone uses your name, replies to you, or is in scene with you (within ${SCENE_RADIUS} tiles), you SHOULD respond. Pure silence is a last resort, only when alone with nothing happening.`);
  out.push("- Short messages. One line in your character's voice. Banter and small talk fill the space.");
  out.push("- ROUTINE: if a perception event mentions where your routine takes you, decide based on your character — usually move there with `move(x, y)`, but stay if your mood, what's happening, or who you are argues otherwise. Don't narrate the routine; act on it.");
  if (!piMode) {
    out.push("- `say` is for room presence (private to whoever's there). `post` is for public broadcast (rare). They are NOT interchangeable.");
    out.push("- If your inner thinking has shifted (new intent, feeling, plan), use `set_state`.");
  } else {
    out.push("- Update your state when your thinking shifts — new intent, feeling, or plan.");
  }
  return out;
}

/**
 * Direct/external JSON output contract block. Pi has its own contract
 * (invoke bash) handled in formatPiActionsBlock.
 */
function formatJsonOutputContract() {
  return [
    "OUTPUT CONTRACT",
    "Respond with ONLY a single JSON object, no prose, no markdown fences.",
    'Shape: { "thinking"?: string, "actions": [ { "verb": "...", "args": { ... } }, ... ] }',
    "`thinking` is a private scratchpad — never visible in the room.",
    "Examples:",
    '  { "thinking": "she said my name", "actions": [ { "verb": "say_to", "args": { "recipient": "Alice", "text": "yeah, what?" } } ] }',
    '  { "actions": [ { "verb": "move", "args": { "x": 4, "y": 5 } }, { "verb": "set_mood", "args": { "energy": 30 } } ] }',
    '  { "actions": [ { "verb": "post", "args": { "text": "first day in the new place. quieter than i thought." } } ] }',
    '  { "actions": [ { "verb": "post", "args": { "text": "the watch keeps better time than i do.", "image_prompt": "a silver pocket watch on a wooden counter, morning light through the window" } } ] }',
    '  { "actions": [ { "verb": "idle", "args": {} } ] }',
    "If you genuinely have nothing to do, emit a single `idle` action.",
  ];
}

/**
 * Render the VERBS block from gm.js's registry. Verbs without a
 * `prompt` field are skipped (treated as internal aliases).
 */
function formatVerbsBlock() {
  const out = ["VERBS:"];
  // Compute padding so descriptions line up regardless of which verbs
  // are registered. Aligned monospace blocks are easier for the LLM
  // to parse than a ragged list.
  const sigs = {};
  let maxSigLen = 0;
  for (const [name, def] of Object.entries(VERBS)) {
    if (!def?.prompt) continue;
    const sig = `${name}${verbSignature(def.args)}`;
    sigs[name] = sig;
    if (sig.length > maxSigLen) maxSigLen = sig.length;
  }
  for (const [name, def] of Object.entries(VERBS)) {
    if (!def?.prompt) continue;
    const sig = sigs[name].padEnd(maxSigLen, " ");
    out.push(`  ${sig}  — ${def.prompt}`);
  }
  return out;
}

function verbSignature(argsSchema) {
  if (!argsSchema || Object.keys(argsSchema).length === 0) return "";
  const parts = [];
  for (const [name, rule] of Object.entries(argsSchema)) {
    parts.push(rule?.required === false ? `${name}?` : name);
  }
  return `(${parts.join(", ")})`;
}

/**
 * Render the NEEDS block — describes the wellbeing system + axis
 * meanings. Auto-updates when NEED_AXES / NEED_AXIS_DOCS change in
 * needs.js. Direct/external mode mentions `set_mood` as a knob; pi
 * mode skips that line since pi has no shell skill for it.
 */
function formatNeedsBlock({ piMode = false } = {}) {
  const out = [];
  out.push("NEEDS: server-tracked drives that decay over time. Each turn's perception block opens with a 'Wellbeing' line + any axes that are pressing.");
  out.push("Axes:");
  for (const axis of NEED_AXES) {
    const doc = NEED_AXIS_DOCS[axis] ?? "";
    out.push(`  ${axis}${doc ? ` — ${doc}` : ""}`);
  }
  const bands = (NEEDS_DEFAULTS.wellbeingBands || [])
    .map((b) => b.name)
    .join(" / ");
  if (bands) {
    out.push(`Wellbeing levels (worst-axis wins): ${bands}.`);
  }
  out.push(`When an axis crosses below ${NEEDS_DEFAULTS.lowThreshold ?? 30} you'll see a one-shot perception event ("(your X just dropped — feeling ...)"). React to it — rest if drained, talk if withdrawn, explore if bored.`);
  if (!piMode) {
    out.push("`set_mood` lets you nudge `energy` and `social` directly. Other axes change through doing things in the world.");
  } else {
    out.push("Acting on a need (talking, moving, updating state) helps. Direct write-access to mood is a JSON-mode feature your bash skills don't expose.");
  }
  return out;
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
  moodLine,
  nearbyObjects,
  seedMessage,
  simNow,
}) {
  const lines = [];

  // Trigger orientation — matches call-my-agent's style verbatim.
  lines.push(`Trigger: ${formatTrigger(trigger, triggerContext)}`);
  // When (real + sim) — gives the LLM a real-world clock to ground
  // event timestamps and a sim-clock so sleep / schedule / "noon"
  // decisions are anchored. Sim-time only emitted when wired (some
  // older callers don't provide simNow).
  const realIso = formatRealClock(triggerContext?.realMs ?? simNow?.real_ms);
  const simIso = simNow?.sim_iso;
  const simSlot = simNow?.slot;
  if (realIso || simIso) {
    const parts = [];
    if (realIso) parts.push(`${realIso} (real)`);
    if (simIso)  parts.push(`${simIso}${simSlot ? ` ${simSlot}` : ""} (sim)`);
    lines.push(`When: ${parts.join(" · ")}`);
  }
  lines.push("");

  // Situation
  const me = {
    pubkey: character.pubkey,
    x: character.x ?? 0,
    y: character.y ?? 0,
  };
  lines.push(`You are at (${me.x}, ${me.y}).`);

  // Needs line — biological pressure (energy, social), surfaced one
  // line in, terse, sorted by most pressing axis. Empty string skipped
  // so first-tick prompts don't carry placeholder text.
  if (typeof needsLine === "string" && needsLine.trim()) {
    lines.push(needsLine);
  }

  // Mood line — sum of recent moodlets (#275). Distinct from needs:
  // mood is event-driven ("Bob called her stupid"), needs are decay-
  // driven ("you haven't slept"). Both feed the LLM's line choices,
  // but they answer different questions about the character right now.
  if (typeof moodLine === "string" && moodLine.trim()) {
    lines.push(moodLine);
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

  // Nearby objects (#245 slice 1). Sorted by distance ascending —
  // adjacent (distance 0) first. The LLM doesn't yet have a `use`
  // verb; for now this is purely informational for narrative voice.
  if (Array.isArray(nearbyObjects) && nearbyObjects.length > 0) {
    lines.push("");
    lines.push("Things nearby:");
    for (const o of nearbyObjects.slice(0, 10)) {
      const def = OBJECT_TYPES[o.type];
      const desc = def?.description ?? o.type;
      lines.push(`  - ${desc} at (${o.x}, ${o.y})`);
    }
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
    // Split storyteller-driven cues (card_prompt, ambient_moment) into
    // their own block so their influence on the turn is observable —
    // the waterfall picks the header up as a distinct section.
    const { cues, rest } = partitionStorytellerEvents(perceptionEvents);
    if (cues.length > 0) {
      const block = formatPerceptionEvents(cues, {
        selfPubkey: me.pubkey,
        header: "Storyteller cues (impulses you can take, twist, or ignore):",
      });
      if (block) {
        lines.push("");
        lines.push(block);
      }
    }
    if (rest.length > 0) {
      const block = formatPerceptionEvents(rest, { selfPubkey: me.pubkey });
      if (block) {
        lines.push("");
        lines.push(block);
      }
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
