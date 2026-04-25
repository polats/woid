/**
 * Read pi --session JSONL files and cluster entries into turn objects.
 *
 * Pi writes the session as an append-only JSONL per character. Each line
 * is one of:
 *   session / model_change / thinking_level_change        — preamble
 *   message (role=user|assistant|toolResult|bash)          — conversation
 *   compaction / branch_summary / custom / custom_message  — meta-events
 *
 * We cluster the messages into "turns" using call-my-agent's rule:
 * every user message starts a new turn; subsequent assistant/toolResult
 * entries belong to the same turn until the next user message.
 */

import { readFileSync, existsSync, statSync } from "fs";

export function readSessionTurns(sessionPath, { limit = 20 } = {}) {
  if (!existsSync(sessionPath)) return { turns: [], meta: {} };
  const raw = readFileSync(sessionPath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return clusterEntriesIntoTurns(entries, { limit });
}

function clusterEntriesIntoTurns(entries, { limit }) {
  const meta = {
    sessionId: null,
    model: null,
    provider: null,
    startedAt: null,
  };
  const turns = [];
  let current = null;

  for (const e of entries) {
    switch (e.type) {
      case "session":
        meta.sessionId = e.id;
        meta.startedAt = e.timestamp;
        break;
      case "model_change":
        meta.model = e.modelId;
        meta.provider = e.provider;
        break;
      case "compaction":
        // Attach the compaction marker to the current turn if one exists,
        // otherwise queue it as its own standalone entry.
        if (current) {
          current.compactions = current.compactions || [];
          current.compactions.push({
            summary: e.summary ?? "",
            firstKeptEntryId: e.firstKeptEntryId,
            tokensBefore: e.tokensBefore,
          });
        } else {
          turns.push({
            turnId: e.id,
            isCompaction: true,
            startedAt: e.timestamp,
            summary: e.summary ?? "",
            tokensBefore: e.tokensBefore,
          });
        }
        break;
      case "message": {
        const m = e.message;
        if (!m) break;
        if (m.role === "user") {
          if (current) turns.push(current);
          current = {
            turnId: e.id,
            startedAt: e.timestamp,
            parentId: e.parentId,
            user: {
              text: extractText(m.content),
              blocks: m.content,
              timestamp: m.timestamp,
            },
            assistant: null,
            toolResults: [],
            usage: null,
            model: meta.model,
            provider: meta.provider,
          };
        } else if (m.role === "assistant") {
          if (!current) break; // assistant without a preceding user — skip
          current.assistant = {
            timestamp: m.timestamp,
            text: extractText(m.content),
            thinking: extractThinking(m.content),
            toolCalls: extractToolCalls(m.content),
            stopReason: m.stopReason,
            responseId: m.responseId,
          };
          current.usage = m.usage ?? current.usage;
          current.model = m.model ?? current.model;
          current.provider = m.provider ?? current.provider;
          current.endedAt = e.timestamp;
          current.durationMs = current.startedAt && e.timestamp
            ? Math.max(0, new Date(e.timestamp).getTime() - new Date(current.startedAt).getTime())
            : null;
        } else if (m.role === "toolResult") {
          if (!current) break;
          current.toolResults.push({
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            text: extractText(m.content),
            isError: !!m.isError,
            timestamp: m.timestamp,
          });
        }
        break;
      }
      default:
        // bash-execution, custom, custom_message, branch_summary, label — skip for now.
        break;
    }
  }
  if (current) turns.push(current);
  turns.reverse(); // newest first
  return { turns: turns.slice(0, limit), meta };
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

function extractThinking(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "thinking")
    .map((c) => c.thinking ?? "")
    .join("\n");
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c?.type === "toolCall")
    .map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      args: c.args,
    }));
}

/**
 * DirectHarness writes its own append-only JSONL with a simpler shape
 * (one entry per message: `{ ts, role: 'user'|'assistant', content,
 * actions?, thinking?, usage?, harness: 'direct' }`). Cluster these
 * the same way as pi turns so the waterfall renders identically.
 *
 * Direct entries have:
 *   user      — content is the user message string
 *   assistant — content is the raw model output (typically JSON);
 *               actions[] holds the parsed Action structs;
 *               thinking is the parsed thinking string if any;
 *               usage carries token counts.
 */
export function readDirectTurns(jsonlPath, { limit = 20 } = {}) {
  if (!existsSync(jsonlPath)) return { turns: [], meta: { harness: "direct" } };
  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  const meta = { harness: "direct", model: null, provider: null, startedAt: null };
  const turns = [];
  let current = null;
  let turnCounter = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (!meta.startedAt && entry.ts) meta.startedAt = new Date(entry.ts).toISOString();
    if (entry.role === "user") {
      if (current) turns.push(current);
      turnCounter += 1;
      current = {
        turnId: `direct-${turnCounter}-${entry.ts ?? ""}`,
        startedAt: entry.ts ? new Date(entry.ts).toISOString() : null,
        user: { text: String(entry.content ?? ""), blocks: null, timestamp: entry.ts },
        assistant: null,
        toolResults: [],
        usage: null,
        model: null,
        provider: null,
      };
    } else if (entry.role === "assistant") {
      if (!current) continue;
      const actions = Array.isArray(entry.actions) ? entry.actions : [];
      // The card waterfall expects an `assistant.text` field. Prefer the
      // human-readable parsed `say` action if present; fall back to the
      // raw JSON content so the inspector still shows something useful.
      const sayText = actions.find((a) => a?.type === "say")?.text;
      current.assistant = {
        timestamp: entry.ts,
        text: sayText || String(entry.content ?? ""),
        thinking: entry.thinking || "",
        toolCalls: actions.map((a) => ({
          toolCallId: `direct-${a.type}`,
          toolName: a.type,
          args: a,
        })),
        stopReason: "stop",
        responseId: null,
      };
      if (entry.usage) current.usage = entry.usage;
      if (current.startedAt && entry.ts) {
        current.endedAt = new Date(entry.ts).toISOString();
        current.durationMs = Math.max(
          0,
          new Date(current.endedAt).getTime() - new Date(current.startedAt).getTime(),
        );
      }
    }
  }
  if (current) turns.push(current);
  turns.reverse();
  return { turns: turns.slice(0, limit), meta };
}

/**
 * DirectHarness latest-usage tail for the card token gauge. Mirrors
 * `readLatestUsage` but reads our own format.
 */
export function readDirectLatestUsage(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;
  const st = statSync(jsonlPath);
  if (st.size === 0) return null;
  const raw = readFileSync(jsonlPath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e?.role === "assistant" && e.usage) {
        return { model: null, provider: null, usage: e.usage };
      }
    } catch { /* skip */ }
  }
  return null;
}

// Cheap helper for the card-level context gauge. Tails the JSONL and
// returns just {totalTokens, model, contextWindow} from the latest
// assistant entry. Called frequently — stays fast.
export function readLatestUsage(sessionPath) {
  if (!existsSync(sessionPath)) return null;
  const st = statSync(sessionPath);
  if (st.size === 0) return null;
  const raw = readFileSync(sessionPath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let model = null;
  let provider = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "model_change") {
        model = model || e.modelId;
        provider = provider || e.provider;
        continue;
      }
      if (e.type === "message" && e.message?.role === "assistant" && e.message?.usage) {
        return {
          model: e.message.model || model,
          provider: e.message.provider || provider,
          usage: e.message.usage,
        };
      }
    } catch { /* skip */ }
  }
  return null;
}
