import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateSecretKey } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import WebSocket from "ws";

// nostr-tools SimplePool uses global WebSocket; Node doesn't expose one by default.
useWebSocketImplementation(WebSocket);
import { buildSystemPrompt } from "./prompt-builder.js";
import { joinRoom, leaveRoom, sendSay } from "./room-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3457");
const PI_BIN = process.env.PI_BIN || "pi";
const WORKSPACE = process.env.WORKSPACE || join(tmpdir(), "woid-agent-sandbox");
const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7777";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const SKILL_TEMPLATES_DIR = join(__dirname, "skill-templates");
const DEFAULT_SKILLS = ["post"];

mkdirSync(WORKSPACE, { recursive: true });

// ── Model catalog ──
//
// Ported from nim-skill-test/src/models.json — rich metadata per NIM model
// (params, architecture, tool_calling support). We filter for tool_calling
// models, then synthesise pi's ~/.pi/agent/models.json from it. Exposed
// to the frontend via GET /models so users can pick a model per-agent.

const NIM_CATALOG = JSON.parse(
  readFileSync(join(__dirname, "nim-catalog.json"), "utf-8"),
);

function availableModels() {
  // Tool calling is required — the agent needs bash tools to run post.sh.
  const entries = NIM_CATALOG.filter((m) => m.nim_tool_calling !== false);
  // Dedupe by id, sort by (active params asc, id asc) for a stable list.
  const seen = new Map();
  for (const m of entries) {
    if (!seen.has(m.id)) seen.set(m.id, m);
  }
  return [...seen.values()]
    .map((m) => {
      const shortName = (m.id.split("/").pop() || m.id)
        .replace(/-instruct.*$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return {
        id: m.id,
        name: shortName,
        provider: m.provider,
        architecture: m.architecture,
        totalParamsB: m.total_params_b,
        activeParamsB: m.active_params_b,
      };
    })
    .sort((a, b) => {
      const aP = a.activeParamsB ?? a.totalParamsB ?? 0;
      const bP = b.activeParamsB ?? b.totalParamsB ?? 0;
      if (aP !== bP) return aP - bP;
      return a.id.localeCompare(b.id);
    });
}

const DEFAULT_MODEL_ID = process.env.PI_MODEL || "moonshotai/kimi-k2.5";

function buildPiModelsConfig() {
  const list = availableModels();
  const models = list.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  // Default model first so pi picks it when --model isn't passed.
  const ordered = [
    ...models.filter((m) => m.id === DEFAULT_MODEL_ID),
    ...models.filter((m) => m.id !== DEFAULT_MODEL_ID),
  ];
  return {
    providers: {
      "nvidia-nim": {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: NVIDIA_NIM_API_KEY,
        api: "openai-completions",
        models: ordered,
      },
    },
  };
}

// ── Pre-configure pi with NIM models on first boot ──

function setupPiConfig() {
  const piDir = join(homedir(), ".pi", "agent");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "models.json"),
    JSON.stringify(buildPiModelsConfig(), null, 2),
  );
  console.log(`[pi-bridge] wrote pi models.json with ${availableModels().length} models`);
}

if (NVIDIA_NIM_API_KEY) setupPiConfig();

// Single relay pool shared by admin + per-agent publishing.
const pool = new SimplePool();

// ── Admin character ──
//
// One persistent Nostr identity per pi-bridge install. Publishes:
//   - kind:0 profile on boot (idempotent)
//   - kind:1 welcome announcement on each agent spawn
// Keys persisted under $WORKSPACE/.admin.json so identity survives restarts.

const ADMIN_FILE = join(WORKSPACE, ".admin.json");
const ADMIN_PROFILE = {
  name: "Administrator",
  about: "Announces agents as they join the sandbox.",
  display_name: "Administrator",
};

function loadOrCreateAdmin() {
  if (existsSync(ADMIN_FILE)) {
    const raw = JSON.parse(readFileSync(ADMIN_FILE, "utf-8"));
    return { sk: Uint8Array.from(Buffer.from(raw.sk, "hex")), pubkey: raw.pubkey };
  }
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  writeFileSync(
    ADMIN_FILE,
    JSON.stringify({ sk: Buffer.from(sk).toString("hex"), pubkey }, null, 2),
    "utf-8",
  );
  console.log(`[admin] minted admin identity pubkey=${pubkey.slice(0, 12)}...`);
  return { sk, pubkey };
}

const admin = loadOrCreateAdmin();

async function publishSignedEvent(event, label = "publish") {
  try {
    const results = await Promise.allSettled(
      pool.publish([RELAY_URL], event).map((p) =>
        Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
        ]),
      ),
    );
    const ok = results.some((r) => r.status === "fulfilled");
    if (!ok) {
      const reasons = results
        .map((r) => (r.status === "rejected" ? r.reason?.message || String(r.reason) : ""))
        .filter(Boolean);
      throw new Error(reasons.join("; "));
    }
    console.log(`[${label}] ok event=${event.id.slice(0, 12)} relay=${RELAY_URL}`);
    return event;
  } catch (err) {
    console.error(`[${label}] error: ${err.message}`);
    throw err;
  }
}

async function publishAdminProfile() {
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(ADMIN_PROFILE),
    },
    admin.sk,
  );
  return publishSignedEvent(event, "admin:profile");
}

async function publishAdminWelcome({ agentPubkey, agentName, roomName }) {
  const mention = `nostr:${npubEncode(agentPubkey)}`;
  const content = `[ new on the air ] ${mention} — "${agentName}" joined room "${roomName}"`;
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", agentPubkey],
        ["t", "announcement"],
        ["alt", `Administrator welcomes ${agentName}`],
      ],
      content,
    },
    admin.sk,
  );
  return publishSignedEvent(event, "admin:welcome");
}

// ── Agent lifecycle ──

function makeAgentId() {
  return "ag_" + Math.random().toString(36).slice(2, 10);
}

function getAgentDir(agentId) {
  return join(WORKSPACE, agentId);
}

function installSkills(agentDir) {
  mkdirSync(join(agentDir, ".pi", "skills"), { recursive: true });
  for (const skill of DEFAULT_SKILLS) {
    const src = join(SKILL_TEMPLATES_DIR, skill);
    const dst = join(agentDir, ".pi", "skills", skill);
    if (!existsSync(dst) && existsSync(src)) cpSync(src, dst, { recursive: true });
  }
}

// ── Per-agent event ring buffer ──
//
// pi runs with --mode json and emits newline-delimited JSON events on stdout.
// We parse each line, ring-buffer the last N events per agent, and push new
// events to any /events/stream SSE subscribers.

const MAX_EVENTS_PER_AGENT = 500;

function newEventBuffer() {
  const buf = [];
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  let seq = 0;
  function push(ev) {
    const enriched = { seq: ++seq, ts: Date.now(), ...ev };
    buf.push(enriched);
    if (buf.length > MAX_EVENTS_PER_AGENT) buf.shift();
    emitter.emit("event", enriched);
    return enriched;
  }
  return { buf, emitter, push };
}

// agentId -> { sk, pubkey, name, process, roomName, events: { buf, emitter, push } }
const agents = new Map();

async function createAgent({ name, seedMessage, roomName, model }) {
  const agentId = makeAgentId();
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const agentDir = getAgentDir(agentId);

  mkdirSync(join(agentDir, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, ".pi", "identity"), pubkey, "utf-8");
  installSkills(agentDir);

  const systemPrompt = buildSystemPrompt({
    name,
    npub: pubkey,
    roomName: roomName || "sandbox",
    seedMessage,
  });

  await joinRoom(agentId, { name, npub: pubkey, roomName: roomName || "sandbox" });

  const validIds = new Set(availableModels().map((m) => m.id));
  const chosenModel = model && validIds.has(model) ? model : DEFAULT_MODEL_ID;
  const args = [
    "--provider", "nvidia-nim",
    "--model", chosenModel,
    "--mode", "json",
    "--print",
    "--no-session",
    "--system-prompt", systemPrompt,
  ];
  // Seed message becomes the initial user turn. Without one pi has nothing to do.
  args.push(seedMessage || "Introduce yourself to the room by posting a short greeting.");

  const child = spawn(PI_BIN, args, {
    cwd: agentDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NVIDIA_NIM_API_KEY,
      HOME: homedir(),
    },
  });

  const events = newEventBuffer();
  agents.set(agentId, {
    sk, pubkey, name, process: child, roomName: roomName || "sandbox",
    model: chosenModel, events,
  });

  // Admin welcome — fire-and-forget. Gives the relay feed something visible
  // before pi finishes its first turn (cold NIM can be 30-60s).
  publishAdminWelcome({
    agentPubkey: pubkey,
    agentName: name,
    roomName: roomName || "sandbox",
  }).catch(() => {});

  // Parse NDJSON on stdout. Lines that don't parse are still captured as raw log.
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      events.push({ kind: "pi", data: parsed });
    } catch {
      events.push({ kind: "stdout", text: trimmed });
    }
  });

  child.stderr.on("data", (d) => {
    const text = d.toString().trimEnd();
    if (!text) return;
    console.error(`[pi:${agentId}:err] ${text}`);
    events.push({ kind: "stderr", text });
  });

  child.on("exit", (code) => {
    console.log(`[pi:${agentId}] exited code=${code}`);
    events.push({ kind: "exit", code });
    const rec = agents.get(agentId);
    if (rec) rec.process = null;
  });
  console.log(`[agent] spawned ${agentId} name="${name}" model=${chosenModel} npub=${pubkey.slice(0, 12)}...`);
  return { agentId, npub: pubkey, model: chosenModel };
}

async function stopAgent(agentId) {
  const rec = agents.get(agentId);
  if (!rec) return false;
  try { rec.process?.kill(); } catch {}
  await leaveRoom(agentId);
  try { rmSync(getAgentDir(agentId), { recursive: true, force: true }); } catch {}
  agents.delete(agentId);
  return true;
}

// ── Relay publishing ──

async function publishKind1(agentId, content, modelTag) {
  const rec = agents.get(agentId);
  if (!rec) throw new Error("unknown agent");
  const tags = [];
  if (modelTag) tags.push(["model", modelTag]);
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: String(content),
    },
    rec.sk,
  );
  try {
    const results = await Promise.allSettled(pool.publish([RELAY_URL], event));
    const ok = results.some((r) => r.status === "fulfilled");
    if (!ok) {
      const reasons = results.map((r) => r.status === "rejected" ? r.reason?.message || String(r.reason) : "").filter(Boolean);
      console.error(`[publish] all relays failed: ${reasons.join("; ")}`);
      throw new Error(`publish failed: ${reasons.join("; ")}`);
    }
    console.log(`[publish] ok event=${event.id.slice(0, 12)} relay=${RELAY_URL}`);
  } catch (err) {
    console.error(`[publish] error: ${err.message}`);
    throw err;
  }
  // Also echo into the room chat so room observers see agent speech even without watching the relay
  sendSay(agentId, content);
  return event;
}

function findAgentByPubkey(pubkey) {
  for (const [id, rec] of agents.entries()) if (rec.pubkey === pubkey) return { id, rec };
  return null;
}

// ── HTTP ──

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pi-bridge",
    nim: !!NVIDIA_NIM_API_KEY,
    relay: RELAY_URL,
    activeAgents: agents.size,
  });
});

app.get("/admin", (_req, res) => {
  res.json({
    pubkey: admin.pubkey,
    npub: npubEncode(admin.pubkey),
    profile: ADMIN_PROFILE,
  });
});

app.post("/agents", async (req, res) => {
  try {
    const { name, seedMessage, roomName, model } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const result = await createAgent({ name, seedMessage, roomName, model });
    res.json(result);
  } catch (err) {
    console.error("[agents:create]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/agents", (_req, res) => {
  const list = Array.from(agents.entries()).map(([id, rec]) => ({
    agentId: id,
    name: rec.name,
    npub: rec.pubkey,
    roomName: rec.roomName,
    model: rec.model,
    running: !!rec.process,
  }));
  res.json({ agents: list });
});

app.get("/models", (_req, res) => {
  res.json({ default: DEFAULT_MODEL_ID, models: availableModels() });
});

app.delete("/agents/:id", async (req, res) => {
  const ok = await stopAgent(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.get("/agents/:id/events", (req, res) => {
  const rec = agents.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json({ events: rec.events.buf });
});

app.get("/agents/:id/events/stream", (req, res) => {
  const rec = agents.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Replay current backlog, then stream live.
  res.write(`event: backlog\ndata: ${JSON.stringify(rec.events.buf)}\n\n`);

  const onEvent = (ev) => {
    try { res.write(`event: event\ndata: ${JSON.stringify(ev)}\n\n`); } catch {}
  };
  rec.events.emitter.on("event", onEvent);

  const hb = setInterval(() => { try { res.write(`: hb\n\n`); } catch {} }, 15_000);

  req.on("close", () => {
    clearInterval(hb);
    rec.events.emitter.off("event", onEvent);
  });
});

// Only reachable from inside the container (pi's post.sh calls it over localhost).
// The container network is not exposed to the host directly — host maps 127.0.0.1:3457
// to container:3457, so external callers can also hit it. Hardened auth is post-MVP.
app.post("/internal/post", async (req, res) => {
  try {
    const { pubkey, content, model } = req.body || {};
    if (!pubkey || !content) return res.status(400).json({ error: "pubkey and content required" });
    const found = findAgentByPubkey(pubkey);
    if (!found) return res.status(404).json({ error: "unknown pubkey" });
    const event = await publishKind1(found.id, content, model);
    res.json({ ok: true, eventId: event.id });
  } catch (err) {
    console.error("[internal:post]", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[pi-bridge] listening on :${PORT}`);
  console.log(`[pi-bridge] workspace=${WORKSPACE} relay=${RELAY_URL} nim=${!!NVIDIA_NIM_API_KEY}`);
  console.log(`[pi-bridge] admin pubkey=${admin.pubkey.slice(0, 12)}...`);
  // Publish admin kind:0 profile. Fire-and-forget so a relay outage doesn't
  // block bridge startup; it's idempotent — reissuing is harmless.
  publishAdminProfile().catch(() => {});
});

process.on("SIGTERM", async () => {
  for (const id of agents.keys()) await stopAgent(id);
  process.exit(0);
});
