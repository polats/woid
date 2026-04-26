import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync, renameSync, createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import crypto from "crypto";
import * as s3 from "./s3.js";
import * as piPool from "./pi-pool.js";
import * as rateLimiter from "./rate-limiter.js";
import * as apiQuota from "./api-quota.js";
import * as personaLog from "./persona-log.js";
import { createHarness, KNOWN_HARNESSES, DEFAULT_HARNESS } from "./harnesses/index.js";
import { createGM } from "./gm.js";
import { createPerception, formatPerceptionEvents } from "./perception.js";
import { createScheduler } from "./scheduler.js";
import { createSceneTracker } from "./scene-tracker.js";
import { createJournal } from "./journal.js";
import { buildMemoryBlock } from "./memory.js";
import { createNeedsTracker, describeNeeds, NEED_AXES } from "./needs.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateSecretKey } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";
import WebSocket from "ws";

// nostr-tools SimplePool uses global WebSocket; Node doesn't expose one by default.
useWebSocketImplementation(WebSocket);
import { buildSystemPrompt, buildUserTurn } from "./buildContext.js";
import { readSessionTurns, readLatestUsage, readDirectTurns, readDirectLatestUsage } from "./sessionReader.js";
import { joinRoom, leaveRoom, sendSay, sayAs, moveAs, moveAgent, onNewMessage, onPositionChange, roomSnapshot } from "./room-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3457");
const PI_BIN = process.env.PI_BIN || "pi";
const WORKSPACE = process.env.WORKSPACE || join(tmpdir(), "woid-agent-sandbox");
const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7777";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
// When set, pi-bridge exposes an OpenAI-compat llama.cpp (or vLLM/Ollama)
// server as a third provider called `local`. No auth — the served model is
// whatever the operator has loaded at the URL. See agent-sandbox/llama-cpp/
// for a self-contained llama.cpp stack that pairs with this.
let LOCAL_LLM_BASE_URL = process.env.LOCAL_LLM_BASE_URL || "";
// URL browsers/Nostr clients use to fetch resources served by this bridge.
// Inside docker-compose the bridge is reachable at http://pi-bridge:3457,
// but kind:0 profiles need a URL external tools can resolve — default to
// the host-mapped port.
const PUBLIC_BRIDGE_URL = process.env.PUBLIC_BRIDGE_URL || "http://localhost:13457";
const PUBLIC_JUMBLE_URL = process.env.PUBLIC_JUMBLE_URL || "";
const SKILL_TEMPLATES_DIR = join(__dirname, "skill-templates");
const DEFAULT_SKILLS = ["post", "room", "state"];

mkdirSync(WORKSPACE, { recursive: true });
apiQuota.init(WORKSPACE);
personaLog.init(WORKSPACE);

// ── Model catalog ──
//
// Ported from nim-skill-test/src/models.json — rich metadata per NIM model
// (params, architecture, tool_calling support). We filter for tool_calling
// models, then synthesise pi's ~/.pi/agent/models.json from it. Exposed
// to the frontend via GET /models so users can pick a model per-agent.

const NIM_CATALOG = JSON.parse(
  readFileSync(join(__dirname, "nim-catalog.json"), "utf-8"),
);
const GEMINI_CATALOG = JSON.parse(
  readFileSync(join(__dirname, "gemini-catalog.json"), "utf-8"),
);
const LOCAL_CATALOG = JSON.parse(
  readFileSync(join(__dirname, "local-catalog.json"), "utf-8"),
);

function nimAvailableModels() {
  // Tool calling is required — the agent needs bash tools to run post.sh.
  const entries = NIM_CATALOG.filter((m) => m.nim_tool_calling !== false);
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
        provider: "nvidia-nim",
        architecture: m.architecture,
        totalParamsB: m.total_params_b,
        activeParamsB: m.active_params_b,
        contextWindow: 131072,
      };
    })
    .sort((a, b) => {
      const aP = a.activeParamsB ?? a.totalParamsB ?? 0;
      const bP = b.activeParamsB ?? b.totalParamsB ?? 0;
      if (aP !== bP) return aP - bP;
      return a.id.localeCompare(b.id);
    });
}

function geminiAvailableModels() {
  return GEMINI_CATALOG.map((m) => ({
    id: m.id,
    name: m.name,
    provider: "google",
    contextWindow: m.contextWindow ?? 1048576,
    reasoning: m.reasoning ?? false,
    cost: m.cost,
  }));
}

function localAvailableModels() {
  // Only show local models when the operator has pointed us at a server.
  // The catalog is a superset — any one of these might be what's actually
  // loaded in llama.cpp right now. We don't probe; the spawn call just
  // uses whatever id the client picks (must match what llama-server serves).
  return LOCAL_CATALOG.map((m) => ({
    id: m.id,
    name: m.name,
    provider: "local",
    family: m.family,
    totalParamsB: m.total_params_b,
    activeParamsB: m.active_params_b,
    contextWindow: m.context_window ?? 131072,
    notes: m.notes,
  }));
}

function availableModels() {
  const list = [];
  if (NVIDIA_NIM_API_KEY) list.push(...nimAvailableModels());
  if (GEMINI_API_KEY) list.push(...geminiAvailableModels());
  if (LOCAL_LLM_BASE_URL) list.push(...localAvailableModels());
  return list;
}

function providerForModelId(modelId) {
  if (!modelId) return PI_DEFAULT_PROVIDER;
  if (LOCAL_CATALOG.some((m) => m.id === modelId)) return "local";
  if (GEMINI_CATALOG.some((m) => m.id === modelId)) return "google";
  return "nvidia-nim";
}

// Default provider + model. Resolution order:
//   1. PI_DEFAULT_PROVIDER env (explicit operator override)
//   2. `local` if LOCAL_LLM_BASE_URL is set and reachable
//   3. `nvidia-nim` if key present
//   4. `google` if key present
// Explicit PI_MODEL env wins over the catalog default.
const PI_DEFAULT_PROVIDER =
  process.env.PI_DEFAULT_PROVIDER ||
  (LOCAL_LLM_BASE_URL ? "local" : NVIDIA_NIM_API_KEY ? "nvidia-nim" : GEMINI_API_KEY ? "google" : "nvidia-nim");
const DEFAULT_MODEL_BY_PROVIDER = {
  "nvidia-nim": "moonshotai/kimi-k2.5",
  "google": "gemini-2.5-flash-lite",
  "local": "gemma-4-E4B-it-Q4_K_M",
};
const DEFAULT_MODEL_ID =
  process.env.PI_MODEL ||
  DEFAULT_MODEL_BY_PROVIDER[PI_DEFAULT_PROVIDER] ||
  "moonshotai/kimi-k2.5";

function buildPiModelsConfig() {
  const providers = {};
  if (NVIDIA_NIM_API_KEY) {
    const nim = nimAvailableModels().map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: 131072,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    // Default model first so pi picks it when --model isn't passed.
    const ordered = [
      ...nim.filter((m) => m.id === DEFAULT_MODEL_ID),
      ...nim.filter((m) => m.id !== DEFAULT_MODEL_ID),
    ];
    providers["nvidia-nim"] = {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: NVIDIA_NIM_API_KEY,
      api: "openai-completions",
      models: ordered,
    };
  }
  if (GEMINI_API_KEY) {
    // Pi has a built-in `google` provider with these models already; we
    // merge our curated subset so the ids we advertise in /models stay
    // in sync with what pi can actually call. Built-ins are kept — ours
    // upsert by id. Since pi 0.63, `baseUrl` is required on any provider
    // entry that also defines `models` — even for built-in overrides.
    providers["google"] = {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      api: "google-generative-ai",
      apiKey: GEMINI_API_KEY,
      models: GEMINI_CATALOG.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning ?? false,
        input: ["text", "image"],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: m.cost,
      })),
    };
  }
  if (LOCAL_LLM_BASE_URL) {
    // Custom provider pointing at an OpenAI-compat local server
    // (llama.cpp, vLLM, Ollama). Pi's resolution-order docs say custom
    // providers resolve after built-ins; use a distinct name to avoid
    // colliding with Ollama's built-in provider.
    providers["local"] = {
      baseUrl: LOCAL_LLM_BASE_URL,
      api: "openai-completions",
      // llama-server ignores auth but pi always sends one.
      apiKey: "no-key",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      },
      models: LOCAL_CATALOG.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.context_window ?? 131072,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    };
  }
  return { providers };
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

// Probe LOCAL_LLM_BASE_URL at boot. Containers often can't resolve
// `host.docker.internal` without explicit extra_hosts wiring, so if the
// configured URL is unreachable and uses that hostname, fall back to the
// default docker bridge gateway 172.17.0.1 which every bridged container
// can reach out-of-the-box.
async function probeAndFixLocalLlmUrl() {
  if (!LOCAL_LLM_BASE_URL) return;
  const tryUrl = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const r = await fetch(url.replace(/\/v1\/?$/, "") + "/health", { signal: ctrl.signal });
      return r.ok;
    } catch { return false; }
    finally { clearTimeout(t); }
  };
  if (await tryUrl(LOCAL_LLM_BASE_URL)) {
    console.log(`[pi-bridge] local llm reachable at ${LOCAL_LLM_BASE_URL}`);
    return;
  }
  console.warn(`[pi-bridge] local llm NOT reachable at ${LOCAL_LLM_BASE_URL}`);
  if (LOCAL_LLM_BASE_URL.includes("host.docker.internal")) {
    const alt = LOCAL_LLM_BASE_URL.replace("host.docker.internal", "172.17.0.1");
    if (await tryUrl(alt)) {
      console.warn(`[pi-bridge] falling back to docker bridge gateway: ${alt}`);
      LOCAL_LLM_BASE_URL = alt;
      return;
    }
  }
  console.warn(`[pi-bridge] local provider may fail — check LOCAL_LLM_BASE_URL and that llama.cpp is up on the host`);
}

async function bootstrap() {
  if (LOCAL_LLM_BASE_URL) await probeAndFixLocalLlmUrl();
  if (NVIDIA_NIM_API_KEY || GEMINI_API_KEY || LOCAL_LLM_BASE_URL) setupPiConfig();
}
await bootstrap();

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

// ── Human identity ──
// One persistent keypair used to sign human chat from the Room pane's
// text input. Stored alongside the admin identity on the workspace volume.
const HUMAN_FILE = join(WORKSPACE, ".human.json");
const HUMAN_PROFILE = { name: "You", about: "A human observing the sandbox." };

function loadOrCreateHuman() {
  if (existsSync(HUMAN_FILE)) {
    const raw = JSON.parse(readFileSync(HUMAN_FILE, "utf-8"));
    return { sk: Uint8Array.from(Buffer.from(raw.sk, "hex")), pubkey: raw.pubkey };
  }
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  writeFileSync(
    HUMAN_FILE,
    JSON.stringify({ sk: Buffer.from(sk).toString("hex"), pubkey }, null, 2),
    "utf-8",
  );
  console.log(`[human] minted human identity pubkey=${pubkey.slice(0, 12)}...`);
  return { sk, pubkey };
}

const human = loadOrCreateHuman();

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

async function publishKind1From({ sk, pubkey, content, tags = [] }) {
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: String(content),
    },
    sk,
  );
  await publishSignedEvent(event, `kind1:${pubkey.slice(0, 10)}`);
  return event;
}

// Rebase stale avatar URLs to the current PUBLIC_BRIDGE_URL and
// re-publish kind:0 for any character whose saved URL points at a
// different origin. Runs once at startup so PUBLIC_BRIDGE_URL changes
// (e.g. moving from localhost dev to a prod Railway hostname)
// self-heal without manual intervention. Idempotent: when the URL
// origin already matches, this is a no-op.
async function rebaseStaleAvatarUrls() {
  let bridgeOrigin;
  try { bridgeOrigin = new URL(PUBLIC_BRIDGE_URL).origin; } catch { return; }
  const rows = listCharacters();
  for (const c of rows) {
    if (!c.avatarUrl) continue;
    let current;
    try { current = new URL(c.avatarUrl); } catch { continue; }
    if (current.origin === bridgeOrigin) continue;
    // Preserve the path + query (which includes the cache-buster),
    // only swap the origin. Refresh the cache-buster too so clients
    // see the new URL as a fresh resource.
    const newUrl = `${PUBLIC_BRIDGE_URL}${current.pathname}?t=${Date.now()}`;
    saveCharacterManifest(c.pubkey, { avatarUrl: newUrl });
    console.log(`[rebase] ${c.name} ${current.origin} -> ${bridgeOrigin}`);
    await publishCharacterProfile(c.pubkey).catch((err) => {
      console.error(`[rebase] publish failed for ${c.name}:`, err?.message || err);
    });
  }
}

// Publish a kind:3 contact list for `pubkey` from its manifest's
// `follows` array. Empty follows → empty kind:3 (still useful as an
// explicit "I have no follows" signal). Returns the published event.
async function publishCharacterFollows(pubkey) {
  const c = loadCharacter(pubkey);
  if (!c) return null;
  const tags = (Array.isArray(c.follows) ? c.follows : [])
    .filter((p) => /^[0-9a-f]{64}$/.test(p))
    .map((p) => ["p", p]);
  const event = finalizeEvent(
    {
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    c.sk,
  );
  return publishSignedEvent(event, `char:follows:${c.name}`);
}

async function publishCharacterProfile(pubkey) {
  const c = loadCharacter(pubkey);
  if (!c) return null;
  const profile = { name: c.name };
  if (c.about) profile.about = c.about;
  if (c.avatarUrl) profile.picture = c.avatarUrl;
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(profile),
    },
    c.sk,
  );
  return publishSignedEvent(event, `char:profile:${c.name}`);
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

// ── Character store ──
//
// Persistent Nostr identities, one dir per character keyed by pubkey hex.
// Characters survive pi-bridge restarts; runtimes (spawned pi processes) do not.
//
// $WORKSPACE/characters/<pubkey>/
//   agent.json         { name, about, stylePrompt, avatarUrl, profileSource, createdAt, updatedAt, model }
//   sk.hex             (mode 0600)
//   .pi/identity       (= pubkey hex, for post.sh)
//   .pi/skills/

const CHARACTERS_DIR = join(WORKSPACE, "characters");
mkdirSync(CHARACTERS_DIR, { recursive: true });

// Characters are stored by npub for human browsability. Internal code
// keeps the hex pubkey as the canonical id (that's what Nostr events sign
// with and what /internal/post reports). Dir-name translation is local.
function getCharDir(pubkey) {
  return join(CHARACTERS_DIR, npubEncode(pubkey));
}

// One-shot migration: legacy dirs were named with the hex pubkey.
// Rename any surviving hex-named dir to its npub equivalent on boot.
function migrateHexCharDirs() {
  if (!existsSync(CHARACTERS_DIR)) return;
  const entries = readdirSync(CHARACTERS_DIR, { withFileTypes: true });
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (!/^[0-9a-f]{64}$/.test(d.name)) continue;
    const src = join(CHARACTERS_DIR, d.name);
    const dst = join(CHARACTERS_DIR, npubEncode(d.name));
    if (existsSync(dst)) continue; // already migrated
    try {
      renameSync(src, dst);
      console.log(`[char] migrated ${d.name.slice(0, 12)}... → npub`);
    } catch (err) {
      console.error(`[char] migration failed for ${d.name}: ${err.message}`);
    }
  }
}
migrateHexCharDirs();

function installSkills(charDir) {
  mkdirSync(join(charDir, ".pi", "skills"), { recursive: true });
  for (const skill of DEFAULT_SKILLS) {
    const src = join(SKILL_TEMPLATES_DIR, skill);
    const dst = join(charDir, ".pi", "skills", skill);
    if (!existsSync(dst) && existsSync(src)) cpSync(src, dst, { recursive: true });
  }
}

function randomName() {
  return "ag-" + Math.random().toString(36).slice(2, 10);
}

function loadCharacter(pubkey) {
  const dir = getCharDir(pubkey);
  const manifestPath = join(dir, "agent.json");
  const skPath = join(dir, "sk.hex");
  if (!existsSync(manifestPath) || !existsSync(skPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const sk = Uint8Array.from(Buffer.from(readFileSync(skPath, "utf-8").trim(), "hex"));
  return { pubkey, sk, ...manifest };
}

function saveCharacterManifest(pubkey, patch) {
  const dir = getCharDir(pubkey);
  const path = join(dir, "agent.json");
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function listCharacters() {
  if (!existsSync(CHARACTERS_DIR)) return [];
  const entries = readdirSync(CHARACTERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  return entries
    .map((d) => {
      let pubkey;
      if (/^npub1[a-z0-9]+$/.test(d.name)) {
        try {
          const decoded = nip19Decode(d.name);
          if (decoded.type !== "npub") return null;
          pubkey = decoded.data;
        } catch { return null; }
      } else if (/^[0-9a-f]{64}$/.test(d.name)) {
        // Legacy hex dir — shouldn't exist after migration, but handle defensively.
        pubkey = d.name;
      } else {
        return null;
      }
      const c = loadCharacter(pubkey);
      if (!c) return null;
      return {
        pubkey: c.pubkey,
        npub: npubEncode(c.pubkey),
        name: c.name,
        about: c.about ?? null,
        state: c.state ?? null,
        avatarUrl: c.avatarUrl ?? null,
        model: c.model ?? null,
        harness: c.harness ?? null,
        promptStyle: c.promptStyle ?? null,
        mood: c.mood ?? null,
        profileSource: c.profileSource ?? null,
        profileModel: c.profileModel ?? null,
        createdAt: c.createdAt ?? null,
        updatedAt: c.updatedAt ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// Short runbook pi auto-loads from the workspace. Gives the agent
// per-character guidance without bloating every turn's system prompt.
// Adopts npc-no-more's convention.
function writeClaudeMd(dir, pubkey) {
  const path = join(dir, "CLAUDE.md");
  if (existsSync(path)) return;
  const content = [
    `# Agent runbook`,
    ``,
    `This is your personal workspace. Your pubkey is in \`.pi/identity\`.`,
    ``,
    `## What you can do`,
    `- Post to the shared room: \`bash .pi/skills/post/scripts/post.sh "your message"\``,
    ``,
    `## Behaviour`,
    `- Stay in character. Your persona (name, about, state) is in the system prompt.`,
    `- Don't repeat yourself or parrot what others just said.`,
    `- Keep posts short and in your voice.`,
    `- Respond to what's happening — if the room's quiet, stay quiet too.`,
    ``,
    `## Room`,
    `The room is a 2D grid. You have (x, y) coordinates. Other agents and the human also have positions. The trigger line of each turn tells you what just happened.`,
  ].join("\n");
  writeFileSync(path, content, "utf-8");
}

function createCharacter({ name } = {}) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const dir = getCharDir(pubkey);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, "sk.hex"), Buffer.from(sk).toString("hex"), { encoding: "utf-8", mode: 0o600 });
  writeFileSync(join(dir, ".pi", "identity"), pubkey, "utf-8");
  installSkills(dir);
  writeClaudeMd(dir, pubkey);
  // Seed kind:3 follows: admin + every existing character (capped to
  // keep the contact list event small). Gives the network view a real
  // graph from the first character onwards instead of disconnected nodes.
  const seedFollows = [admin.pubkey, ...listCharacters().map((c) => c.pubkey)]
    .filter((pk) => pk && pk !== pubkey)
    .slice(0, 50);
  const manifest = saveCharacterManifest(pubkey, {
    name: (name && String(name).trim()) || randomName(),
    // New characters get the call-my-ghost-style "dynamic" prompt by
    // default — anti-silence, one-action emphasis, numeric mood.
    // Existing characters with no field stay on "minimal" for the
    // A/B comparison until the user explicitly switches them.
    promptStyle: "dynamic",
    mood: { energy: 50, social: 50 },
    // Needs scaffold (#235 slice 1). Three axes seeded at 75 so
    // characters spawn comfortable and decay over the next sim-hours.
    // No personality / vibe — character voice lives in `about`.
    needs: { energy: 75, social: 75, curiosity: 75 },
    follows: seedFollows,
    createdAt: Date.now(),
  });
  console.log(`[char] created ${pubkey.slice(0, 12)}... name="${manifest.name}" follows=${seedFollows.length}`);
  // Fire-and-forget — relay publish failure shouldn't break creation.
  publishCharacterFollows(pubkey).catch((err) =>
    console.warn(`[char:follows] publish failed for ${manifest.name}:`, err?.message || err),
  );
  return loadCharacter(pubkey);
}

// ── AI profile generation ──
//
// Adapted from apoc-radio-v2 (apps/api/src/lib/agentGen.js). Simplified:
//   - single non-streaming call
//   - up to 3 retries across random lightweight models
//   - no DNS-label sanitisation (our names don't need to be subdomains)
// Returns { name, about, stylePrompt } or throws.

// Five lightweight models that produce consistently-usable JSON personas.
// Mirrors apoc-radio-v2's pool. Override via PI_PERSONA_MODELS (comma-separated).
const PERSONA_MODELS = (process.env.PI_PERSONA_MODELS ?? [
  "meta/llama-3.1-8b-instruct",
  "qwen/qwen3-next-80b-a3b-instruct",
  "qwen/qwen3.5-122b-a10b",
  "mistralai/ministral-14b-instruct-2512",
  "openai/gpt-oss-20b",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const PERSONA_SYSTEM = [
  "You generate short character profiles for a Scooby-Doo-style mystery cartoon —",
  "a crew of teenagers who solve supernatural-seeming cases in small-town America.",
  "Think Mystery Inc., Stranger Things kids, Gravity Falls — earnest teens, a",
  "van or bike-club, a local legend per episode.",
  "",
  "These become NIP-01 kind:0 Nostr profiles — only name + about.",
  "",
  "Respond ONLY with valid JSON. Both fields are REQUIRED.",
  "No markdown, no code fences, no trailing text.",
  "{",
  '  "name": "A realistic human name — a first name, or first + last, or a nickname a real teenager might go by. Examples: \'Mitsy Alvarado\', \'Ravi K.\', \'Buzz\', \'Jules Okafor\', \'Mei-Lin\'. Mix of cultures welcome. 2-40 characters. No emoji, no underscores, no digit-suffixes like x3 or 420.",',
  '  "about": "REQUIRED. 2-4 sentences. Give the character a life: what they do, a distinctive habit or prop, something concrete about their week. Quote a line they might say. The character should feel specific, not a stock archetype."',
  "}",
  "",
  "Surprise the reader. Do not reuse the same role type across generations —",
  "the brain, the jock, the skeptic, the tinkerer are all valid, but so are",
  "the delivery driver, the community-theater lead, the grandparent's helper,",
  "the pirate-radio host, the quiet one with the garden. Let temperature do its job.",
  "",
  "Keep it grounded: school, part-time jobs, family cars, weekend plans.",
  "The supernatural is just the backdrop, not the only register.",
  'Avoid "mystery", "spooky", "clue", "haunted", "ghost" as the first adjective —',
  "reach for concrete, specific nouns (band posters, dented lockers, a diner called",
  "something like The Griddle, a Xerox-smelling yearbook, a folding-chair stakeout).",
].join("\n");

// Characters can now carry realistic human names (spaces, accents, hyphens,
// apostrophes, periods). Kind:0 profiles are display names, not DNS labels.
function sanitizeName(raw) {
  const s = String(raw ?? "")
    // Strip surrounding punctuation (LLMs occasionally wrap in quotes).
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/gu, "")
    // Collapse internal whitespace.
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 2 || s.length > 40) return "";
  // Reject obvious LLM leakage.
  if (/^(name|character|persona)\s*[:=]/i.test(s)) return "";
  return s;
}

// Walk forward from each `{` until we find a bracket-balanced, string-aware
// matching `}`. First successful parse wins. Handles trailing prose, multi-
// object emissions, and embedded `}` characters inside string literals.
function extractFirstJsonObject(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = raw.slice(i, j + 1);
          try { return JSON.parse(slice); } catch { break; }
        }
      }
    }
  }
  return null;
}

function parsePersonaJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const parsed = extractFirstJsonObject(candidate);
  if (!parsed) throw new Error("model did not return a parseable JSON object");
  const name = sanitizeName(parsed.name ?? parsed.callSign ?? "");
  // Fold any lingering style_prompt / personality fields into `about` — the
  // schema is name + about only, but older models sometimes split the bio.
  const aboutParts = [
    parsed.about, parsed.personality, parsed.bio,
    parsed.stylePrompt, parsed.style_prompt,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  const about = aboutParts.join("\n\n").slice(0, 1000);
  if (!about) throw new Error("model did not return an about");
  return { name: name || null, about };
}

async function nimChatJson({ model, systemPrompt, userPrompt }) {
  if (!NVIDIA_NIM_API_KEY) throw new Error("NVIDIA_NIM_API_KEY not configured");
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NVIDIA_NIM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NIM ${model} ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function generatePersona({ seed } = {}) {
  const userPrompt = seed?.trim()
    ? `Seed from the user: ${seed.trim()}\n\nInvent a persona that fits. Return JSON only.`
    : "Invent a fresh, surprising persona. Return JSON only.";

  const tried = new Set();
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const candidates = PERSONA_MODELS.filter((m) => !tried.has(m));
    if (candidates.length === 0) break;
    const model = candidates[Math.floor(Math.random() * candidates.length)];
    tried.add(model);
    try {
      const raw = await nimChatJson({ model, systemPrompt: PERSONA_SYSTEM, userPrompt });
      const persona = parsePersonaJson(raw);
      console.log(`[persona] generated via ${model}`);
      return { ...persona, _model: model };
    } catch (err) {
      lastErr = err;
      console.log(`[persona] ${model} failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error("persona generation failed");
}

// ── AI avatar generation (FLUX via NIM) ──

const NIM_IMAGE_URL = process.env.NIM_IMAGE_URL
  ?? "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell";

function sniffMime(b64) {
  const head = b64.slice(0, 16);
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("iVBORw")) return "image/png";
  if (head.startsWith("R0lGOD")) return "image/gif";
  if (head.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

// FLUX.1-schnell returns near-uniform black JPEGs (~6-8KB) when the safety
// filter trips or the seed lands in a bad spot. Real 1024x1024 portraits
// come back at 30KB+. We retry with a fresh seed under this threshold.
const MIN_AVATAR_BYTES = 15_000;

async function fluxOnce(prompt) {
  const res = await fetch(NIM_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NVIDIA_NIM_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      prompt,
      cfg_scale: 0,
      width: 1024,
      height: 1024,
      seed: Math.floor(Math.random() * 2_147_483_647),
      steps: 4,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NIM image ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const b64 = data.image ?? data.artifacts?.[0]?.base64;
  if (!b64) throw new Error("NIM returned no image");
  return b64;
}

// Generate FLUX bytes for a name+about pair without persisting anywhere.
// Used by both the character-bound flow (generateAvatar) and the
// standalone public API.
async function generateAvatarBytes({ name, about, promptOverride }) {
  if (!NVIDIA_NIM_API_KEY) throw new Error("NVIDIA_NIM_API_KEY not configured");
  const override = (promptOverride ?? "").trim().slice(0, 1800);
  const bio = (about ?? "").trim().slice(0, 600);
  let prompt;
  if (override) {
    prompt = override;
  } else {
    const subject = bio ? `${name} — ${bio}` : name;
    prompt = [
      `Stylized portrait illustration of: ${subject}.`,
      "Use the description as thematic inspiration for mood, role, and atmosphere rather than copying specific nouns into the image.",
      "Composition: square 1:1, centered, strong silhouette, clear subject, clean negative space around the figure.",
      "No text, no watermark, no signatures, no UI chrome, no logos.",
    ].join(" ");
  }

  // Retry under the MIN_AVATAR_BYTES threshold — that's the signature of a
  // safety-blocked / black-frame response from FLUX.
  let b64;
  let bytes = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    b64 = await fluxOnce(prompt);
    bytes = Math.floor((b64.length * 3) / 4);
    if (bytes >= MIN_AVATAR_BYTES) break;
    console.warn(`[avatar] attempt ${attempt + 1}: ${bytes}B — likely blank/safety-blocked, retrying`);
  }
  if (bytes < MIN_AVATAR_BYTES) {
    throw new Error(`avatar kept coming back tiny (${bytes}B) — safety-blocked prompt?`);
  }

  const mime = sniffMime(b64);
  const ext = mime.split("/")[1] || "jpg";
  const buffer = Buffer.from(b64, "base64");
  return { buffer, mime, ext, prompt };
}

async function generateAvatar({ pubkey, name, about, promptOverride }) {
  const { buffer, mime, ext, prompt } = await generateAvatarBytes({ name, about, promptOverride });
  const filename = `avatar.${ext}`;

  // Prefer S3 when configured (prod). Local dev with no S3 env vars
  // falls through to filesystem. We intentionally write to BOTH when
  // S3 is configured so stale readers (in-flight cache, older code
  // paths) stay consistent and so the Railway volume holds a local
  // mirror for disaster-recovery purposes.
  if (s3.s3Configured) {
    await s3.putAvatar(pubkey, ext, buffer, mime);
  }
  const dir = getCharDir(pubkey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), buffer);

  const avatarUrl = `${PUBLIC_BRIDGE_URL}/characters/${pubkey}/avatar?t=${Date.now()}`;
  return { avatarUrl, prompt, filename };
}

function deleteCharacter(pubkey) {
  const dir = getCharDir(pubkey);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  // Fire-and-forget — S3 cleanup shouldn't block the HTTP response,
  // and a stray orphan object is harmless (next putAvatar with same
  // key overwrites).
  if (s3.s3Configured) s3.deleteAvatar(pubkey).catch(() => {});
  console.log(`[char] deleted ${pubkey.slice(0, 12)}...`);
  return true;
}

// ── Agent runtime lifecycle ──

function makeAgentId() {
  return "ag_" + Math.random().toString(36).slice(2, 10);
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

// agentId -> { pubkey, name, model, process, roomName, events, exitedAt?, exitCode? }
// Note: `sk` is loaded from disk at spawn time; we keep the character ref.
const agents = new Map();

// Canonical lookup used to build the nested `runtime` object on a character.
// Returns whichever runtime is associated with this character — running or
// exited-but-not-yet-reaped. The 409-on-duplicate-spawn check uses a
// separate activeRuntimeForCharacter() below.
function runtimeForCharacter(pubkey) {
  // Prefer an active (listening) runtime. Falls back to the most recently
  // inserted stopped/zombie record so respawns surface the fresh agentId
  // in /characters instead of a 120s-pending-reap corpse.
  let fallback = null;
  for (const [id, rec] of agents.entries()) {
    if (rec.pubkey !== pubkey) continue;
    if (rec.listening) return { id, rec };
    fallback = { id, rec };
  }
  return fallback;
}

function activeRuntimeForCharacter(pubkey) {
  for (const [id, rec] of agents.entries()) {
    // Driver-alive counts as "active" — blocks duplicate spawns even when
    // the pi child is between turns. Runtimes that have been stopped (and
    // are awaiting reap) are not considered active.
    if (rec.pubkey === pubkey && rec.listening) return { id, rec };
  }
  return null;
}

// Serialise the runtime record for an API response — both the list and the
// single-character endpoints use this so the shape is uniform.
function runtimeSnapshot(pubkey) {
  const r = runtimeForCharacter(pubkey);
  if (!r) return null;
  // Semantics:
  //   running   — driver alive, owns a Colyseus seat, will react to new messages
  //   thinking  — pi child process is active right now (a turn is in flight)
  //   listening — alias for running; exposed for UI clarity
  // lastUsage — latest assistant usage for the card-level context gauge.
  // Reads from whichever JSONL the active harness wrote: pi → session.jsonl,
  // direct → turns.jsonl. Cheap tail-read.
  const dir = getCharDir(pubkey);
  const harness = r.rec.harness || DEFAULT_HARNESS;
  const latest = harness === "direct"
    ? readDirectLatestUsage(join(dir, "turns.jsonl"))
    : harness === "external"
      ? null
      : readLatestUsage(join(dir, "session.jsonl"));
  return {
    agentId: r.id,
    running: !!r.rec.listening,
    listening: !!r.rec.listening,
    thinking: !!r.rec.thinking,
    turns: r.rec.turns ?? 0,
    model: r.rec.model ?? null,
    harness: r.rec.harness ?? null,
    externalDriver: r.rec.externalDriver ?? null,
    promptStyle: r.rec.promptStyle ?? null,
    roomName: r.rec.roomName ?? null,
    exitedAt: r.rec.exitedAt ?? null,
    exitCode: r.rec.exitCode ?? null,
    lastUsage: latest?.usage ?? null,
  };
}

// Per-character perception event buffer — feeds the "Recent events:"
// block injected into each turn's user prompt. See perception.js.
const perception = createPerception();

// Conversation gate — stateful scene tracker. Opens scenes when a
// pair becomes proximate, closes them on budget / soft-stop / hard
// cap / proximity_lost, and applies a per-pair cooldown so chatty
// pairs naturally drift apart. See scene-tracker.js.
const sceneTracker = createSceneTracker({
  budgetMin: Number(process.env.SCENE_BUDGET_MIN) || undefined,
  budgetMax: Number(process.env.SCENE_BUDGET_MAX) || undefined,
  hardCap: Number(process.env.SCENE_HARD_CAP) || undefined,
  cooldownMs: Number(process.env.SCENE_COOLDOWN_MS) || undefined,
  softStopRun: Number(process.env.SCENE_SOFT_STOP_RUN) || undefined,
});

// Scene journal — append-only record of every scene's full turn log.
// Lifecycle is driven by the scene tracker's open/close events and
// the post-dispatch turn record. Persisted as JSONL under $WORKSPACE.
const journal = createJournal({ workspacePath: WORKSPACE });

// Needs tracker — server-side per-character drives (energy, social,
// curiosity) decaying uniformly over sim-time. Slice 1 of #235 is
// pure tracking; slice 2 will add the need-interrupt → LLM gate.
const needsTracker = createNeedsTracker({
  simMinutePerRealMs: Number(process.env.NEEDS_SIM_MS_PER_MIN) || undefined,
});

// Tick needs every NEEDS_TICK_MS real-ms. Persist any character whose
// values have drifted by ≥ NEEDS_FLUSH_DELTA back to their manifest
// at the same cadence so a bridge restart doesn't lose progress.
const NEEDS_TICK_MS = Number(process.env.NEEDS_TICK_MS) || 5_000;
const NEEDS_FLUSH_DELTA = Number(process.env.NEEDS_FLUSH_DELTA) || 2;
const needsFlushedAt = new Map(); // pubkey → snapshot of last persisted needs
setInterval(() => {
  try {
    const decays = needsTracker.tickAll();
    for (const d of decays) {
      const last = needsFlushedAt.get(d.pubkey);
      const drifted = !last || NEED_AXES.some((a) =>
        Math.abs((d.after?.[a] ?? 0) - (last?.[a] ?? d.before?.[a] ?? 0)) >= NEEDS_FLUSH_DELTA,
      );
      if (drifted) {
        try {
          saveCharacterManifest(d.pubkey, { needs: { ...d.after } });
          needsFlushedAt.set(d.pubkey, { ...d.after });
        } catch {}
      }
      // Need-interrupt — emit a perception event for any axis that
      // crossed below lowThreshold this tick. The LLM sees it on its
      // next turn and can react ("ok, I'm bored, let me move").
      for (const c of d.crossings ?? []) {
        perception.appendOne(d.pubkey, {
          kind: "need_low",
          axis: c.axis,
          value: Math.round(c.to),
        });
      }
    }
  } catch (err) {
    console.error("[needs] tick failed:", err?.message || err);
  }
}, NEEDS_TICK_MS).unref();

// Game Master — single chokepoint for committing harness-emitted
// actions. See gm.js for the verb registry and dispatch logic.
// The tracker's effective scene helpers are injected so cooldowns
// flow through to say_to validation, perception emission, etc.
const gm = createGM({
  roomSay,
  relayPost,
  moveAgent,
  saveCharacterManifest,
  loadCharacter,
  perception,
  sceneMatesOf: sceneTracker.effectiveSceneMatesOf,
  inScene: sceneTracker.effectiveInScene,
  needsTracker, // optional GM dep; set_mood mirrors values into the tracker
});

// Heartbeat scheduler — drives autonomous turns at a scene-aware
// cadence so characters keep thinking even with no incoming events.
// See scheduler.js. Reactive triggers (message_received / arrival)
// still fire through the existing tryListenTurn debounce path; this
// is a backstop for the "nothing's happening, what would you do" case.
// `runPiTurn` is hoisted via its function declaration further down.
const scheduler = createScheduler({
  getSnapshot: (agentId) => roomSnapshot(agentId),
  runTurn: (rec, opts) => runPiTurn(rec, opts),
  // Cooldown-aware so paired-out characters fall back to alone-cadence.
  sceneMatesOf: sceneTracker.effectiveSceneMatesOf,
});

// Execute actions returned by a harness turn. Each action is a
// discriminated-union object — { type: 'say'|'move'|'state', ... }.
// Harnesses that commit side-effects themselves (like PiHarness via
// its bash loopback through /internal/post) return an empty array
// and this is a no-op for them.
async function executeActions(rec, actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;
  for (const action of actions) {
    // Fresh snapshot per action — earlier actions in the same turn may
    // have already moved the actor, and later actions need to see
    // post-move scene composition.
    const snapshot = roomSnapshot(rec.agentId);
    // Sync scene tracker with the latest positions BEFORE dispatch so
    // newly-formed pairs open scenes and lost-proximity pairs close.
    const sceneTransitions = sceneTracker.onSnapshot(snapshot);
    emitSceneTransitionEvents(sceneTransitions);

    const result = await gm.dispatch(
      {
        agentId: rec.agentId,
        pubkey: rec.pubkey,
        name: rec.name,
        model: rec.model,
        snapshot,
      },
      action,
    );
    if (!result.ok) {
      const verb = result.verb || action?.type || "?";
      console.error(`[actions:${rec.agentId}] ${verb} rejected: ${result.reason}`);
      rec.events.push({ kind: "action-error", action: verb, error: result.reason });
      // The actor sees their own rejection on the next perception turn.
      perception.appendOne(rec.pubkey, {
        kind: "action_rejected",
        verb,
        reason: result.reason,
      });
    } else {
      // Append the committed turn to the journal for every active
      // scene this actor is in. Done BEFORE recordAction so the turn
      // is captured even if the scene closes on this same action.
      journal.appendTurnForActor(rec.pubkey, {
        actor_pubkey: rec.pubkey,
        actor_name: rec.name,
        verb: result.verb,
        args: result.args,
      });
      // Record the committed action with the tracker so budget /
      // soft-stop / hard-cap can fire. Closes scenes that exceeded
      // their gate; participants see the close event next turn.
      const closed = sceneTracker.recordAction(rec.pubkey, result.verb);
      for (const scene of closed) {
        emitSceneCloseEvent(scene);
      }
    }
  }
}

// Surface scene_open / scene_close in each participant's perception
// stream so the LLM is aware of state transitions on its next turn,
// and mirror the lifecycle into the persistent journal.
function emitSceneTransitionEvents(transitions) {
  for (const scene of transitions.opened || []) {
    journal.openScene({
      sceneId: scene.sceneId,
      participants: scene.participants,
      startedAt: scene.startedAt,
      budget: scene.budget,
    });
    perception.broadcastTo(scene.participants, {
      kind: "scene_open",
      sceneId: scene.sceneId,
      with_pubkeys: scene.participants,
    });
  }
  for (const scene of transitions.closed || []) {
    emitSceneCloseEvent(scene);
  }
}

function emitSceneCloseEvent(scene) {
  // Finalise the journal record before broadcasting so a follow-up
  // GET /scenes/:id can fetch the persisted form immediately.
  journal.closeScene({
    sceneId: scene.sceneId,
    endReason: scene.reason,
  });
  perception.broadcastTo(scene.participants, {
    kind: "scene_close",
    sceneId: scene.sceneId,
    with_pubkeys: scene.participants,
    reason: scene.reason,
  });
  console.log(`[scenes] closed ${scene.sceneId} (${scene.participants.join(" + ")}) — ${scene.reason}`);
}

// Ensure a harness is started for `rec`. Harnesses are created lazily
// on the first turn so stopAgent between create and trigger doesn't
// pay any cost. Persisted across turns for the life of the agent.
async function ensureHarness(rec, { systemPrompt }) {
  if (rec.harnessInstance) {
    // System prompt drift (e.g. character PATCHed mid-session) — tell
    // the harness so it can repin (pi) or just remember it (direct).
    if (rec.systemPromptSignature !== systemPrompt) {
      rec.harnessInstance.updateSystemPrompt?.(systemPrompt);
      rec.systemPromptSignature = systemPrompt;
    }
    return rec.harnessInstance;
  }
  const charDir = getCharDir(rec.pubkey);
  const sessionPath = join(charDir, "session.jsonl");
  const provider = rec.provider || providerForModelId(rec.model);
  const harnessName = rec.harness || DEFAULT_HARNESS;
  const harness = createHarness(harnessName);
  await harness.start({
    agentId: rec.agentId,
    pubkey: rec.pubkey,
    systemPrompt,
    provider,
    model: rec.model,
    sessionPath,
    cwd: charDir,
    env: {
      ...process.env,
      NVIDIA_NIM_API_KEY,
      GEMINI_API_KEY,
      LOCAL_LLM_BASE_URL,
      HOME: homedir(),
    },
    onEvent: (ev) => {
      if (ev?.data?.kind === "pool:crashed" || ev?.kind === "pool:crashed") {
        rec.listening = false;
        rec.events.push({ kind: "exit", code: "crash-loop", turns: rec.turns });
      }
      rec.events.push(ev);
    },
  });
  rec.harnessInstance = harness;
  rec.systemPromptSignature = systemPrompt;
  return harness;
}

// Drive a single turn via the agent's harness. Harness-agnostic —
// pi / direct / external all plug in here without runPiTurn knowing
// the difference. Returns the turn result for callers that care.
async function runPiTurn(rec, { seedMessage, trigger = "heartbeat", triggerContext = {} }) {
  const character = loadCharacter(rec.pubkey);
  const snapshot = roomSnapshot(rec.agentId);

  // Resolve the current presence for this character so the user turn can
  // mention the agent's own (x, y). Snapshot is authoritative.
  const myPresence = (snapshot.agents ?? []).find((a) => a.npub === rec.pubkey) || {};

  const systemPrompt = buildSystemPrompt({
    name: rec.name,
    npub: rec.pubkey,
    about: character?.about,
    state: character?.state,
    roomWidth: snapshot.width,
    roomHeight: snapshot.height,
    harness: rec.harness,
    promptStyle: rec.promptStyle || character?.promptStyle || "minimal",
  });

  // Drain perception events the GM has buffered for this character
  // since their last turn. Bumped after the harness call (below) so a
  // mid-turn crash doesn't drop events.
  const perceptionEvents = perception.eventsSince(rec.pubkey, rec.lastSeenEventTs);

  // Build the memory block — past closed scenes between this actor
  // and any current scene-mates. The LLM reads its own past dialogue
  // verbatim; drift over time emerges from the accumulating record.
  const sceneMatePubkeys = sceneTracker.effectiveSceneMatesOf(snapshot, rec.pubkey);
  const sceneMates = sceneMatePubkeys.map((pk) => {
    const a = (snapshot.agents ?? []).find((x) => x.npub === pk);
    return { pubkey: pk, name: a?.name };
  });
  const memoryBlock = buildMemoryBlock({
    selfPubkey: rec.pubkey,
    selfName: rec.name,
    sceneMates,
    recentScenesBetween: (a, b, opts) => journal.recentScenesBetween(a, b, opts),
  });

  // Read the current needs / mood for the perception block. Tickless
  // here — the global needs interval is already advancing values.
  const needsRec = needsTracker.get(rec.pubkey);
  const needsLine = needsRec ? describeNeeds(needsRec.needs) : "";

  const userTurn = buildUserTurn({
    character: { pubkey: rec.pubkey, x: myPresence.x ?? 0, y: myPresence.y ?? 0 },
    trigger,
    triggerContext,
    roomSnapshot: snapshot,
    lastSeenMessageTs: rec.lastSeenMessageTs,
    perceptionEvents,
    memoryBlock,
    needsLine,
    seedMessage,
  });

  const provider = rec.provider || providerForModelId(rec.model);

  // Global rate-limit circuit breaker — short-circuit the turn rather
  // than hammering a quota'd provider. The listener will re-trigger
  // once the cooldown expires.
  if (rateLimiter.isInCooldown(provider)) {
    rec.events.push({
      kind: "rate-limit-deferred",
      provider,
      remainingMs: rateLimiter.getCooldownRemaining(provider),
    });
    return null;
  }

  const harness = await ensureHarness(rec, { systemPrompt });

  rec.turns = (rec.turns ?? 0) + 1;
  rec.lastTriggerAt = Date.now();
  rec.thinking = true;

  try {
    const result = await harness.turn(userTurn);
    // Execute any actions the harness produced. PiHarness returns
    // [] because its bash-tool loopback already committed them.
    await executeActions(rec, result?.actions);
    // Bump the high-water mark so the next user turn's delta carries
    // only messages newer than the current snapshot.
    const latest = snapshot.messages?.length
      ? Math.max(...snapshot.messages.map((m) => m.ts ?? 0))
      : rec.lastSeenMessageTs ?? 0;
    rec.lastSeenMessageTs = latest;
    // Mark all perception events delivered this turn as seen. Use the
    // newest event's ts; if there were no events, leave the watermark.
    const latestEventTs = perceptionEvents.length
      ? Math.max(...perceptionEvents.map((e) => e.ts ?? 0))
      : rec.lastSeenEventTs ?? 0;
    rec.lastSeenEventTs = latestEventTs;
    return result;
  } catch (err) {
    const wasRateLimit = rateLimiter.recordError(provider, err);
    rec.events.push({
      kind: wasRateLimit ? "rate-limit" : "turn-error",
      provider,
      error: err?.message || String(err),
    });
    if (!wasRateLimit) console.error(`[${harness.name}:${rec.agentId}] turn error:`, err?.message || err);
    return null;
  } finally {
    rec.thinking = false;
  }
}

// Per-agent caps for continuous listening. Tunable via env.
const AGENT_MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 20);
const AGENT_MIN_TRIGGER_GAP_MS = Number(process.env.AGENT_MIN_TRIGGER_GAP_MS || 15_000);
const AGENT_DEBOUNCE_MS = Number(process.env.AGENT_DEBOUNCE_MS || 1_500);
const AGENT_IDLE_TIMEOUT_MS = Number(process.env.AGENT_IDLE_TIMEOUT_MS || 5 * 60_000);

async function createAgent({ pubkey, name, seedMessage, roomName, model, provider, harness, promptStyle, externalDriver, x, y }) {
  // Resolve character: either provided by pubkey, or auto-create (back-compat).
  let character;
  if (pubkey) {
    character = loadCharacter(pubkey);
    if (!character) throw new Error(`unknown character ${pubkey}`);
    if (activeRuntimeForCharacter(pubkey)) {
      const err = new Error("character already has a running runtime");
      err.code = 409;
      throw err;
    }
  } else {
    character = createCharacter({ name });
  }

  // Harness selection: spawn-time override > character manifest > default.
  // Validate against the factory's known list to fail fast on typos.
  const chosenHarness = harness || character.harness || DEFAULT_HARNESS;
  if (!KNOWN_HARNESSES.includes(chosenHarness)) {
    const err = new Error(`unknown harness "${chosenHarness}" (known: ${KNOWN_HARNESSES.join(", ")})`);
    err.code = 400;
    throw err;
  }

  // Prompt style: spawn-time override > character manifest > minimal.
  // The same priority Brain uses, with the same fail-fast validation.
  const ALLOWED_PROMPT_STYLES = ["minimal", "dynamic"];
  const chosenPromptStyle = promptStyle || character.promptStyle || "minimal";
  if (!ALLOWED_PROMPT_STYLES.includes(chosenPromptStyle)) {
    const err = new Error(`unknown promptStyle "${chosenPromptStyle}" (allowed: ${ALLOWED_PROMPT_STYLES.join(", ")})`);
    err.code = 400;
    throw err;
  }
  const agentId = makeAgentId();
  const charDir = getCharDir(character.pubkey);
  const resolvedName = character.name;

  // Make sure skills + identity are in place (idempotent).
  mkdirSync(join(charDir, ".pi"), { recursive: true });
  writeFileSync(join(charDir, ".pi", "identity"), character.pubkey, "utf-8");
  installSkills(charDir);

  // Join the room and stay joined — the Colyseus seat persists across
  // pi turns. Listener re-prompts pi when new messages arrive. If x/y
  // are supplied (drop-to-spawn UX), the server clamps and uses them;
  // otherwise the server picks a random starting tile.
  await joinRoom(agentId, {
    name: resolvedName,
    npub: character.pubkey,
    roomName: roomName || "sandbox",
    x, y,
  });

  const validIds = new Set(availableModels().map((m) => m.id));
  const chosenModel = model && validIds.has(model) ? model : DEFAULT_MODEL_ID;

  const events = newEventBuffer();
  const rec = {
    agentId,
    sk: character.sk,
    pubkey: character.pubkey,
    name: resolvedName,
    roomName: roomName || "sandbox",
    model: chosenModel,
    // Provider is resolved once at spawn time so pi is invoked with the
    // right --provider flag on every subsequent turn. Explicit wins over
    // catalog inference (which only checks id prefixes).
    provider: provider || providerForModelId(chosenModel),
    harness: chosenHarness,
    promptStyle: chosenPromptStyle,
    // For external harness: a free-form label for what's actually driving
    // the turn loop (e.g. "claude-opus-4-7", "gpt-5", or just "claude").
    // The bridge's `model` field is irrelevant for external — the external
    // client's LLM does the thinking. Surfaced in /agents and /characters
    // so the UI can show "external · claude" instead of the bridge default.
    externalDriver: chosenHarness === "external" && typeof externalDriver === "string"
      ? externalDriver.trim().slice(0, 60) || null
      : null,
    harnessInstance: null,
    events,
    process: null,
    turns: 0,
    lastTriggerAt: 0,
    lastMessageAt: Date.now(),
    debounceTimer: null,
    idleTimer: null,
    listening: true,
    unsubscribe: null,
  };
  agents.set(agentId, rec);

  // Persist the chosen model + harness + promptStyle so the next spawn
  // (drag-to-spawn etc) defaults to whatever the user just picked,
  // unless they explicitly override at spawn time again.
  saveCharacterManifest(character.pubkey, {
    model: chosenModel,
    harness: chosenHarness,
    promptStyle: chosenPromptStyle,
  });

  publishAdminWelcome({
    agentPubkey: character.pubkey,
    agentName: resolvedName,
    roomName: roomName || "sandbox",
  }).catch(() => {});

  // Subscribe to new room messages. Messages from this agent are skipped.
  const unsubMsg = onNewMessage(agentId, (msg) => {
    if (!rec.listening) return;
    if (msg.fromNpub === rec.pubkey) return; // own echo
    rec.lastMessageAt = Date.now();
    // Remember the most recent non-self message so the listener can
    // label its next turn with `message_received` + {fromName}.
    rec.pendingTrigger = {
      trigger: "message_received",
      triggerContext: { fromPubkey: msg.fromNpub, fromName: msg.from },
    };
    if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
    rec.debounceTimer = setTimeout(() => tryListenTurn(rec), AGENT_DEBOUNCE_MS);
  });
  // Subscribe to position changes. Fires only when another agent moves
  // into adjacent distance (Chebyshev 1); room-client.js does the
  // bookkeeping. `arrival` trigger wins if both messages and positions
  // change in the same debounce window — the last-set trigger is used.
  const unsubPos = onPositionChange(agentId, rec.pubkey, (evt) => {
    if (!rec.listening) return;
    rec.lastMessageAt = Date.now();
    rec.pendingTrigger = {
      trigger: "arrival",
      triggerContext: { fromPubkey: evt.fromNpub, fromName: evt.fromName, x: evt.x, y: evt.y },
    };
    if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
    rec.debounceTimer = setTimeout(() => tryListenTurn(rec), AGENT_DEBOUNCE_MS);
  });
  rec.unsubscribe = () => { try { unsubMsg() } catch {}; try { unsubPos() } catch {} };

  // Idle timeout — if nothing's happened for a while, the driver shuts
  // down on its own so forgotten agents don't hold seats forever.
  rec.idleTimer = setInterval(() => {
    if (Date.now() - rec.lastMessageAt > AGENT_IDLE_TIMEOUT_MS) {
      console.log(`[driver:${agentId}] idle too long, stopping`);
      stopAgent(agentId).catch(() => {});
    }
  }, 30_000);
  rec.idleTimer.unref();

  // Forward room messages to any harness that wants them (external's
  // SSE stream). No-op for pi/direct. Must be registered before the
  // seed turn fires so the client sees every room message going forward.
  const unsubExtraMsg = onNewMessage(agentId, (msg) => {
    try { rec.harnessInstance?.notifyMessage?.(msg); } catch {}
  });
  const prevUnsub = rec.unsubscribe;
  rec.unsubscribe = () => {
    try { prevUnsub?.(); } catch {}
    try { unsubExtraMsg?.(); } catch {}
  };

  const out = {
    agentId,
    npub: character.pubkey,
    pubkey: character.pubkey,
    model: chosenModel,
    name: resolvedName,
    harness: chosenHarness,
    promptStyle: chosenPromptStyle,
    externalDriver: rec.externalDriver,
  };

  // Pre-start the harness BEFORE the seed turn fires — both to avoid
  // a race between the async seed runPiTurn and the external pre-start
  // (both used to call ensureHarness and could create two instances),
  // and so external-harness spawners get a token + URLs back in the
  // spawn response. For external harness we additionally defer the
  // seed turn emission until AFTER the spawn response returns so the
  // caller has time to open the SSE stream first.
  if (chosenHarness === "external") {
    const snapshot = roomSnapshot(agentId);
    const systemPrompt = buildSystemPrompt({
      name: rec.name,
      npub: rec.pubkey,
      about: character?.about,
      state: character?.state,
      roomWidth: snapshot.width,
      roomHeight: snapshot.height,
      harness: chosenHarness,
      promptStyle: chosenPromptStyle,
    });
    try {
      await ensureHarness(rec, { systemPrompt });
    } catch (err) {
      rec.listening = false;
      await leaveRoom(agentId).catch(() => {});
      agents.delete(agentId);
      err.code = err.code || 503;
      throw err;
    }
    out.agentToken = rec.harnessInstance.getToken();
    out.streamUrl = `${PUBLIC_BRIDGE_URL}/external/${character.pubkey}/events/stream`;
    out.actUrl = `${PUBLIC_BRIDGE_URL}/external/${character.pubkey}/act`;
    out.heartbeatUrl = `${PUBLIC_BRIDGE_URL}/external/${character.pubkey}/heartbeat`;
  }

  console.log(`[agent] spawned ${agentId} name="${resolvedName}" model=${chosenModel} harness=${chosenHarness} npub=${character.pubkey.slice(0, 12)}...`);

  // Seed turn — typed trigger "spawn". For non-external harnesses,
  // fire immediately. For external, delay briefly so the client has
  // a chance to open the SSE stream before the first turn_request;
  // attachStream re-emits on connect, so this is belt-and-suspenders.
  const firstSeed =
    seedMessage
    || "Introduce yourself briefly to the room by posting a short greeting.";
  const fireSeed = () => {
    runPiTurn(rec, { seedMessage: firstSeed, trigger: "spawn", triggerContext: {} })
      .catch((err) => console.error(`[spawn:${agentId}] seed turn failed:`, err?.message || err));
  };
  if (chosenHarness === "external") {
    setTimeout(fireSeed, 500);
  } else {
    fireSeed();
  }

  // Hand the agent over to the heartbeat scheduler so it keeps
  // thinking when no reactive events arrive.
  scheduler.attach(rec);

  // Register with the needs tracker so this character's drives start
  // decaying. Persisted needs are seeded from the manifest; defaults
  // fill in for new characters.
  needsTracker.register(character.pubkey, {
    needs: character.needs,
  });

  return out;
}

// Called from the room-message listener (debounced). Runs a new pi turn if:
//   - the driver is still listening
//   - no pi currently running for this agent
//   - we haven't triggered within AGENT_MIN_TRIGGER_GAP_MS
//   - we're under AGENT_MAX_TURNS
function tryListenTurn(rec) {
  if (!rec.listening) return;
  if (rec.thinking) return; // a turn is already in flight on the resident pi
  if (rec.turns >= AGENT_MAX_TURNS) {
    console.log(`[driver:${rec.agentId}] reached max turns (${AGENT_MAX_TURNS}), stopping`);
    stopAgent(rec.agentId).catch(() => {});
    return;
  }
  const sinceLast = Date.now() - rec.lastTriggerAt;
  if (sinceLast < AGENT_MIN_TRIGGER_GAP_MS) return;
  const pending = rec.pendingTrigger ?? { trigger: "heartbeat", triggerContext: {} };
  rec.pendingTrigger = null;
  runPiTurn(rec, pending).catch((err) => {
    console.error(`[driver:${rec.agentId}] turn failed:`, err?.message || err);
  });
}

async function stopAgent(agentId) {
  const rec = agents.get(agentId);
  if (!rec) return false;
  rec.listening = false;
  if (rec.debounceTimer) { clearTimeout(rec.debounceTimer); rec.debounceTimer = null; }
  if (rec.idleTimer) { clearInterval(rec.idleTimer); rec.idleTimer = null; }
  if (rec.unsubscribe) { try { rec.unsubscribe(); } catch {} }
  // Tear down the harness. PiHarness kills its subprocess; Direct /
  // External release whatever resources they hold.
  try {
    await rec.harnessInstance?.stop();
  } catch (err) {
    console.error(`[stop:${agentId}] harness.stop threw:`, err?.message || err);
  }
  rec.harnessInstance = null;
  rec.thinking = false;
  rec.exitedAt = Date.now();
  rec.events.push({ kind: "exit", code: "stopped", turns: rec.turns });
  // Stop heartbeat ticks for this agent; drop any buffered perception
  // events; clear scene tracker state for this character. The next
  // spawn starts with a clean slate. Needs are unregistered too —
  // they'll re-seed from the manifest on next spawn.
  scheduler.detach(rec);
  perception.clear(rec.pubkey);
  sceneTracker.clearCharacter(rec.pubkey);
  needsTracker.unregister(rec.pubkey);
  needsFlushedAt.delete(rec.pubkey);
  await leaveRoom(agentId);
  // Record stays around briefly so the inspector drawer remains readable;
  // reaper (below) purges after REAP_AFTER_MS.
  return true;
}

// Reap records whose pi process has been gone for > REAP_AFTER_MS.
// We keep them around briefly so the inspector stays readable after exit.
const REAP_AFTER_MS = 120_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of agents.entries()) {
    if (rec.exitedAt && now - rec.exitedAt > REAP_AFTER_MS) {
      // Character workspace persists; only the runtime record is purged.
      agents.delete(id);
      console.log(`[agent] reaped runtime ${id} after ${Math.round((now - rec.exitedAt) / 1000)}s`);
    }
  }
}, 30_000).unref();

// ── Room + relay publishing ──
//
// Today these are split into three helpers:
//   roomSay(agentId, content)      — Colyseus room broadcast only.
//                                    Used by the `say` / `say_to` verbs.
//                                    Speech is private to the scene.
//   relayPost(agentId, content)    — Nostr kind:1 publish only. Used by
//                                    the `post` verb. Public social media.
//   publishKind1(agentId, content) — combined: room + relay. Kept for
//                                    pi's /internal/post endpoint and
//                                    any other legacy callers.
//
// The split is what implements the Nostr decoupling from #225: in-scene
// speech no longer hits the relay; only deliberate `post` actions do.

function roomSay(agentId, content) {
  sendSay(agentId, content);
}

async function relayPost(agentId, content, modelTag) {
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
  // Fire-and-forget — log failures but don't propagate. Small local
  // models were failing entire turns when the relay round-trip hiccupped.
  Promise.allSettled(pool.publish([RELAY_URL], event)).then((results) => {
    const ok = results.some((r) => r.status === "fulfilled");
    if (!ok) console.warn(`[relay:${agentId}] kind:1 publish failed on all relays`);
  });
  return event;
}

async function publishKind1(agentId, content, modelTag) {
  const rec = agents.get(agentId);
  if (!rec) throw new Error("unknown agent");
  // The Colyseus room is the primary channel — do it first, synchronously,
  // so the message reaches the chat immediately regardless of whether the
  // Nostr relay is healthy. Relay publish is best-effort in the background.
  sendSay(agentId, content);
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
  // Fire-and-forget — log failures but don't propagate to pi. Small local
  // models were failing entire turns when the relay round-trip hiccupped.
  Promise.allSettled(pool.publish([RELAY_URL], event)).then((results) => {
    const ok = results.some((r) => r.status === "fulfilled");
    if (!ok) {
      const reasons = results.map((r) => r.status === "rejected" ? r.reason?.message || String(r.reason) : "").filter(Boolean);
      console.warn(`[publish] relay failed (chat still delivered): ${reasons.join("; ")}`);
    } else {
      console.log(`[publish] ok event=${event.id.slice(0, 12)} relay=${RELAY_URL}`);
    }
  });
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
    pool: piPool.poolSnapshot(),
    cooldowns: rateLimiter.snapshot(),
  });
});

// Scene tracker introspection — useful for verifying the conversation
// gate is firing as expected. Lists active scenes (with turn budget +
// remaining), pair cooldowns, and per-character quiet-action runs.
app.get("/health/scenes", (_req, res) => {
  res.json(sceneTracker.snapshot());
});

// Needs tracker introspection — current per-character needs vector,
// derived mood, and personality. Useful for tuning decay rates.
app.get("/health/needs", (_req, res) => {
  res.json({ characters: needsTracker.snapshot() });
});

// ── Scene journal ──
//
// Read-back of closed scene transcripts. Open scenes (in-flight) are
// reachable via /scenes/:id but do not appear in the list view; pull
// them from /health/scenes if you want live state.

app.get("/scenes", (req, res) => {
  const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
  const before = req.query.before ? Number(req.query.before) : undefined;
  const participant = typeof req.query.participant === "string" ? req.query.participant : undefined;
  try {
    const scenes = journal.listScenes({ limit, before, participant });
    res.json({ scenes });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get("/scenes/:id", (req, res) => {
  const scene = journal.getScene(req.params.id);
  if (!scene) return res.status(404).json({ error: "scene not found" });
  res.json(scene);
});

// ── Public persona generation API ──
//
// Standalone wrapper around generatePersona() — does not require a
// character. Quota-gated per IP + global daily cap. Every call is logged.
// External agents can call this to get a persona without going through
// the full onboarding flow; if they want it browsable on Jumble they
// follow the existing 3-step character onboarding with the returned `about`.

app.get("/v1/personas/status", (_req, res) => {
  res.json({
    quota: apiQuota.snapshot(),
    providers: rateLimiter.snapshot(),
    recent: personaLog.recentStats(),
  });
});

app.get("/v1/personas/log", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const cursor = Number(req.query.cursor) || 0;
  res.json(personaLog.list({ limit, cursor, redactAbout: true }));
});

app.get("/v1/personas/log/:id", (req, res) => {
  const row = personaLog.getById(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

function jumbleProfileUrl(pubkey) {
  if (!PUBLIC_JUMBLE_URL) return null;
  try { return `${PUBLIC_JUMBLE_URL.replace(/\/$/, "")}/${npubEncode(pubkey)}`; }
  catch { return null; }
}

app.post("/v1/personas/generate", apiQuota.middleware, async (req, res) => {
  const id = personaLog.newId();
  const ip = apiQuota.clientIp(req);
  const seed = typeof req.body?.seed === "string" ? req.body.seed : null;
  const startedAt = Date.now();
  let createdPubkey = null;
  try {
    const persona = await generatePersona({ seed });
    // Mint a character so the persona is browsable on the relay (and Jumble).
    const c = createCharacter({ name: persona.name });
    createdPubkey = c.pubkey;
    saveCharacterManifest(c.pubkey, {
      about: persona.about ?? null,
      profileSource: "ai",
      profileModel: persona._model ?? null,
    });

    let imageUrl = null;
    let imageError = null;
    let imagePrompt = null;
    try {
      const av = await generateAvatar({
        pubkey: c.pubkey,
        name: c.name,
        about: persona.about ?? "",
      });
      saveCharacterManifest(c.pubkey, { avatarUrl: av.avatarUrl });
      imageUrl = av.avatarUrl;
      imagePrompt = av.prompt;
    } catch (err) {
      imageError = err.message ?? String(err);
      console.warn("[v1/personas/generate] image failed:", imageError);
    }

    // Publish kind:0 so Jumble can render the profile.
    let relayPublished = false;
    let relayError = null;
    try { relayPublished = !!(await publishCharacterProfile(c.pubkey)); }
    catch (err) { relayError = err.message ?? String(err); }

    const after = loadCharacter(c.pubkey);
    const npub = npubEncode(c.pubkey);
    const jumbleUrl = jumbleProfileUrl(c.pubkey);
    apiQuota.recordSuccess();
    const durationMs = Date.now() - startedAt;
    personaLog.append({
      id, ip, ok: true, kind: "public",
      pubkey: c.pubkey, npub, jumbleUrl,
      seedHash: personaLog.hashSeed(seed),
      model: persona._model ?? null,
      durationMs,
      name: after.name,
      about: after.about ?? null,
      imageUrl,
      imageError,
      imagePrompt,
      relayPublished,
      relayError,
    });
    res.json({
      id,
      pubkey: c.pubkey,
      npub,
      jumbleUrl,
      name: after.name,
      about: after.about ?? null,
      model: persona._model ?? null,
      imageUrl,
      imageError,
      relayPublished,
      relayError,
      durationMs,
    });
  } catch (err) {
    apiQuota.refund();
    const durationMs = Date.now() - startedAt;
    personaLog.append({
      id, ip, ok: false, kind: "public",
      pubkey: createdPubkey,
      seedHash: personaLog.hashSeed(seed),
      model: null,
      durationMs,
      error: err.message ?? String(err),
    });
    console.error("[v1/personas/generate]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/admin", (_req, res) => {
  res.json({
    pubkey: admin.pubkey,
    npub: npubEncode(admin.pubkey),
    profile: ADMIN_PROFILE,
  });
});

app.get("/human", (_req, res) => {
  res.json({
    pubkey: human.pubkey,
    npub: npubEncode(human.pubkey),
    profile: HUMAN_PROFILE,
  });
});

// One-shot bulk migrate the prompt style on stored character
// manifests. Useful after the dynamic/minimal A/B settles — flipping
// every legacy `minimal` (or any character with no field) to
// `dynamic` in a single call so users don't have to drawer-edit each
// character. Body:
//   { from?: 'minimal' | null, to: 'minimal' | 'dynamic' }
// `from` matches both the explicit value and the missing-field case
// when set to 'minimal' or omitted.
app.post("/admin/migrate-prompt-style", (req, res) => {
  const { from, to } = req.body || {};
  const ALLOWED = ["minimal", "dynamic"];
  if (!ALLOWED.includes(to)) {
    return res.status(400).json({ error: `bad 'to': ${to} (allowed: ${ALLOWED.join(", ")})` });
  }
  if (from !== undefined && from !== null && !ALLOWED.includes(from)) {
    return res.status(400).json({ error: `bad 'from': ${from}` });
  }
  const matchAll = from === undefined || from === null;
  const wantFrom = matchAll ? null : from;
  const rows = listCharacters();
  let migrated = 0;
  const skipped = [];
  for (const c of rows) {
    const cur = c.promptStyle || null;
    const fromMatches = matchAll
      ? (cur === null || cur === "minimal")
      : (cur === wantFrom);
    if (!fromMatches) { skipped.push({ pubkey: c.pubkey, reason: `current='${cur}'` }); continue; }
    if (cur === to) { skipped.push({ pubkey: c.pubkey, reason: "already-target" }); continue; }
    saveCharacterManifest(c.pubkey, { promptStyle: to });
    migrated += 1;
  }
  res.json({ migrated, skipped: skipped.length, to, scanned: rows.length });
});

app.post("/human/move", async (req, res) => {
  try {
    const { x, y, roomName } = req.body || {};
    const result = await moveAs({
      identityKey: "human",
      roomName: roomName || "sandbox",
      name: HUMAN_PROFILE.name,
      npub: human.pubkey,
      x, y,
    });
    res.json(result);
  } catch (err) {
    console.error("[human:move]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/human/say", async (req, res) => {
  try {
    const { content, roomName, x, y } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "content required" });
    }
    const text = String(content).slice(0, 1000);
    // Send to the Colyseus room so agents see it in their snapshot + future
    // spawns, and publish to the relay so external observers see it.
    const roomResult = await sayAs({
      identityKey: "human",
      roomName: roomName || "sandbox",
      name: HUMAN_PROFILE.name,
      npub: human.pubkey,
      text,
      x, y,
    }).catch((err) => ({ ok: false, error: err.message }));
    let relayEvent = null;
    try {
      relayEvent = await publishKind1From({
        sk: human.sk,
        pubkey: human.pubkey,
        content: text,
      });
    } catch (err) {
      console.error("[human:say] relay publish failed:", err.message);
    }
    res.json({
      ok: true,
      room: roomResult?.ok ?? false,
      roomError: roomResult?.error ?? null,
      eventId: relayEvent?.id ?? null,
    });
  } catch (err) {
    console.error("[human:say]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/agents", async (req, res) => {
  try {
    const { pubkey, name, seedMessage, roomName, model, provider, harness, promptStyle, externalDriver, x, y } = req.body || {};
    if (!pubkey && !name) return res.status(400).json({ error: "pubkey or name required" });
    const result = await createAgent({ pubkey, name, seedMessage, roomName, model, provider, harness, promptStyle, externalDriver, x, y });
    res.json(result);
  } catch (err) {
    const status = err.code === 400 ? 400 : err.code === 409 ? 409 : 500;
    if (status !== 409) console.error("[agents:create]", err);
    res.status(status).json({ error: err.message });
  }
});

app.post("/agents/:id/move", (req, res) => {
  const agentId = req.params.id;
  const { x, y } = req.body || {};
  const ok = moveAgent(agentId, x, y);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ── External-harness endpoints ──
// The SSE stream, action POST, and heartbeat for agents spawned with
// harness: "external". All three are keyed by pubkey rather than
// agentId since the client only knows the pubkey it minted.

function _extBearer(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return (req.query?.token || "").toString();
}

function _resolveExternal(req, res) {
  const pubkey = req.params.pubkey;
  const active = activeRuntimeForCharacter(pubkey);
  if (!active) { res.status(404).json({ error: "no active agent for pubkey" }); return null; }
  const rec = active.rec;
  if (rec.harness !== "external" || !rec.harnessInstance?.verifyToken) {
    res.status(400).json({ error: "not an external-harness agent" });
    return null;
  }
  const token = _extBearer(req);
  const parsed = rec.harnessInstance.verifyToken(token);
  if (!parsed) { res.status(401).json({ error: "invalid or expired token" }); return null; }
  return rec;
}

app.get("/external/:pubkey/events/stream", (req, res) => {
  const rec = _resolveExternal(req, res);
  if (!rec) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");
  const lastEventId = req.headers["last-event-id"];
  try { rec.harnessInstance.attachStream({ res, lastEventId }); } catch (err) {
    console.error(`[ext:stream:${rec.pubkey.slice(0,10)}] attach failed:`, err?.message || err);
    return res.end();
  }
  const ka = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(ka); }
  }, 15_000);
  req.on("close", () => {
    clearInterval(ka);
    try { rec.harnessInstance?.detachStream?.(); } catch {}
  });
});

app.post("/external/:pubkey/act", (req, res) => {
  const rec = _resolveExternal(req, res);
  if (!rec) return;
  const { turnId, text, move, state } = req.body || {};
  if (!turnId) return res.status(400).json({ error: "turnId required" });
  const result = rec.harnessInstance.recordAct({ turnId, text, move, state });
  if (!result?.ok) return res.status(result.code || 400).json({ error: result.error });
  res.json({ ok: true, actions: result.actions });
});

app.post("/external/:pubkey/heartbeat", (req, res) => {
  const rec = _resolveExternal(req, res);
  if (!rec) return;
  rec.harnessInstance.touchHeartbeat();
  res.json({ ok: true });
});

// Idle external agents lose their connection → evict so the room
// doesn't zombie. Checked every 60s.
setInterval(() => {
  for (const [id, rec] of agents.entries()) {
    if (rec.harness !== "external") continue;
    if (!rec.harnessInstance?.isIdleTooLong) continue;
    if (rec.harnessInstance.isIdleTooLong()) {
      console.log(`[external] evicting ${rec.pubkey.slice(0, 10)} — heartbeat timeout`);
      stopAgent(id).catch(() => {});
    }
  }
}, 60_000).unref();

// ── /complete — headless one-shot LLM call via pi ──
//
// Unlike the full agent runtime (Colyseus seat, listener, skill scripts,
// relay publishing), this is just a thin wrapper around `pi --print`:
//   POST /complete { systemPrompt, userMessage, provider?, model?, sessionKey? }
//   → { text, thinking?, model, provider, usage }
//
// `sessionKey`, if set, enables stateful history: pi is invoked with
// `--session $WORKSPACE/.sessions/<sha256(sessionKey)>.jsonl` so
// subsequent calls with the same key see prior turns. Omit for
// stateless one-shots.
//
// Tools are not exposed. Pi's built-in `bash` is still reachable but
// pointing a stateless call at bash is a recipe for sadness; the
// intent is that the caller asks for structured JSON in the system
// prompt and parses `text` on return.

const COMPLETE_SESSIONS_DIR = join(WORKSPACE, ".sessions");
mkdirSync(COMPLETE_SESSIONS_DIR, { recursive: true });

function sessionPathForKey(key) {
  const hash = crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
  return join(COMPLETE_SESSIONS_DIR, `${hash}.jsonl`);
}

function runPiComplete({ systemPrompt, userMessage, provider, model, sessionKey, timeoutMs = 90_000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--provider", provider,
      "--model", model,
      "--mode", "json",
      "--print",
      "--system-prompt", systemPrompt,
    ];
    if (sessionKey) args.push("--session", sessionPathForKey(sessionKey));
    args.push(userMessage);

    const child = spawn(PI_BIN, args, {
      cwd: WORKSPACE,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NVIDIA_NIM_API_KEY, GEMINI_API_KEY, LOCAL_LLM_BASE_URL, HOME: homedir() },
    });

    let text = "";
    let thinking = "";
    let lastUsage = null;
    let lastModel = model;
    let lastProvider = provider;
    let errText = "";
    const rl = createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const ev = JSON.parse(trimmed);
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const msg = ev.message;
          const parts = Array.isArray(msg.content) ? msg.content : [];
          text = parts.filter((p) => p?.type === "text").map((p) => p.text || "").join("");
          thinking = parts.filter((p) => p?.type === "thinking").map((p) => p.thinking || "").join("");
          if (msg.usage) lastUsage = msg.usage;
          if (msg.model) lastModel = msg.model;
          if (msg.provider) lastProvider = msg.provider;
        }
      } catch { /* non-JSON stdout — ignore */ }
    });
    child.stderr.on("data", (d) => { errText += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`pi --print timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`pi exited with code ${code}${errText ? `: ${errText.slice(0, 400)}` : ""}`));
      }
      resolve({
        text,
        thinking: thinking || undefined,
        model: lastModel,
        provider: lastProvider,
        usage: lastUsage ?? undefined,
      });
    });
  });
}

app.post("/complete", async (req, res) => {
  try {
    const { systemPrompt, userMessage, provider, model, sessionKey, timeoutMs } = req.body || {};
    if (!systemPrompt || !userMessage) {
      return res.status(400).json({ error: "systemPrompt and userMessage required" });
    }
    const effModel = model || DEFAULT_MODEL_ID;
    const effProvider = provider || providerForModelId(effModel);
    const result = await runPiComplete({
      systemPrompt,
      userMessage,
      provider: effProvider,
      model: effModel,
      sessionKey: sessionKey || null,
      timeoutMs: timeoutMs || 90_000,
    });
    res.json(result);
  } catch (err) {
    console.error("[complete]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Characters (persistent identities) ──

app.get("/characters", (_req, res) => {
  const list = listCharacters().map((c) => ({
    ...c,
    runtime: runtimeSnapshot(c.pubkey),
  }));
  res.json({ characters: list });
});

app.post("/characters", (req, res) => {
  try {
    const { name } = req.body || {};
    const c = createCharacter({ name });
    res.json({
      pubkey: c.pubkey,
      npub: npubEncode(c.pubkey),
      name: c.name,
      createdAt: c.createdAt,
    });
  } catch (err) {
    console.error("[char:create]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/characters/:pubkey", (req, res) => {
  const c = loadCharacter(req.params.pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json({
    pubkey: c.pubkey,
    npub: npubEncode(c.pubkey),
    name: c.name,
    about: c.about ?? null,
    state: c.state ?? null,
    avatarUrl: c.avatarUrl ?? null,
    model: c.model ?? null,
    harness: c.harness ?? null,
    promptStyle: c.promptStyle ?? null,
    mood: c.mood ?? null,
    needs: c.needs ?? null,
    profileSource: c.profileSource ?? null,
    profileModel: c.profileModel ?? null,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
    runtime: runtimeSnapshot(c.pubkey),
  });
});

// Turns — reads the session JSONL pi writes per character, clusters
// entries into turn objects (user → assistant → tool results → next
// user). No separate bookkeeping; pi is the source of truth. Used by
// the waterfall inspector.
// Read turns from whichever JSONL the character's harness writes to.
// Pi appends to session.jsonl; DirectHarness to turns.jsonl. External
// has no local history (the driver owns it remotely) — return empty
// for now until we add a server-side mirror for inspector parity.
function readTurnsForCharacter(pubkey, harness, limit) {
  const dir = getCharDir(pubkey);
  if (harness === "direct") {
    return readDirectTurns(join(dir, "turns.jsonl"), { limit });
  }
  if (harness === "external") {
    return synthesizeExternalTurns(pubkey, limit);
  }
  return readSessionTurns(join(dir, "session.jsonl"), { limit });
}

// External harness: the external client owns the LLM history (token
// usage, hidden chain-of-thought, etc.) and the bridge can't see it.
// But the bridge DOES capture every turn_start / action / turn_end on
// `rec.events.buf` from harness onEvent callbacks. Reshape that into
// the turn structure the waterfall expects so the Context tab is
// populated for external agents too — minus token counts and tool
// results, which the bridge legitimately doesn't have.
function synthesizeExternalTurns(pubkey, limit) {
  const r = runtimeForCharacter(pubkey);
  if (!r) return { turns: [], meta: { harness: "external", note: "no runtime; spawn the agent first" } };
  const buf = r.rec.events?.buf ?? [];
  const byId = new Map();
  for (const ev of buf) {
    if (ev?.kind === "turn_start" && ev.data?.turnId) {
      byId.set(ev.data.turnId, {
        turnId: ev.data.turnId,
        startedAt: ev.ts,
        durationMs: null,
        user: { text: ev.data.userTurn ?? "" },
        assistant: { text: "" },
        actions: [],
        usage: null,
        model: r.rec.externalDriver ?? null,
      });
    } else if (ev?.kind === "action" && ev.data) {
      // Actions arrive after turn_start. Find the most-recent open turn.
      const open = [...byId.values()].reverse().find((t) => t.durationMs == null);
      if (!open) continue;
      open.actions.push(ev.data);
      if (ev.data.type === "say" && typeof ev.data.text === "string") {
        open.assistant.text = open.assistant.text
          ? open.assistant.text + "\n" + ev.data.text
          : ev.data.text;
      }
    } else if (ev?.kind === "turn_end" && ev.data?.turnId == null) {
      // turn_end carries `turn` not `turnId`; close the most-recent open turn.
      const open = [...byId.values()].reverse().find((t) => t.durationMs == null);
      if (open) open.durationMs = Math.max(0, ev.ts - open.startedAt);
    }
  }
  const turns = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  return {
    turns,
    meta: {
      harness: "external",
      driver: r.rec.externalDriver ?? null,
      note: "Reconstructed from the bridge's event buffer. Token counts and tool calls live with the external client and aren't visible here.",
    },
  };
}

// ── Follow lists (kind:3) ──
//
// GET returns the current persisted follow list for a character.
// POST mutates it via { add?: [...], remove?: [...], follows?: [...] }
// (replace mode if `follows` is present; otherwise additive). Each
// successful mutation persists on the manifest AND publishes a fresh
// kind:3 to the relay so external clients (Jumble, the woid network
// view) reflect the change.

app.get("/characters/:pubkey/follows", (req, res) => {
  const c = loadCharacter(req.params.pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json({ pubkey: c.pubkey, follows: Array.isArray(c.follows) ? c.follows : [] });
});

app.post("/characters/:pubkey/follows", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  const isHex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  const current = Array.isArray(c.follows) ? c.follows : [];
  const { add, remove, follows: replaceWith } = req.body || {};

  let next;
  if (Array.isArray(replaceWith)) {
    next = replaceWith.filter(isHex);
  } else {
    const set = new Set(current);
    if (Array.isArray(add)) for (const p of add) if (isHex(p) && p !== pubkey) set.add(p);
    if (Array.isArray(remove)) for (const p of remove) set.delete(p);
    next = [...set];
  }
  // Self-follow is meaningless; prune.
  next = next.filter((p) => p !== pubkey);

  saveCharacterManifest(pubkey, { follows: next });
  let relayPublished = false;
  let relayError = null;
  try { relayPublished = !!(await publishCharacterFollows(pubkey)); }
  catch (err) { relayError = err.message ?? String(err); }
  res.json({ pubkey, follows: next, relayPublished, relayError });
});

// One-shot bulk seeder. For every character, set `follows` to every
// other character's pubkey + admin, then republish kind:3. Useful when
// onboarding existing characters that pre-date the follows feature, or
// when the network view looks too sparse. Idempotent.
app.post("/admin/seed-follows-all", async (_req, res) => {
  const chars = listCharacters();
  const allPubs = chars.map((c) => c.pubkey);
  let updated = 0;
  let failed = 0;
  for (const c of chars) {
    const next = [admin.pubkey, ...allPubs].filter((p) => p && p !== c.pubkey);
    saveCharacterManifest(c.pubkey, { follows: next });
    try {
      await publishCharacterFollows(c.pubkey);
      updated += 1;
    } catch (err) {
      console.warn(`[admin:seed-follows] ${c.name} failed:`, err?.message || err);
      failed += 1;
    }
  }
  res.json({ count: chars.length, updated, failed });
});

// Surface the system prompt the bridge would pass to the harness for
// this character. Built fresh on each call so it reflects the current
// about/state and the chosen harness's variant. Used by the drawer's
// System tab so users can see exactly what the agent is being told.
app.get("/characters/:pubkey/system-prompt", (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  // Try to use the live runtime's room dimensions if the character is
  // spawned; otherwise fall back to the SandboxRoom defaults from the
  // schema (16×12). Either way, the prompt shape matches what
  // ensureHarness would feed the brain on the next turn.
  const active = activeRuntimeForCharacter(pubkey);
  const snap = active ? roomSnapshot(active.id) : { width: 16, height: 12 };
  const harness = c.harness || DEFAULT_HARNESS;
  const promptStyle = c.promptStyle || "minimal";
  const systemPrompt = buildSystemPrompt({
    name: c.name,
    npub: pubkey,
    about: c.about,
    state: c.state,
    roomWidth: snap.width,
    roomHeight: snap.height,
    harness,
    promptStyle,
  });
  res.json({
    pubkey,
    harness,
    promptStyle,
    systemPrompt,
    roomWidth: snap.width,
    roomHeight: snap.height,
    note: harness === "pi"
      ? "Pi consumes this prompt verbatim and uses its built-in bash tool to invoke the skill scripts referenced above."
      : harness === "external"
        ? "ExternalHarness streams this prompt to your remote driver verbatim. Your client is free to add output schemas or tool definitions on top before calling its own LLM."
        : promptStyle === "dynamic"
          ? "DirectHarness sends this prompt to the SDK as the system instruction. Compared to 'minimal', the dynamic style adds anti-silence guidance, a one-action-per-turn rule, and a numeric mood lever (energy + social, 0-100)."
          : "DirectHarness sends this prompt to the SDK as the system instruction. Switch to 'dynamic' in the Profile drawer for the call-my-ghost-style enhancements (anti-silence, one-action emphasis, numeric mood).",
  });
});

app.get("/characters/:pubkey/turns", (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const result = readTurnsForCharacter(pubkey, c.harness || DEFAULT_HARNESS, limit);
  res.json(result);
});

app.get("/characters/:pubkey/turns/:turnId", (req, res) => {
  const { pubkey, turnId } = req.params;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  const { turns, meta } = readTurnsForCharacter(pubkey, c.harness || DEFAULT_HARNESS, 100);
  const turn = turns.find((t) => t.turnId === turnId);
  if (!turn) return res.status(404).json({ error: "turn not found" });
  res.json({ turn, meta });
});

app.get("/characters/:pubkey/avatar", async (req, res) => {
  const pubkey = req.params.pubkey;

  // Prefer S3 when configured — objects uploaded by generateAvatar()
  // are the canonical source of truth in prod. Fall back to the local
  // workspace volume so local dev (no S3 vars) keeps working and so
  // legacy characters whose bytes live only on disk still serve.
  if (s3.s3Configured) {
    try {
      const found = await s3.headAvatar(pubkey);
      if (found) {
        const { body, contentType } = await s3.getAvatarStream(pubkey, found.ext);
        res.setHeader("Content-Type", contentType || found.contentType || "image/jpeg");
        // Long immutable cache — URL includes a ?t= cache-buster so
        // clients fetch a fresh one when avatars change.
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return body.pipe(res);
      }
    } catch (err) {
      console.error(`[avatar:s3] ${pubkey.slice(0, 12)} — ${err.message}; falling back to disk`);
    }
  }

  const dir = getCharDir(pubkey);
  for (const ext of ["jpeg", "jpg", "png", "webp", "gif"]) {
    const path = join(dir, `avatar.${ext}`);
    if (existsSync(path)) {
      const mime =
        ext === "jpg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "png" ? "image/png"
        : ext === "gif" ? "image/gif"
        : "image/jpeg";
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return createReadStream(path).pipe(res);
    }
  }
  res.status(404).json({ error: "no avatar" });
});

app.post("/characters/:pubkey/generate-avatar", apiQuota.middleware, async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    return res.status(404).json({ error: "not found" });
  }
  const id = personaLog.newId();
  const ip = apiQuota.clientIp(req);
  const startedAt = Date.now();
  try {
    const { promptOverride } = req.body || {};
    const { avatarUrl, prompt } = await generateAvatar({
      pubkey,
      name: c.name,
      about: c.about,
      promptOverride,
    });
    saveCharacterManifest(pubkey, { avatarUrl });
    publishCharacterProfile(pubkey).catch(() => {});
    apiQuota.recordSuccess();
    personaLog.append({
      id, ip, ok: true, kind: "sandbox-avatar",
      pubkey, npub: npubEncode(pubkey), jumbleUrl: jumbleProfileUrl(pubkey),
      name: c.name,
      durationMs: Date.now() - startedAt,
      imageUrl: avatarUrl,
      imagePrompt: prompt,
    });
    res.json({ avatarUrl, prompt });
  } catch (err) {
    apiQuota.refund();
    personaLog.append({
      id, ip, ok: false, kind: "sandbox-avatar",
      pubkey,
      durationMs: Date.now() - startedAt,
      error: err.message ?? String(err),
    });
    console.error("[char:avatar]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// SSE streaming variant of persona generation. Emits events:
//   event: model   data: {model}
//   event: delta   data: {content}
//   event: done    data: {name, about, _generator: {model}}
//   event: error   data: {error}
app.post("/characters/:pubkey/generate-profile/stream", apiQuota.middleware, async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    return res.status(404).json({ error: "not found" });
  }
  const logId = personaLog.newId();
  const logIp = apiQuota.clientIp(req);
  const logStartedAt = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  try {
    const { seed, overwriteName, model: pinnedModel } = req.body || {};
    const model = (pinnedModel && PERSONA_MODELS.includes(pinnedModel))
      ? pinnedModel
      : PERSONA_MODELS[Math.floor(Math.random() * PERSONA_MODELS.length)];
    send("model", { model });

    const userPrompt = seed?.trim()
      ? `Seed from the user: ${seed.trim()}\n\nInvent a persona that fits. Return JSON only.`
      : "Invent a fresh, surprising persona. Return JSON only.";

    const nimRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_NIM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: PERSONA_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        temperature: 1.0,
        top_p: 0.95,
        max_tokens: 600,
        stream: true,
      }),
    });
    if (!nimRes.ok) {
      const body = await nimRes.text().catch(() => "");
      throw new Error(`NIM ${model} ${nimRes.status}: ${body.slice(0, 200)}`);
    }

    const reader = nimRes.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            raw += delta;
            send("delta", { content: delta });
          }
        } catch {}
      }
    }

    // Parse + persist persona.
    const persona = parsePersonaJson(raw);
    const patch = {
      about: persona.about ?? c.about ?? null,
      profileSource: "ai",
      profileModel: model,
    };
    if (overwriteName && persona.name) patch.name = persona.name;
    saveCharacterManifest(pubkey, patch);
    publishCharacterProfile(pubkey).catch(() => {});
    let after = loadCharacter(pubkey);
    send("persona-done", {
      name: after.name,
      about: after.about ?? null,
      profileModel: after.profileModel ?? null,
    });

    // Chain avatar generation so the portrait appears in the same flow.
    // Skipping silently on NIM image failure — persona is still saved.
    try {
      send("avatar-start", {});
      const { avatarUrl } = await generateAvatar({
        pubkey,
        name: after.name,
        about: after.about,
      });
      saveCharacterManifest(pubkey, { avatarUrl });
      publishCharacterProfile(pubkey).catch(() => {});
      after = loadCharacter(pubkey);
      send("avatar-done", { avatarUrl });
    } catch (err) {
      console.warn("[char:generate-stream] avatar skipped:", err.message);
      send("avatar-error", { error: err.message });
    }

    send("done", {
      pubkey: after.pubkey,
      npub: npubEncode(after.pubkey),
      name: after.name,
      about: after.about ?? null,
      avatarUrl: after.avatarUrl ?? null,
      profileSource: after.profileSource ?? null,
      profileModel: after.profileModel ?? null,
      _generator: { model },
    });
    apiQuota.recordSuccess();
    personaLog.append({
      id: logId, ip: logIp, ok: true, kind: "sandbox-bundle",
      pubkey, npub: npubEncode(pubkey), jumbleUrl: jumbleProfileUrl(pubkey),
      seedHash: personaLog.hashSeed(req.body?.seed),
      model,
      durationMs: Date.now() - logStartedAt,
      name: after.name,
      about: after.about ?? null,
      imageUrl: after.avatarUrl ?? null,
    });
  } catch (err) {
    apiQuota.refund();
    personaLog.append({
      id: logId, ip: logIp, ok: false, kind: "sandbox-bundle",
      pubkey,
      durationMs: Date.now() - logStartedAt,
      error: err.message ?? String(err),
    });
    console.error("[char:generate-stream]", err.message);
    send("error", { error: err.message });
  } finally {
    res.end();
  }
});

app.post("/characters/:pubkey/generate-profile", apiQuota.middleware, async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    return res.status(404).json({ error: "not found" });
  }
  const logId = personaLog.newId();
  const logIp = apiQuota.clientIp(req);
  const logStartedAt = Date.now();
  try {
    const { seed, overwriteName } = req.body || {};
    const persona = await generatePersona({ seed });
    const patch = {
      about: persona.about ?? c.about ?? null,
      profileSource: "ai",
      profileModel: persona._model,
    };
    // Only overwrite the name when explicitly asked — avoids surprising renames.
    if (overwriteName && persona.name) patch.name = persona.name;
    saveCharacterManifest(pubkey, patch);
    const next = loadCharacter(pubkey);
    apiQuota.recordSuccess();
    personaLog.append({
      id: logId, ip: logIp, ok: true, kind: "sandbox-text",
      pubkey, npub: npubEncode(pubkey), jumbleUrl: jumbleProfileUrl(pubkey),
      seedHash: personaLog.hashSeed(seed),
      model: persona._model ?? null,
      durationMs: Date.now() - logStartedAt,
      name: next.name,
      about: next.about ?? null,
    });
    res.json({
      pubkey: next.pubkey,
      npub: npubEncode(next.pubkey),
      name: next.name,
      about: next.about ?? null,
      avatarUrl: next.avatarUrl ?? null,
      model: next.model ?? null,
      profileSource: next.profileSource ?? null,
      profileModel: next.profileModel ?? null,
      _generator: { model: persona._model },
    });
  } catch (err) {
    apiQuota.refund();
    personaLog.append({
      id: logId, ip: logIp, ok: false, kind: "sandbox-text",
      pubkey,
      durationMs: Date.now() - logStartedAt,
      error: err.message ?? String(err),
    });
    console.error("[char:generate]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.patch("/characters/:pubkey", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  const { name, about, state, avatarUrl, model, harness, promptStyle, mood, needs } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = String(name).trim() || c.name;
  if (about !== undefined) patch.about = about ? String(about) : null;
  if (state !== undefined) patch.state = state ? String(state).slice(0, 2000) : null;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl ? String(avatarUrl) : null;
  if (model !== undefined) {
    const validIds = new Set(availableModels().map((m) => m.id));
    if (model && !validIds.has(model)) return res.status(400).json({ error: "unknown model" });
    patch.model = model || null;
  }
  if (harness !== undefined) {
    if (harness && !KNOWN_HARNESSES.includes(harness)) {
      return res.status(400).json({ error: `unknown harness "${harness}"` });
    }
    patch.harness = harness || null;
  }
  if (promptStyle !== undefined) {
    const allowed = ["minimal", "dynamic"];
    if (promptStyle && !allowed.includes(promptStyle)) {
      return res.status(400).json({ error: `unknown promptStyle "${promptStyle}" (allowed: ${allowed.join(", ")})` });
    }
    patch.promptStyle = promptStyle || null;
  }
  if (mood !== undefined) {
    if (mood === null) {
      patch.mood = null;
    } else if (typeof mood === "object") {
      const next = {};
      if (Number.isFinite(Number(mood.energy))) next.energy = Math.max(0, Math.min(100, Math.round(Number(mood.energy))));
      if (Number.isFinite(Number(mood.social))) next.social = Math.max(0, Math.min(100, Math.round(Number(mood.social))));
      patch.mood = { ...(c.mood || {}), ...next };
    }
  }
  // Needs patch (#235 slice 1) — partial axes update. Mirrors into
  // the live needsTracker so changes take effect for any running
  // agent without waiting for the next spawn.
  if (needs !== undefined && typeof needs === "object" && needs !== null) {
    const nextNeeds = { ...(c.needs || {}) };
    for (const axis of NEED_AXES) {
      const v = needs[axis];
      if (typeof v === "number" && Number.isFinite(v)) {
        nextNeeds[axis] = Math.max(0, Math.min(100, Math.round(v)));
      }
    }
    patch.needs = nextNeeds;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  saveCharacterManifest(pubkey, patch);
  // Mirror needs edits into the live tracker so the change takes
  // effect immediately for any running agent.
  if (patch.needs) {
    needsTracker.register(pubkey, { needs: patch.needs });
  }
  // Re-publish kind:0 so external clients (Jumble etc) see the new name/about/picture.
  // Awaited so the caller can see whether the relay actually received it.
  let relayPublished = false;
  let relayError = null;
  try {
    const ev = await publishCharacterProfile(pubkey);
    relayPublished = !!ev;
  } catch (err) {
    relayError = err.message || String(err);
  }
  const next = loadCharacter(pubkey);
  res.json({
    pubkey: next.pubkey,
    npub: npubEncode(next.pubkey),
    name: next.name,
    about: next.about ?? null,
    state: next.state ?? null,
    avatarUrl: next.avatarUrl ?? null,
    model: next.model ?? null,
    harness: next.harness ?? null,
    promptStyle: next.promptStyle ?? null,
    mood: next.mood ?? null,
    needs: next.needs ?? null,
    profileSource: next.profileSource ?? null,
    profileModel: next.profileModel ?? null,
    createdAt: next.createdAt ?? null,
    updatedAt: next.updatedAt ?? null,
    relayPublished,
    relayError,
  });
});

app.delete("/characters/:pubkey", async (req, res) => {
  const pubkey = req.params.pubkey;
  if (!loadCharacter(pubkey)) return res.status(404).json({ error: "not found" });
  // Stop any running runtime first; exited records get purged with the dir.
  const runtime = activeRuntimeForCharacter(pubkey);
  if (runtime) await stopAgent(runtime.id);
  deleteCharacter(pubkey);
  res.json({ ok: true });
});

app.get("/agents", (_req, res) => {
  const list = Array.from(agents.entries()).map(([id, rec]) => ({
    agentId: id,
    name: rec.name,
    npub: rec.pubkey,
    roomName: rec.roomName,
    model: rec.model,
    harness: rec.harness,
    externalDriver: rec.externalDriver ?? null,
    promptStyle: rec.promptStyle,
    running: !!rec.listening,
    exitedAt: rec.exitedAt ?? null,
    exitCode: rec.exitCode ?? null,
  }));
  res.json({ agents: list });
});

app.get("/models", (_req, res) => {
  res.json({
    default: DEFAULT_MODEL_ID,
    defaultProvider: PI_DEFAULT_PROVIDER,
    models: availableModels(),
  });
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

// Persist the agent's evolving state blob. The state field is distinct
// from `about` (locked persona) — it's the short "where my head is right
// now" string the agent writes to itself between turns. buildSystemPrompt
// surfaces it to the LLM; state/update.sh is how the agent writes to it.
app.post("/internal/state", (req, res) => {
  try {
    const { pubkey, state } = req.body || {};
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    if (typeof state !== "string") return res.status(400).json({ error: "state must be a string" });
    const c = loadCharacter(pubkey);
    if (!c) return res.status(404).json({ error: "unknown character" });
    saveCharacterManifest(pubkey, { state: state.slice(0, 2000) });
    res.json({ ok: true });
  } catch (err) {
    console.error("[internal:state]", err);
    res.status(500).json({ error: err.message });
  }
});

// Internal mirror of /agents/:id/move for a running pi process — pi's
// room.sh doesn't know its own agentId, only its pubkey.
app.post("/internal/move", (req, res) => {
  try {
    const { pubkey, x, y } = req.body || {};
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    const rt = activeRuntimeForCharacter(pubkey);
    if (!rt) return res.status(404).json({ error: "no running runtime" });
    const ok = moveAgent(rt.id, x, y);
    if (!ok) return res.status(500).json({ error: "move failed" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[internal:move]", err);
    res.status(500).json({ error: err.message });
  }
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
  // Rewrite any character avatar URLs whose origin doesn't match the
  // current PUBLIC_BRIDGE_URL. No-op when nothing's stale.
  rebaseStaleAvatarUrls().catch((err) => {
    console.error("[rebase] failed:", err?.message || err);
  });
});

process.on("SIGTERM", async () => {
  for (const id of agents.keys()) await stopAgent(id);
  process.exit(0);
});
