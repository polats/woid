#!/usr/bin/env node
/**
 * External-harness reference client. Spawns a character, opens the
 * SSE stream, and replies to each `turn_request` with a canned string
 * (or, if GEMINI_API_KEY is set, a real Gemini response).
 *
 * Run against local docker-compose:
 *   node agent-sandbox/examples/external-agent.mjs
 *
 * Run against prod:
 *   BASE=https://bridge.woid.noods.cc \
 *   node agent-sandbox/examples/external-agent.mjs
 *
 * Override persona / model:
 *   NAME="Scout" MODEL="gemini-2.5-flash" node .../external-agent.mjs
 *
 * Exits on Ctrl+C; the bridge evicts the agent after 5 minutes of
 * heartbeat silence either way.
 */

const BASE = process.env.BASE || "http://localhost:13457";
const NAME = process.env.NAME || `ext-${Math.random().toString(36).slice(2, 6)}`;
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const PROVIDER = process.env.PROVIDER || "google";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

async function json(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(parsed.error || text), { status: res.status, body: parsed });
  return parsed;
}

async function authJson(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(parsed.error || text), { status: res.status, body: parsed });
  return parsed;
}

async function geminiReply({ systemPrompt, userTurn, recentTurns }) {
  if (!GEMINI_API_KEY) {
    return {
      say: `(canned) ${NAME} heard "${userTurn.slice(0, 80)}"`,
    };
  }
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const contents = [
    ...recentTurns.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: userTurn }] },
  ];
  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction:
        systemPrompt +
        '\n\nRESPOND ONLY WITH JSON: { "say": string, "move"?: {"x":int,"y":int}, "state"?: string }',
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  });
  try {
    return JSON.parse(response?.text ?? "{}");
  } catch {
    return { say: response?.text?.slice(0, 200) ?? "" };
  }
}

async function main() {
  console.log(`[ext-client] BASE=${BASE}  name=${NAME}`);

  // 1. Create character
  const c = await json("POST", "/characters", { name: NAME });
  console.log(`[ext-client] character ${c.npub.slice(0, 20)}... created`);

  // 2. Generate a bare bio
  try {
    await json("POST", `/characters/${c.pubkey}/generate-profile`, {});
  } catch (err) {
    console.warn(`[ext-client] generate-profile failed: ${err.message}`);
  }

  // 3. Spawn external-harness agent
  const agent = await json("POST", "/agents", {
    pubkey: c.pubkey,
    seedMessage: `hello, ${NAME} online`,
    roomName: "sandbox",
    model: MODEL,
    provider: PROVIDER,
    harness: "external",
  });
  console.log(`[ext-client] spawned ${agent.agentId} token=${agent.agentToken.slice(0, 20)}...`);
  const { agentToken, streamUrl, actUrl, heartbeatUrl } = agent;

  // 4. Heartbeat every 2 min
  const heartbeat = setInterval(async () => {
    try {
      await authJson("POST", `/external/${c.pubkey}/heartbeat`, {}, agentToken);
    } catch (err) {
      console.warn(`[ext-client] heartbeat failed: ${err.message}`);
    }
  }, 120_000);

  // 5. Open SSE stream with fetch + reader loop. Keep a rolling history
  //    to feed back into the LLM.
  const history = [];
  const streamRes = await fetch(`${streamUrl}?token=${encodeURIComponent(agentToken)}`);
  if (!streamRes.ok) throw new Error(`stream ${streamRes.status}`);
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  process.on("SIGINT", async () => {
    console.log("\n[ext-client] shutting down");
    clearInterval(heartbeat);
    try { await authJson("DELETE", `/agents/${agent.agentId}`, null, agentToken); } catch {}
    process.exit(0);
  });

  console.log("[ext-client] stream open; awaiting turn_request...");
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      console.log("[ext-client] stream closed");
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      const lines = block.split("\n").filter(Boolean);
      let evName = "message";
      let dataRaw = "";
      for (const line of lines) {
        if (line.startsWith(":")) continue; // keepalive comment
        if (line.startsWith("event: ")) evName = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataRaw += line.slice(6);
      }
      if (!dataRaw) continue;
      let data;
      try { data = JSON.parse(dataRaw); } catch { continue; }

      if (evName === "room_joined") {
        console.log(`[ext-client] room_joined pubkey=${data.pubkey?.slice(0,10)}`);
      } else if (evName === "message") {
        console.log(`[ext-client] message from=${data.from} text="${String(data.text).slice(0,80)}"`);
      } else if (evName === "turn_request") {
        console.log(`[ext-client] turn_request ${data.turnId}`);
        history.push({ role: "user", content: data.context?.userTurn ?? "" });
        try {
          const reply = await geminiReply({
            systemPrompt: data.context?.systemPrompt ?? "",
            userTurn: data.context?.userTurn ?? "",
            recentTurns: data.context?.recentTurns ?? [],
          });
          console.log(`[ext-client] acting → say=${JSON.stringify(reply).slice(0, 120)}`);
          history.push({ role: "assistant", content: JSON.stringify(reply) });
          await authJson("POST", `/external/${c.pubkey}/act`, {
            turnId: data.turnId,
            text: reply.say,
            move: reply.move,
            state: reply.state,
          }, agentToken);
        } catch (err) {
          console.error(`[ext-client] act failed: ${err.message}`);
        }
      } else if (evName === "stopped") {
        console.log(`[ext-client] stopped`);
        clearInterval(heartbeat);
        process.exit(0);
      }
    }
  }
}

main().catch((err) => {
  console.error("[ext-client] fatal:", err?.stack || err);
  process.exit(1);
});
