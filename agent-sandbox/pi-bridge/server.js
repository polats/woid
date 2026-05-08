import express from "express";
import cors from "cors";
import sharp from "sharp";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, appendFileSync, cpSync, rmSync, renameSync, createReadStream, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import crypto from "crypto";
import * as s3 from "./s3.js";
import * as piPool from "./pi-pool.js";
import * as rateLimiter from "./rate-limiter.js";
import * as apiQuota from "./api-quota.js";
import * as personaLog from "./persona-log.js";
import * as services from "./service-state.js";
import { SERVICES as SERVICE_REGISTRY } from "./service-registry.js";
import { createHarness, KNOWN_HARNESSES, DEFAULT_HARNESS } from "./harnesses/index.js";
import { createGM } from "./gm.js";
import { createPerception, formatPerceptionEvents } from "./perception.js";
import { createScheduler } from "./scheduler.js";
import { createSceneTracker } from "./scene-tracker.js";
import { createJournal } from "./journal.js";
import { buildMemoryBlock } from "./memory.js";
import { createNeedsTracker, describeNeeds, NEED_AXES } from "./needs.js";
import { createMoodletsTracker, describeMood, seedDemoMoodlets } from "./moodlets.js";
import { createRoomsRegistry, defaultObjectPlacements } from "./rooms.js";
import { createScheduler as createScheduleRegistry, slotForHour, SLOTS as SCHEDULE_SLOTS } from "./schedule.js";
import { summarizeSceneToMoodlets, buildSceneSummaryPrompt } from "./scene-summary.js";
import { generateJson as openaiCompatGenerateJson } from "./providers/openai-compat.js";
import { createSimClock } from "./storyteller/sim-clock.js";
import { createSessionStore } from "./storyteller/sessions.js";
import { createCardLoader } from "./storyteller/cards.js";
import { createCardRuntime } from "./storyteller/actions.js";
import { createDirector } from "./storyteller/director.js";
import { buildStorytellerSnapshot, phaseForSimSlot } from "./storyteller/snapshot.js";
import { createRelationships } from "./relationships.js";
import { createObjectsRegistry, seedDefaults as seedDefaultObjects } from "./objects-registry.js";
import { OBJECT_TYPES } from "./objects.js";
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
import { seedNpcs } from "./scripts/seed-npcs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3457");
const PI_BIN = process.env.PI_BIN || "pi";
const WORKSPACE = process.env.WORKSPACE || join(tmpdir(), "woid-agent-sandbox");
const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7777";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const FLUX_KONTEXT_URL = process.env.FLUX_KONTEXT_URL || "";
const TRELLIS_URL = process.env.TRELLIS_URL || "";
const HUNYUAN3D_URL = process.env.HUNYUAN3D_URL || "";
// UniRig is the local auto-rigging container. service-registry's
// fallback is the same hostname; mirror it here so the call site
// can refuse cleanly if neither env nor host.docker.internal is
// reachable.
const UNIRIG_URL = process.env.UNIRIG_URL || "http://host.docker.internal:8081";
// kimodo-tools — sibling compose service (Phase 3). Resolves via
// service-name DNS inside the docker network. Override in env when
// the worker lives elsewhere (separate host, different port).
const KIMODO_TOOLS_URL = process.env.KIMODO_TOOLS_URL || "http://kimodo-tools:8082";
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
      return r.ok || r.status === 429;
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

// Prompts directory — editable system-prompt overrides for persona
// generation, etc. The frontend lets a user tweak the prompt for
// NPC personas at runtime; saved overrides land here as plain text
// files. Each load checks for an override and falls back to the
// in-source default if nothing is on disk.
const PROMPTS_DIR = join(WORKSPACE, "prompts");
mkdirSync(PROMPTS_DIR, { recursive: true });

const PROMPT_REGISTRY = new Map(); // promptName → defaultText

function registerPrompt(name, defaultText) {
  PROMPT_REGISTRY.set(name, defaultText);
}
function loadPrompt(name) {
  const def = PROMPT_REGISTRY.get(name);
  if (def === undefined) return null;
  const path = join(PROMPTS_DIR, `${name}.txt`);
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf-8");
      if (text.trim()) return text;
    } catch {}
  }
  return def;
}
function savePromptOverride(name, text) {
  if (!PROMPT_REGISTRY.has(name)) return false;
  const path = join(PROMPTS_DIR, `${name}.txt`);
  writeFileSync(path, String(text ?? ""), "utf-8");
  return true;
}
function clearPromptOverride(name) {
  if (!PROMPT_REGISTRY.has(name)) return false;
  const path = join(PROMPTS_DIR, `${name}.txt`);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
  return true;
}
function isPromptOverridden(name) {
  if (!PROMPT_REGISTRY.has(name)) return false;
  return existsSync(join(PROMPTS_DIR, `${name}.txt`));
}

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
  // Cheap up-front guard: getCharDir → npubEncode crashes on anything
  // that's not a 64-char hex string. Synthetic pubkeys (e.g. session
  // event seeders, future test fixtures) should silently return null
  // rather than throw through the whole recap / scene-summary stack.
  if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(pubkey)) return null;
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
        // Default legacy records (no `kind` field) to 'player' so consumers
        // can rely on the field always being present.
        kind: c.kind ?? "player",
        // Tutorial-starter flag — surfaces a "STARTER" pill on the
        // sandbox card and feeds the wake-up tutorial's recruit
        // carousel. Defaults to false for legacy records.
        starter: !!c.starter,
        npc_role: c.npc_role ?? null,
        npc_default_pos: c.npc_default_pos ?? null,
        shift_start: c.shift_start ?? null,
        shift_end: c.shift_end ?? null,
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

// Validation helpers for NPC fields. Kept local to character creation
// since these are unique to the bridge → Shelter pipeline.
function validateNpcRole(role) {
  if (role === null || role === undefined) return null;
  const trimmed = String(role).trim();
  if (!trimmed) return null;
  if (trimmed.length > 64) throw new Error("npc_role too long (max 64 chars)");
  return trimmed;
}
function validateNpcDefaultPos(pos) {
  if (pos === null || pos === undefined) return null;
  if (typeof pos !== "object") throw new Error("npc_default_pos must be an object");
  const roomId = pos.roomId;
  const localU = Number(pos.localU);
  const localV = Number(pos.localV);
  if (typeof roomId !== "string" || !roomId) throw new Error("npc_default_pos.roomId required");
  if (!Number.isFinite(localU) || localU < 0 || localU > 1) throw new Error("npc_default_pos.localU must be 0..1");
  if (!Number.isFinite(localV) || localV < 0 || localV > 1) throw new Error("npc_default_pos.localV must be 0..1");
  return { roomId, localU, localV };
}
function validateShiftMinute(n) {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error("shift minute must be a number");
  const i = Math.round(v);
  if (i < 0 || i >= 1440) throw new Error("shift minute must be 0..1439");
  return i;
}
// Find an existing NPC by role. Single-character lookup; tolerates
// the "no such role" case by returning null. Used both for uniqueness
// validation on create/patch and for runtime lookups by role.
function findNpcByRole(role, { excludePubkey = null } = {}) {
  if (!role) return null;
  for (const c of listCharacters()) {
    if (c.pubkey === excludePubkey) continue;
    if (c.kind === "npc" && c.npc_role === role) return c;
  }
  return null;
}

function createCharacter({
  name,
  kind = "player",
  npc_role = null,
  npc_default_pos = null,
  shift_start = null,
  shift_end = null,
} = {}) {
  // Schema validation up front — any errors abort creation before we
  // write a half-formed character to disk.
  if (kind !== "player" && kind !== "npc") {
    throw new Error(`kind must be 'player' or 'npc', got '${kind}'`);
  }
  const validatedRole = validateNpcRole(npc_role);
  const validatedPos = validateNpcDefaultPos(npc_default_pos);
  const validatedShiftStart = validateShiftMinute(shift_start);
  const validatedShiftEnd = validateShiftMinute(shift_end);
  // NPC role uniqueness: only one Receptionist, one Floor Manager, etc.
  if (kind === "npc" && validatedRole) {
    const existing = findNpcByRole(validatedRole);
    if (existing) {
      const err = new Error(`npc_role '${validatedRole}' already in use by ${existing.pubkey.slice(0, 12)}...`);
      err.statusCode = 409;
      throw err;
    }
  }

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
    // Needs scaffold (#275 — narrowed from #235's 3-axis to 2-axis).
    // Two axes seeded at 75 so characters spawn comfortable and
    // decay over the next sim-hours. Mood / friction is the moodlet
    // system's job; character voice lives in `about`.
    needs: { energy: 75, social: 75 },
    // NPC vs player. Immutable after creation — patch endpoints
    // accept changes to npc_role / npc_default_pos / shift_*, but
    // not to kind itself.
    kind,
    npc_role: validatedRole,
    npc_default_pos: validatedPos,
    shift_start: validatedShiftStart,
    shift_end: validatedShiftEnd,
    follows: seedFollows,
    createdAt: Date.now(),
  });
  console.log(`[char] created ${pubkey.slice(0, 12)}... name="${manifest.name}" follows=${seedFollows.length}`);
  // Apartment ownership (#285 phase A) — first three characters claim
  // 1A/1B/1C in declaration order; later characters get null and can
  // be assigned manually via PATCH /rooms/:id/owner if needed.
  try {
    const owned = roomsRegistry?.assignOwnership(pubkey);
    if (owned) {
      console.log(`[char] ${manifest.name} → owns ${owned.room_id}`);
    }
  } catch { /* rooms registry may not be initialised yet during boot */ }
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

// NPC persona prompt — distinct from the player-character persona above.
// NPCs in Shelter (the Severance-flavoured base-builder) are role-bound
// figures inside a corporate facility: receptionists, floor managers,
// wellness counsellors, archive clerks. The persona orbits the *job*;
// the character's life outside the facility is deliberately absent
// (innie-side only). Voice should read like a clinical onboarding-
// handbook entry — slightly off, mid-century corporate, never quite
// explaining what the work is.
const PERSONA_SYSTEM_NPC = [
  "You generate short character profiles for NPCs in a Severance-flavoured",
  "corporate-mystery game. Each NPC is bound to a role inside a closed",
  "facility — a Receptionist, a Floor Manager, a Wellness Counsellor, an",
  "Archive Clerk, etc. The user supplies the role; you build a persona that",
  "orbits the work.",
  "",
  "Voice goals:",
  "- Mid-century corporate / clinical / Lumon-adjacent — controlled, polite,",
  "  slightly off. Compliance-document register.",
  "- Role-bound. The 'about' describes who they are AT WORK: their post,",
  "  their procedural quirks, the talismans on their desk, the small rituals",
  "  that define the day.",
  "- The character's life outside the facility is intentionally absent.",
  "  No mention of partners, hobbies, weekends, hometowns. The reader should",
  "  feel they don't know what this person does after their shift, and that",
  "  the character may not entirely know either.",
  "- Specific, not abstract. A particular drawer, a recurring memo number,",
  "  a phrase they end every interaction with. Avoid 'mystery', 'shadowy',",
  "  'corporate' as adjectives — the tone IS corporate; don't say it.",
  "",
  "These become NIP-01 kind:0 Nostr profiles — only name + about.",
  "",
  "Respond ONLY with valid JSON. Both fields are REQUIRED.",
  "No markdown, no code fences, no trailing text.",
  "{",
  '  "name": "A formal full name appropriate for a corporate name-plate. First + last; occasionally a single distinctive surname. 2-40 characters. Mix of cultures welcome. No emoji, no nicknames.",',
  '  "about": "REQUIRED. 2-4 sentences. Describe the NPC at their post: what they handle, one verbal tic or procedural quirk, a small specific thing on their desk or in their pocket, a line they might say to anyone passing through. Tone is calm, polished, slightly impersonal."',
  "}",
  "",
  "Examples of the register (do not copy, just sense the tone):",
  "- 'Edi Schmid manages the Lobby. She processes arrivals with a single",
  "   ledger pen and refers to every visitor as Guest, regardless of",
  "   familiarity. A small ceramic dish of unwrapped peppermints sits at",
  "   the corner of her desk; the mints rotate quarterly. To employees",
  "   crossing the threshold she is in the habit of saying, simply,",
  "   Welcome back.'",
  "",
  "Surprise the reader with the role's *specific texture*, not with",
  "personality archetypes. Two receptionists should feel different because",
  "their desks are different, not because one is bubbly and one is grumpy.",
].join("\n");

// The NPC prompt is registered as overridable so the frontend can
// tweak it from the NPCs view without a server restart. Generation
// paths call `loadPrompt('npc-persona')` to get the current effective
// text — saved override if any, default otherwise.
registerPrompt("npc-persona", PERSONA_SYSTEM_NPC);

// Player persona prompt — Severance-flavoured world tone, but the
// profiles describe WHO THE PERSON IS, not what they do for a living.
// Personality, temperament, small private habits — no job titles,
// departments, ledgers, or workplace technicalities. Registered as
// overridable below so the agent-sandbox UI can edit it without a
// server restart.
const PERSONA_SYSTEM = [
  "You generate short character profiles for the recruits of a Severance-flavoured",
  "corporate-mystery game. The world's register is calm, polite, slightly off —",
  "but the profiles you write are about WHO THE PERSON IS, not what they do.",
  "Focus on temperament and inner life. Do not mention jobs, titles, departments,",
  "ledgers, procedures, or any technical or workplace jargon.",
  "",
  "These become NIP-01 kind:0 Nostr profiles — only name + about.",
  "",
  "Voice goals:",
  "- Personality-first. Write about how the person moves through a room, what",
  "  they notice, what they care too much about, how they speak when they're",
  "  alone, the small habits a friend would tease them for.",
  "- Plain language. No technical or corporate vocabulary — no 'department',",
  "  'protocol', 'intake', 'compliance', 'directive', 'clearance', 'shift',",
  "  'procedure', or similar. Describe the person, not the institution.",
  "- Specific over abstract. Concrete details (the way they hold a teacup,",
  "  the songs they hum when nervous, the friend they always quote, the colour",
  "  of the scarf folded in a coat pocket) instead of general adjectives like",
  "  'mysterious', 'kind', 'introverted'.",
  "- Calm, polished tone — quiet observation rather than dramatic flourish.",
  "  The reader should feel like they've watched this person for an afternoon,",
  "  not been handed a personnel file.",
  "",
  "Respond ONLY with valid JSON. Both fields are REQUIRED.",
  "No markdown, no code fences, no trailing text.",
  "{",
  '  "name": "A formal full name. First + last; occasionally a single distinctive surname. 2-40 characters. Mix of cultures welcome. No emoji, no nicknames, no digit-suffixes.",',
  '  "about": "REQUIRED. 2-4 sentences. Describe the person\'s temperament and texture: how they speak, what they pay attention to, a private habit, an opinion they hold gently but firmly. No job descriptions, no workplace terminology."',
  "}",
  "",
  "Examples of register (do not copy, sense the tone):",
  "- 'Tomas Akin listens longer than most people do, which leaves him with",
  "   the unsettling reputation of always remembering what you said. He",
  "   carries a thin notebook he never opens in public, and is given to",
  "   short, careful smiles. Asked anything direct, he tilts his head a",
  "   degree before answering, as if the question deserved courtesy.'",
  "",
  "Surprise the reader with each character's particular texture, not with",
  "personality archetypes. Two thoughtful people should feel different because",
  "of what they think about, not because one is bubbly and one is grumpy.",
].join("\n");

// Registered as overridable so the agent-sandbox UI can edit the player
// persona prompt without a server restart, matching how the NPCs view
// edits 'npc-persona'. Generation paths below call
// `loadPrompt('player-persona')` to get the current effective text.
registerPrompt("player-persona", PERSONA_SYSTEM);

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

async function generatePersona({ seed, kind = "player", role = null } = {}) {
  // NPC personas use the role-bound, clinical Severance-flavour prompt.
  // Player personas use the existing teen-mystery prompt unchanged.
  const isNpc = kind === "npc";
  // NPC prompt is overridable via the prompt registry; player prompt
  // is fixed in source for now.
  const systemPrompt = isNpc ? loadPrompt("npc-persona") : loadPrompt("player-persona");
  let userPrompt;
  if (isNpc) {
    const roleLine = role ? `Role: ${role}.` : "";
    const seedLine = seed?.trim() ? `User seed: ${seed.trim()}.` : "";
    userPrompt = [roleLine, seedLine, "Invent the NPC's profile. Return JSON only."]
      .filter(Boolean).join("\n\n");
  } else {
    userPrompt = seed?.trim()
      ? `Seed from the user: ${seed.trim()}\n\nInvent a persona that fits. Return JSON only.`
      : "Invent a fresh, surprising persona. Return JSON only.";
  }

  const tried = new Set();
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const candidates = PERSONA_MODELS.filter((m) => !tried.has(m));
    if (candidates.length === 0) break;
    const model = candidates[Math.floor(Math.random() * candidates.length)];
    tried.add(model);
    try {
      const raw = await nimChatJson({ model, systemPrompt, userPrompt });
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

// Generate FLUX bytes for an arbitrary prompt without persisting
// anywhere. Used by avatar generation (with portrait framing applied
// upstream) and post-image generation (raw-prompt pass-through).
async function generateImageBytes({ prompt }) {
  if (!NVIDIA_NIM_API_KEY) throw new Error("NVIDIA_NIM_API_KEY not configured");
  if (!prompt || !prompt.trim()) throw new Error("generateImageBytes: prompt required");
  // Retry under the MIN_AVATAR_BYTES threshold — that's the signature of a
  // safety-blocked / black-frame response from FLUX.
  let b64;
  let bytes = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    b64 = await fluxOnce(prompt);
    bytes = Math.floor((b64.length * 3) / 4);
    if (bytes >= MIN_AVATAR_BYTES) break;
    console.warn(`[image] attempt ${attempt + 1}: ${bytes}B — likely blank/safety-blocked, retrying`);
  }
  if (bytes < MIN_AVATAR_BYTES) {
    throw new Error(`image kept coming back tiny (${bytes}B) — safety-blocked prompt?`);
  }
  const mime = sniffMime(b64);
  const ext = mime.split("/")[1] || "jpg";
  const buffer = Buffer.from(b64, "base64");
  return { buffer, mime, ext };
}

// Avatar prompt is portrait-framed; everything else is raw-prompt.
async function generateAvatarBytes({ name, about, promptOverride, seed }) {
  const override = (promptOverride ?? "").trim().slice(0, 1800);
  const bio = (about ?? "").trim().slice(0, 600);
  const userSeed = (seed ?? "").trim().slice(0, 400);
  let prompt;
  if (override) {
    prompt = override;
  } else {
    const subject = bio ? `${name} — ${bio}` : name;
    // `seed` is a soft nudge — appended to the default prompt as a
    // user-direction line. `promptOverride` (mutually exclusive)
    // still replaces the whole prompt for callers that want full
    // control. NPC avatar regen uses `seed`.
    prompt = [
      `Stylized portrait illustration of: ${subject}.`,
      userSeed ? `User direction: ${userSeed}.` : null,
      "Use the description as thematic inspiration for mood, role, and atmosphere rather than copying specific nouns into the image.",
      "Composition: square 1:1, centered, strong silhouette, clear subject, clean negative space around the figure.",
      "No text, no watermark, no signatures, no UI chrome, no logos.",
    ].filter(Boolean).join(" ");
  }
  const { buffer, mime, ext } = await generateImageBytes({ prompt });
  return { buffer, mime, ext, prompt };
}

// Post-image generation — raw prompt with a small style nudge so
// generated photos read as photographs rather than illustrations.
async function generatePostImage({ pubkey, prompt }) {
  // Frame as photography. Mundane > spectacular per the audience
  // tuning in docs/design/follow-ups.md §2. The user's prompt comes
  // through verbatim; we add the style afterthought and a no-text rule.
  const framed = [
    prompt.trim(),
    "Photographic style — natural light, narrow depth of field, real-world textures.",
    "Mundane and specific. No text, no watermark, no logos.",
  ].join(" ");
  const { buffer, mime, ext } = await generateImageBytes({ prompt: framed });

  const sha = crypto.createHash("sha256").update(buffer).digest("hex");
  const shortId = sha.slice(0, 16);

  if (s3.s3Configured) {
    await s3.putPostImage(pubkey, shortId, ext, buffer, mime);
  } else {
    // Local-dev fallback: write to the character dir using the
    // post-<shortId>.<ext> filename convention the GET /posts/...
    // route knows how to find on disk.
    const dir = getCharDir(pubkey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `post-${shortId}.${ext}`), buffer);
  }
  // URL is the same in both cases — the /posts/:pubkey/:filename route
  // chooses S3-or-disk at serve time.
  const url = `${PUBLIC_BRIDGE_URL}/posts/${pubkey}/${shortId}.${ext}`;
  return { url, mime, ext, sha256: sha, prompt: framed };
}

async function generateAvatar({ pubkey, name, about, promptOverride, seed }) {
  const { buffer, mime, ext, prompt } = await generateAvatarBytes({ name, about, promptOverride, seed });
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

// ── T-pose generation (FLUX.1-Kontext, self-hosted) ──
//
// Reads the persisted avatar bytes for a character, sends them to the
// flux1-kontext Cloud Run service with a T-pose edit instruction, and
// writes the result to tpose.png in the char dir. Single file, gets
// overwritten on regenerate. S3 storage intentionally skipped for v1.

// Path to the bundled T-pose reference render (kimodo male_stylized).
// We composite this side-by-side with the avatar before calling Kontext
// so the model has correct anatomy + proportions to copy from instead of
// inventing a body from a portrait crop. See assets/render_tpose_reference.py.
const TPOSE_REFERENCE_PATH = join(__dirname, "assets", "tpose_reference.png");

// Off-white background to match what the prompt asks for, so the
// composite seam between avatar and reference reads as one scene.
const BG_RGB = { r: 245, g: 240, b: 230 };

// Build the side-by-side composite that Kontext receives. Each half is a
// 768×1024 panel: [ avatar (left) | T-pose reference (right) ]. Avatar is
// resized to fit the left panel preserving aspect, padded with off-white;
// reference is loaded as-is. Result: 1536×1024 PNG.
async function buildTposeComposite(avatarBuffer, avatarMime) {
  const PANEL_W = 768;
  const PANEL_H = 1024;
  const referenceBuf = readFileSync(TPOSE_REFERENCE_PATH);

  // Left panel: avatar resized to fit the panel preserving aspect, padded
  // with the same off-white we describe to Kontext.
  const leftPanel = await sharp(avatarBuffer)
    .resize(PANEL_W, PANEL_H, { fit: "contain", background: BG_RGB })
    .png()
    .toBuffer();

  // Right panel: the rendered reference (already 768×1024, off-white bg).
  // Resize defensively in case the reference asset gets re-rendered at a
  // different size.
  const rightPanel = await sharp(referenceBuf)
    .resize(PANEL_W, PANEL_H, { fit: "contain", background: BG_RGB })
    .png()
    .toBuffer();

  // Composite onto a 1536×1024 canvas.
  const composite = await sharp({
    create: {
      width: PANEL_W * 2,
      height: PANEL_H,
      channels: 3,
      background: BG_RGB,
    },
  })
    .composite([
      { input: leftPanel, top: 0, left: 0 },
      { input: rightPanel, top: 0, left: PANEL_W },
    ])
    .png()
    .toBuffer();

  return { buffer: composite, mime: "image/png" };
}

// Crop the right half out of Kontext's response. The prompt asks Kontext
// to redraw only the right side, but it returns the full canvas with both
// figures still present. We slice the right half so callers see just the
// transformed character.
async function cropRightHalf(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) throw new Error(`cropRightHalf: bad metadata (${w}x${h})`);
  const halfW = Math.floor(w / 2);
  return sharp(buffer)
    .extract({ left: halfW, top: 0, width: w - halfW, height: h })
    .png()
    .toBuffer();
}

// Composite input is 1536×1024 (3:2 landscape), but Kontext doesn't
// preserve the layout in its output — it produces a single full-figure
// T-pose centered on the canvas, so the output aspect can be set
// independently of the input. T-pose figures have arm-span ≈ body
// height (~square bbox); pure 1:1 made Kontext stretch the torso to
// fill the canvas vertically when arms came out slightly drooped.
// 7:6 helped but still left a slight stretch — bumping to 4:3 (1.33:1)
// gives Kontext a clearer "wider than tall" canvas where arm-span at
// full extension fits horizontally and there's room above + below the
// figure rather than the figure being scaled to fill the height.
const TPOSE_ASPECT_RATIO = "4:3";
// CFG scale on Kontext NIM ranges 1<x≤9 (default 3.5). 5.0 was the value
// that produced the cleanest combine results in probing — high enough
// to pin down the pose / palm orientation, low enough to avoid noise
// and to leave the model room to make stylistic choices about outfit
// transfer (which it does well at moderate CFG).
const TPOSE_CFG_SCALE = 5.0;

// Edit prompt for Kontext. Frames the request as a "3D character rigging
// reference sheet" so the model pulls from its Mixamo / Blender / Maya
// training cluster, where palm-down anatomy and standard humanoid
// proportions are the dominant pattern. Two pitfalls fixed:
//  · "palms facing down" got read as palms-toward-camera in earlier
//    versions. The Mixamo-Y-Bot anchor + airplane analogy + explicit
//    two-sided phrasing ("palms toward floor / back of hands toward
//    ceiling") leave no room for the upright-palms misread.
//  · "preserve proportions exactly" forced the avatar's chibi
//    proportions through the edit. Dropped — only face/outfit/colors
//    are preserved; the pose AND proportions are explicitly redrawn.
// The input to Kontext is a side-by-side composite:
//   LEFT panel  = the character's avatar (portrait — head/shoulders)
//   RIGHT panel = a clean rendered T-pose reference figure (kimodo
//                 mixamo paladin — correct anatomy, fully clothed in
//                 armor, humanoid proportions)
//
// Prompt phrasing matters a LOT here. Three traps we hit and now avoid:
//   1. "left figure / right figure / redraw" → Kontext's safety filter
//      reads identity-transfer wording as a deepfake concern and returns
//      all-black ~6KB JPEGs.
//   2. "Character reference sheet" → Kontext interprets it literally
//      and produces a 4-pose turnaround sheet (front / side / back /
//      3/4 view) instead of a single figure.
//   3. No explicit "no armor" → the paladin reference's armor leaks
//      into the output's pants/legs.
//
// The phrasing below threads all three: avoids identity-transfer
// trigger words, avoids "reference sheet" language, and explicitly
// negates multi-view layouts and armor. Verified across 5 random seeds
// to produce consistent single-figure full T-poses with palms-down.
const TPOSE_PROMPT =
  "Single full-body T-pose illustration of ONE character matching the portrait. " +
  "Only one figure in the image, centered on a plain off-white background. " +
  "Same face, hairstyle, and casual everyday clothing as the portrait. " +
  "Arms straight out horizontal at shoulder height, palms facing down toward the ground. " +
  "Realistic adult human proportions — about 7 to 8 head-heights tall, normal stocky build. " +
  "Do NOT stretch or elongate the torso, legs, or neck. NOT thin and tall, NOT anime-stretched. " +
  "Arm-span equals body height (the bounding box of the figure is roughly square). " +
  "No armor, no weapons. " +
  "Do NOT draw multiple figures, multiple views, or a turnaround sheet. " +
  "Just one single figure in T-pose, front view.";

function readAvatarBytesFromDisk(pubkey) {
  const dir = getCharDir(pubkey);
  for (const ext of ["jpeg", "jpg", "png", "webp", "gif"]) {
    const path = join(dir, `avatar.${ext}`);
    if (existsSync(path)) {
      const mime =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "png" ? "image/png"
        : ext === "gif" ? "image/gif"
        : "image/jpeg";
      return { buffer: readFileSync(path), mime };
    }
  }
  return null;
}

async function generateTpose({ pubkey }) {
  if (!FLUX_KONTEXT_URL) throw new Error("FLUX_KONTEXT_URL not configured");
  const avatar = readAvatarBytesFromDisk(pubkey);
  if (!avatar) throw new Error("character has no avatar yet — generate one first");

  const composite = await buildTposeComposite(avatar.buffer, avatar.mime);
  const dataUri = `data:${composite.mime};base64,${composite.buffer.toString("base64")}`;

  let buffer = null;
  let lastBytes = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${FLUX_KONTEXT_URL.replace(/\/$/, "")}/v1/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        prompt: TPOSE_PROMPT,
        image: dataUri,
        seed: Math.floor(Math.random() * 2_147_483_647),
        steps: 30,
        aspect_ratio: TPOSE_ASPECT_RATIO,
        resize_response_image: false,
        cfg_scale: TPOSE_CFG_SCALE,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`flux-kontext ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const b64 = data.artifacts?.[0]?.base64;
    if (!b64) throw new Error("flux-kontext returned no image");
    const buf = Buffer.from(b64, "base64");
    lastBytes = buf.length;
    if (buf.length >= 15_000) { buffer = buf; break; }
    console.warn(`[char:tpose] attempt ${attempt + 1}: ${buf.length}B — safety-blocked, retrying`);
  }
  if (!buffer) {
    throw new Error(`flux-kontext kept returning safety-blocked images (last: ${lastBytes}B)`);
  }

  const dir = getCharDir(pubkey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tpose.png"), buffer);

  const tposeUrl = `${PUBLIC_BRIDGE_URL}/characters/${pubkey}/tpose?t=${Date.now()}`;
  return { tposeUrl };
}

// ── 3D model generation (Microsoft TRELLIS via NVIDIA NIM) ──
//
// Reads the persisted T-pose for a character, sends it to the Trellis
// Cloud Run service, and writes the resulting GLB to model.glb in the
// char dir. Single file, overwrites on regenerate. Disk-only for v1.

function readTposeBytesFromDisk(pubkey) {
  const dir = getCharDir(pubkey);
  const path = join(dir, "tpose.png");
  if (existsSync(path)) return { buffer: readFileSync(path), mime: "image/png" };
  return null;
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

// Smart-objects registry (#245 slice 1) — placed objects in the
// room, persisted as JSONL under $WORKSPACE. Slice 2 adds the
// `use(object_id)` verb + capacity / effects through the GM.
const objectsRegistry = createObjectsRegistry({ workspacePath: WORKSPACE });
// Seed a small starter set on first boot so the demo isn't empty.
// Idempotent — only fires when the registry has zero placed objects.
if (process.env.WOID_OBJECTS_SEED !== "0") {
  const seeded = seedDefaultObjects(objectsRegistry, {
    placements: defaultObjectPlacements(),
  });
  if (seeded.length > 0) {
    console.log(`[objects] seeded ${seeded.length} default objects`);
  }
}

// Needs tracker — server-side per-character drives (energy, social)
// decaying uniformly over sim-time. #275 narrowed this from #235's
// 3-axis (energy/social/curiosity) to 2-axis; psychological state
// moved to the moodlet system in moodlets.js.
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

// Moodlets tracker (#275) — event-driven affect, summed into a 4-band
// mood. Replaces the curiosity decay axis. Persistence is per-pubkey
// JSONL under $WORKSPACE/moodlets/. Expiry runs in the same 5s tick
// loop as needs.
const moodlets = createMoodletsTracker({ workspacePath: WORKSPACE });

setInterval(() => {
  try {
    const expired = moodlets.expireDue();
    for (const r of expired) {
      for (const m of r.expired) {
        // Surface expiry as a perception event so the LLM sees its
        // own mood shifting ("you no longer feel insulted by Bob").
        perception.appendOne(r.pubkey, {
          kind: "moodlet_expired",
          tag: m.tag,
          reason: m.reason || null,
        });
      }
    }
  } catch (err) {
    console.error("[moodlets] expiry tick failed:", err?.message || err);
  }
}, NEEDS_TICK_MS).unref();

// Rooms (#285 phase A) — named regions on the existing 16×12 grid.
// Default building seeded if the workspace has no rooms.json yet.
// `assignDefaultApartment` is called from createCharacter so each
// new character claims an apartment in declaration order.
const roomsRegistry = createRoomsRegistry({ workspacePath: WORKSPACE });

// Backfill ownership for any characters loaded from the workspace
// that don't have an apartment yet. Idempotent — `assignOwnership`
// returns the existing record if the pubkey is already bound.
for (const c of listCharacters()) {
  roomsRegistry.assignOwnership(c.pubkey);
}

// Schedules (#235 reshape — coarse 4-slot timetable per character).
// "own" slots resolve to whichever apartment the character owns via
// the rooms registry. The mover tick below uses this to route
// characters into their slot's room. Named `schedules` (not
// `scheduler`) to avoid colliding with the heartbeat scheduler from
// scheduler.js declared further down.
const schedules = createScheduleRegistry({
  workspacePath: WORKSPACE,
  resolveOwnRoom: (pubkey) => roomsRegistry.roomOwnedBy(pubkey),
});

// Sim-clock (#275 slice 2) — maps real-time → sim-time. Default
// cadence is 1:1 (1 real-min = 1 sim-min) so a sim-day is a real
// day; override via SIM_MS_PER_MIN env for fast dev cycles.
const simClock = createSimClock({
  workspacePath: WORKSPACE,
  simMinutePerRealMs: Number(process.env.SIM_MS_PER_MIN) || undefined,
});

// Session store (#275 slice 2) — opens a record per sim-day, hands
// it off to the recap pipeline at rollover. The onClose hook below
// gets wired once the recap function is defined.
// Forward declaration — director is constructed after this block but
// we want each new sim-day to clear once_per_session memory.
let _onSessionOpen = null;
const sessions = createSessionStore({
  workspacePath: WORKSPACE,
  simClock,
  onOpen: (rec) => { _onSessionOpen?.(rec); },
  onClose: async (rec) => {
    try {
      await runRecap(rec);
    } catch (err) {
      console.warn("[sessions] recap failed:", err?.message || err);
    }
  },
});

// Forward declaration — runRecap is defined further down so it can
// see the LLM provider plumbing. The session store calls into a
// closure that resolves to the live function at call time.
let runRecap = async (rec) => {
  console.log(`[sessions] closed sim-day ${rec.sim_day} (no recap fn yet)`);
};

// Open today's session on boot (or restore an in-flight one).
sessions.ensureOpen().catch((err) =>
  console.warn("[sessions] initial ensureOpen failed:", err?.message || err),
);

// Sim-day rollover poller — every 30s real-time, re-check the sim-
// day and let the session store close+open as needed. Cheap enough
// to run unconditionally; ensureOpen is a no-op when nothing has
// changed.
setInterval(() => {
  sessions.ensureOpen().catch((err) =>
    console.warn("[sessions] rollover ensureOpen failed:", err?.message || err),
  );
}, 30_000).unref();

// Schedule nudger — emits perception events ("your routine usually
// has you in the kitchen now") into characters' streams when their
// current room doesn't match their slot's target. The LLM decides
// whether to move via its existing `move` verb. We deliberately do
// NOT force-move characters here — schedules are a *gate* for the
// behavior layer, not a hard puppet string. (Pattern from
// docs/research/rimworld.md: schedules allow subtrees, they don't
// drive primitives.)
//
// Re-nudge logic: only emit when (a) the slot/target is fresh for
// this character, or (b) the same nudge has been outstanding longer
// than NUDGE_REPEAT_MS — covers the case where the LLM ignored or
// missed the first nudge.
const SCHEDULE_TICK_MS = Number(process.env.SCHEDULE_TICK_MS) || 30_000;
const NUDGE_REPEAT_MS = Number(process.env.SCHEDULE_NUDGE_REPEAT_MS) || 5 * 60 * 1000;
const lastNudge = new Map();   // pubkey → { slot, target_room_id, ts }

setInterval(() => {
  try {
    // Slot is driven by sim-time (#275 slice 2), not wall-clock.
    const slot = simClock.currentSlot();
    for (const c of listCharacters()) {
      const targetRoomId = schedules.targetRoomFor(c.pubkey, slot);
      if (!targetRoomId) continue;
      // Only running characters get nudged — without a colyseus seat
      // there's no presence to read and no turn loop to react.
      const active = activeRuntimeForCharacter(c.pubkey);
      if (!active) continue;
      const snap = roomSnapshot(active.id);
      const me = (snap?.agents || []).find((a) => a.npub === c.pubkey);
      if (!me) continue;
      const currentRoomId = roomsRegistry.roomAt(me.x, me.y);
      if (currentRoomId === targetRoomId) {
        // Already where the routine wants them — clear nudge memory
        // so the next slot gets a fresh nudge on transition.
        lastNudge.delete(c.pubkey);
        continue;
      }
      const last = lastNudge.get(c.pubkey);
      const isFresh = !last || last.slot !== slot || last.target_room_id !== targetRoomId;
      const cooldownExpired = last && Date.now() - last.ts > NUDGE_REPEAT_MS;
      if (!isFresh && !cooldownExpired) continue;
      const tile = roomsRegistry.randomFreeTile(targetRoomId, snap);
      if (!tile) continue;
      const target = roomsRegistry.get(targetRoomId);
      perception.appendOne(c.pubkey, {
        kind: "schedule_nudge",
        slot,
        target_room_id: targetRoomId,
        target_room_name: target?.name || targetRoomId,
        target_x: tile.x,
        target_y: tile.y,
      });
      lastNudge.set(c.pubkey, { slot, target_room_id: targetRoomId, ts: Date.now() });
      console.log(`[schedule] nudge ${c.name || c.pubkey.slice(0, 8)} → ${targetRoomId} (${tile.x},${tile.y}) [slot=${slot}]`);
    }
  } catch (err) {
    console.error("[schedule] tick failed:", err?.message || err);
  }
}, SCHEDULE_TICK_MS).unref();

// Game Master — single chokepoint for committing harness-emitted
// actions. See gm.js for the verb registry and dispatch logic.
// The tracker's effective scene helpers are injected so cooldowns
// flow through to say_to validation, perception emission, etc.
// Per-character last image-post timestamp (real-ms) for cooldown
// gating in the post verb. In-memory only; resets on bridge restart.
const imagePostCooldown = new Map();

// Relationships graph (#365) — per-pair record of who's met whom.
// Backs first-meeting detection in the scene-open hook below.
const relationships = createRelationships({ workspacePath: WORKSPACE });

// Storyteller card pool + director (#305). Loads JSON cards from disk
// on boot, wires the action runtime against the live moodlets/session/
// perception surfaces, and runs the director on a tick interval. The
// director picks one eligible card per tick (cooldowns gate frequency)
// and routes by sim-clock phase: opening at the start of the day,
// ambient through the middle, closing toward bedtime.
const CARDS_DIR = process.env.CARDS_DIR || join(__dirname, "cards");
const cardLoader = createCardLoader({ cardsPath: CARDS_DIR, fs: { existsSync, readdirSync, statSync, readFileSync } });
const _cardLoadResult = cardLoader.loadAll();
console.log(`[cards] loaded ${_cardLoadResult.loaded} cards from ${CARDS_DIR}` + (_cardLoadResult.errors.length ? ` (${_cardLoadResult.errors.length} errors)` : ""));
for (const e of _cardLoadResult.errors) console.warn(`[cards]   ${e.path}: ${e.error}`);

function listInRoomPubkeys() {
  // Only characters with a live runtime are eligible for card role
  // binding — dormant characters have no turn loop, so moodlets and
  // speech perceptions emitted onto them go nowhere.
  const out = [];
  for (const c of listCharacters()) {
    if (activeRuntimeForCharacter(c.pubkey)) out.push(c.pubkey);
  }
  return out;
}

// Get scene-mates of pubkey using its runtime's room snapshot. Returns
// [] if the character isn't running or has no runtime.
function sceneMatesOfPubkey(pubkey) {
  const active = activeRuntimeForCharacter(pubkey);
  if (!active) return [];
  const snap = roomSnapshot(active.id);
  if (!snap) return [];
  const me = (snap.agents || []).find((a) => a.npub === pubkey);
  if (!me) return [];
  const out = [];
  for (const a of snap.agents || []) {
    if (!a?.npub || a.npub === pubkey) continue;
    if (Math.max(Math.abs((a.x ?? 0) - (me.x ?? 0)), Math.abs((a.y ?? 0) - (me.y ?? 0))) <= 1) {
      out.push(a.npub);
    }
  }
  return out;
}

function pickRandomCharacterPubkey(opts = {}) {
  let pool = listInRoomPubkeys();
  if (opts.withSceneMate) {
    const withMates = pool.filter((pk) => sceneMatesOfPubkey(pk).length > 0);
    // Fall back to any in-room character only if nobody has a scene-
    // mate — better to fire on the wrong character than not at all.
    if (withMates.length > 0) pool = withMates;
  }
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickSceneMatePubkey(anchorPubkey) {
  const mates = sceneMatesOfPubkey(anchorPubkey);
  if (mates.length === 0) return null;
  return mates[Math.floor(Math.random() * mates.length)];
}

let _scheduleCardCb = () => {};   // resolved once director is constructed
const cardRuntime = createCardRuntime({
  moodletsTracker: moodlets,
  sessions,
  perception,
  simClock,
  loadCharacter,
  pickRandomCharacter: pickRandomCharacterPubkey,
  pickSceneMate: pickSceneMatePubkey,
  scheduleCard: (id, atRealMs) => _scheduleCardCb(id, atRealMs),
});

// Persistent fire log — append-only JSONL of every card the director
// has decided to fire. Survives restart so the Storyteller tab can
// load history on mount instead of only showing in-tab fires.
const DIRECTOR_LOG_PATH = join(WORKSPACE, "director-log.jsonl");
function recordFire(rec) {
  try {
    appendFileSync(DIRECTOR_LOG_PATH, JSON.stringify(rec) + "\n");
  } catch (err) {
    console.warn("[director] log write failed:", err?.message || err);
  }
  const who = rec.bindings ? Object.entries(rec.bindings).map(([r, p]) => `${r}:${(loadCharacter(p)?.name || p.slice(0, 6))}`).join(" ") : "";
  console.log(`[director] ${rec.ok ? "fired" : "FAILED"} ${rec.card_id} (${rec.source}) phase=${rec.phase} intensity=${rec.intensity} ${who}${rec.reason ? ` — ${rec.reason}` : ""}`);
}

const director = createDirector({
  cards: cardLoader,
  runtime: cardRuntime,
  moodlets,
  sessions,
  simClock,
  onFire: recordFire,
});
_scheduleCardCb = director.scheduleCard;
_onSessionOpen = () => director.onSessionOpen();

const DIRECTOR_TICK_MS = Number(process.env.DIRECTOR_TICK_MS) || 60_000;
setInterval(() => {
  // Skip when there are no in-room characters to bind roles against.
  if (listInRoomPubkeys().length === 0) return;
  const slot = simClock.currentSlot?.();
  const phase = phaseForSimSlot(slot);
  director.tick({ phases: new Set([phase]) }).catch((err) => {
    console.warn("[director] tick failed:", err?.message || err);
  });
}, DIRECTOR_TICK_MS).unref();

// Cross-character post subscriptions (#365 slice 4). Each follower
// subscribes to the kind:1 events of every character they follow;
// new posts surface as `post_seen` perception events on the follower.
//
// Implementation: per-follower subscription handle keyed by pubkey.
// On follow, we close any existing handle and re-open with the
// expanded author set. Deduplicated by event_id.
const postSubscriptions = new Map();          // followerPubkey → SubCloser
const postSubSeen = new Map();                // followerPubkey → Set<event_id>

function imetaUrl(tags) {
  for (const t of tags || []) {
    if (t[0] !== "imeta") continue;
    for (const piece of t.slice(1)) {
      if (typeof piece === "string" && piece.startsWith("url ")) return piece.slice(4);
    }
  }
  return null;
}

function refreshPostSubscriptionFor(followerPubkey) {
  const c = loadCharacter(followerPubkey);
  if (!c) return;
  const authors = (c.follows || []).filter((p) => /^[0-9a-f]{64}$/i.test(p));
  const existing = postSubscriptions.get(followerPubkey);
  if (existing) try { existing.close(); } catch {}
  if (authors.length === 0) {
    postSubscriptions.delete(followerPubkey);
    return;
  }
  if (!postSubSeen.has(followerPubkey)) postSubSeen.set(followerPubkey, new Set());
  const seen = postSubSeen.get(followerPubkey);
  // Skip events older than now-1s so a re-subscribe after restart
  // doesn't re-fire stale posts as new perception.
  const since = Math.floor(Date.now() / 1000);
  const sub = pool.subscribe(
    [RELAY_URL],
    { kinds: [1], authors, since },
    {
      onevent(ev) {
        if (!ev?.id || seen.has(ev.id)) return;
        seen.add(ev.id);
        const author = loadCharacter(ev.pubkey);
        perception.appendOne(followerPubkey, {
          kind: "post_seen",
          from_pubkey: ev.pubkey,
          from_name: author?.name || ev.pubkey.slice(0, 8),
          event_id: ev.id,
          text: ev.content,
          image_url: imetaUrl(ev.tags),
          posted_at: ev.created_at,
        });
        try {
          sessions.appendEvent({
            kind: "post_seen",
            actor_name: author?.name || ev.pubkey.slice(0, 8),
            actor_pubkey: ev.pubkey,
            seen_by_name: c.name,
            seen_by_pubkey: followerPubkey,
            text: ev.content,
            image_url: imetaUrl(ev.tags),
            event_id: ev.id,
            sim_iso: simClock?.now?.()?.sim_iso,
          });
        } catch {}
        console.log(`[post-sub] ${c.name} saw ${author?.name || ev.pubkey.slice(0, 8)}'s post (${ev.id.slice(0, 8)})`);
      },
    },
  );
  postSubscriptions.set(followerPubkey, sub);
}

function subscribeToFollowee(followerPubkey, _followeePubkey) {
  // We just refresh the entire follower's subscription against their
  // current follows[]. The follower → manifest write happened just
  // before this call.
  refreshPostSubscriptionFor(followerPubkey);
}

// On boot, re-subscribe all characters with non-empty follows lists.
function bootPostSubscriptions() {
  for (const c of listCharacters()) {
    if (Array.isArray(c.follows) && c.follows.length > 0) {
      refreshPostSubscriptionFor(c.pubkey);
    }
  }
}

const gm = createGM({
  roomSay,
  relayPost,
  moveAgent,
  saveCharacterManifest,
  loadCharacter,
  perception,
  sceneMatesOf: sceneTracker.effectiveSceneMatesOf,
  inScene: sceneTracker.effectiveInScene,
  needsTracker,           // set_mood + use→need effects mirror values
  moodletsTracker: moodlets,
  objectsRegistry,
  simClock,                // use→advance_sim (sleep skips ahead)
  getSnapshot: roomSnapshot,
  generatePostImage,        // post(image_prompt) generates + uploads
  imagePostCooldown,
  publishCharacterFollows,  // follow verb publishes kind:3
  subscribeToFollowee,      // follow verb wires post-subscription
});

// Boot: open subscriptions for every character that already has a
// non-empty follows list so Roman-already-followed-Maya scenarios
// keep working across restarts.
bootPostSubscriptions();

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
      // Recap-source widening (#275 slice 2 follow-up). Append to the
      // active session's perception window so the recap LLM has more
      // than just scene_close to chew on. Solo characters produce no
      // scenes — without this hook every solo day fell back to "Day N
      // passed quietly."
      try {
        appendActionToSession(rec, result, snapshot);
      } catch (err) {
        console.warn("[sessions] action append failed:", err?.message || err);
      }
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
    // First-meeting hook (#365). For pairs we've never tracked, the
    // relationship store creates a record and we broadcast a special
    // first_meeting perception so both characters know this is novel.
    if (Array.isArray(scene.participants) && scene.participants.length === 2) {
      const [a, b] = scene.participants;
      const sim = simClock?.now?.();
      const enc = relationships.recordEncounter(a, b, {
        sim_iso: sim?.sim_iso, sim_day: sim?.sim_day,
      });
      if (enc.created) {
        const charA = loadCharacter(a);
        const charB = loadCharacter(b);
        // To A: their counterpart is B.
        perception.appendOne(a, {
          kind: "first_meeting",
          with_pubkey: b,
          with_name: charB?.name || b.slice(0, 8),
          sceneId: scene.sceneId,
        });
        perception.appendOne(b, {
          kind: "first_meeting",
          with_pubkey: a,
          with_name: charA?.name || a.slice(0, 8),
          sceneId: scene.sceneId,
        });
        // Recap surface.
        try {
          sessions.appendEvent({
            kind: "first_meeting",
            participants: [a, b],
            participant_names: [charA?.name || a.slice(0, 8), charB?.name || b.slice(0, 8)],
            sim_iso: sim?.sim_iso,
            sim_hour: sim?.sim_hour,
            sim_day: sim?.sim_day,
          });
        } catch (err) {
          console.warn("[sessions] first_meeting append failed:", err?.message || err);
        }
        console.log(`[relationships] first meeting: ${charA?.name || a.slice(0, 8)} + ${charB?.name || b.slice(0, 8)}`);
      }
    }
  }
  for (const scene of transitions.closed || []) {
    emitSceneCloseEvent(scene);
  }
}

function emitSceneCloseEvent(scene) {
  // Two-step finalize: pull the in-memory record, derive moodlets +
  // any other post-scene state, then persist a single JSONL row that
  // includes everything. (#275 slice 11.)
  const rec = journal.finalizeScene({
    sceneId: scene.sceneId,
    endReason: scene.reason,
  });
  // Even if the scene record is missing (rare race), still broadcast.
  if (!rec) {
    perception.broadcastTo(scene.participants, {
      kind: "scene_close",
      sceneId: scene.sceneId,
      with_pubkeys: scene.participants,
      reason: scene.reason,
    });
    return;
  }
  // Run scene → moodlet summarisation. LLM-enhanced when a provider
  // is reachable; deterministic fallback otherwise. We DON'T await
  // here because the broadcast + persistence shouldn't block on a
  // network call; instead we kick off async and persist on completion.
  summarizeAndEmitMoodlets(rec).catch((err) =>
    console.warn(`[scene-summary] ${scene.sceneId} failed:`, err?.message || err),
  );
  perception.broadcastTo(scene.participants, {
    kind: "scene_close",
    sceneId: scene.sceneId,
    with_pubkeys: scene.participants,
    reason: scene.reason,
  });
  console.log(`[scenes] closed ${scene.sceneId} (${scene.participants.join(" + ")}) — ${scene.reason}`);
}

/**
 * Async tail of scene close — run summarisation, emit moodlets onto
 * each participant, persist the journal row with the moodlets attached.
 * Errors anywhere in here just degrade us to the deterministic fallback.
 */
async function summarizeAndEmitMoodlets(rec) {
  const result = await summarizeSceneToMoodlets(rec, {
    resolveCharacter: (pk) => {
      const c = loadCharacter(pk);
      return c ? { name: c.name, about: c.about } : null;
    },
    llm: SCENE_SUMMARY_LLM_AVAILABLE ? sceneSummaryLLM : null,
  });
  for (const m of result.moodlets) {
    const emitted = moodlets.emit(m.pubkey, m);
    if (emitted) {
      perception.appendOne(m.pubkey, {
        kind: "moodlet_added",
        tag: emitted.tag,
        weight: emitted.weight,
        reason: emitted.reason || null,
      });
    }
  }
  rec.moodlets = result.moodlets;
  rec.summary_source = result.source;
  journal.persistScene(rec);
  console.log(`[scene-summary] ${rec.scene_id} → ${result.moodlets.length} moodlets (${result.source})`);

  // Append a digest of this scene to today's session window so the
  // recap pipeline can lead with it. We deliberately don't store the
  // full transcript — just enough to recall (participants + last
  // line + end_reason + emitted moodlets).
  try {
    const lastTurn = (rec.turns || []).slice(-1)[0];
    sessions.appendEvent({
      kind: "scene_close",
      scene_id: rec.scene_id,
      participants: rec.participants,
      end_reason: rec.end_reason,
      last_line: lastTurn?.args?.text ?? null,
      last_actor_name: lastTurn?.actor_name ?? null,
      moodlets: result.moodlets.map((m) => ({
        pubkey: m.pubkey, tag: m.tag, weight: m.weight, reason: m.reason,
      })),
    });
  } catch (err) {
    console.warn("[sessions] appendEvent (scene_close) failed:", err?.message || err);
  }
}

// LLM-availability flag + caller for scene summarisation. Uses the
// openai-compat provider against NIM if a key is present; falls back
// to the local llm if LOCAL_LLM_BASE_URL is set; else "no llm" and
// the deterministic moodlet path runs.
const SCENE_SUMMARY_PROVIDER =
  NVIDIA_NIM_API_KEY ? "nvidia-nim" :
  LOCAL_LLM_BASE_URL ? "local" :
  null;
const SCENE_SUMMARY_LLM_AVAILABLE = SCENE_SUMMARY_PROVIDER !== null;
const SCENE_SUMMARY_MODEL =
  process.env.SCENE_SUMMARY_MODEL ||
  (SCENE_SUMMARY_PROVIDER === "nvidia-nim" ? "moonshotai/kimi-k2.5"
   : SCENE_SUMMARY_PROVIDER === "local" ? "gemma-4-E4B-it-Q4_K_M"
   : null);

async function sceneSummaryLLM({ scene, characters }) {
  const { systemPrompt, userPrompt } = buildSceneSummaryPrompt({
    scene,
    resolveCharacter: (pk) => characters.find((c) => c.pubkey === pk) || null,
  });
  const endpoint = SCENE_SUMMARY_PROVIDER === "nvidia-nim"
    ? "https://integrate.api.nvidia.com/v1"
    : LOCAL_LLM_BASE_URL;
  const apiKey = SCENE_SUMMARY_PROVIDER === "nvidia-nim" ? NVIDIA_NIM_API_KEY : "";
  const out = await openaiCompatGenerateJson({
    endpoint, apiKey, systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    model: SCENE_SUMMARY_MODEL,
    timeoutMs: 30_000,
  });
  if (!out?.text) return null;
  try {
    return JSON.parse(out.text);
  } catch {
    return null;
  }
}

// ── Recap pipeline (#275 slice 2.2) ──
//
// Bound to the same provider plumbing as the scene-summary call.
// Called from the sessions store's onClose hook (forward-declared
// at boot, defined here, then assigned).
const RECAP_FEW_SHOT = [
  // Hand-written reference recaps used as few-shot. Each is a 2-3
  // sentence past-tense vignette in the cozy / slice-of-life voice
  // we tuned for in docs/design/vertical-slice.md.
  `Marisol baked too much bread again, which she does when she's nervous, and Carlos pretended not to notice it was the third loaf this week. Tomek packed for his trip and forgot the same coat, twice.`,
  `Cleo finished a chapter she's been threatening to finish for a month. She didn't say so, but she opened the window for the first time in days and left it open. Bo passed by twice and pretended not to look.`,
  `Felix slept past noon and ordered food when he finally woke. Eira heard him on the phone with someone whose voice she'll recognize, eventually.`,
];

const RECAP_SYSTEM_PROMPT = [
  `You write the daily recap for a tiny apartment building of LLM characters.`,
  `Output ONLY the recap text — no headings, no list formatting, no quotation marks around the whole.`,
  `Voice: small-press literary fiction, slightly dry. 80-150 words, past tense, named characters.`,
  `Hard rules: no em-dashes; no "I'm sorry"; no "Of course"; no markdown bullets; no headlines.`,
  `Pull only from events in the day's perception window the user supplies. Do NOT invent events not present.`,
  `Lead with the strongest beat (a relationship transition, a moodlet of |weight|≥5, a departure). Close with something quiet.`,
  ``,
  `Examples of the voice you should match:`,
  ...RECAP_FEW_SHOT.map((s, i) => `Example ${i + 1}: ${s}`),
].join("\n");

const RECAP_PROVIDER = SCENE_SUMMARY_PROVIDER;
// Recap quality is voice-sensitive; use a non-reasoning chat-tuned
// model so the entire token budget goes to prose. The default
// SCENE_SUMMARY_MODEL (kimi-k2.5) is a reasoning model that consumes
// max_tokens for hidden reasoning and emits empty visible text.
const RECAP_MODEL =
  process.env.RECAP_MODEL ||
  (RECAP_PROVIDER === "nvidia-nim" ? "meta/llama-3.3-70b-instruct" : SCENE_SUMMARY_MODEL);

/**
 * Append a verb commit to the active session's window if it's the
 * kind of action worth recapping. Conservative — most verbs (move,
 * idle, wait, emote) are skipped to keep the recap signal-rich.
 *
 * Per-character per-room dedup is handled by `lastRecapRoom` so a
 * sequence of `move` ticks within the same room only logs once.
 */
const lastRecapRoom = new Map();   // pubkey → room_id
function appendActionToSession(rec, result, snapshot) {
  const v = result.verb;
  const args = result.args || {};
  const me = (snapshot?.agents || []).find((a) => a.npub === rec.pubkey);
  const tile = me ? { x: me.x, y: me.y } : null;
  const room = tile ? roomsRegistry?.roomAt(tile.x, tile.y) ?? null : null;
  // Stamp every recap-bound event with sim-time so the LLM's recap
  // can place beats in the day ("by mid-afternoon, …").
  const simNow = simClock?.now() || {};
  const stamp = { sim_iso: simNow.sim_iso, sim_hour: simNow.sim_hour, sim_day: simNow.sim_day };

  if (v === "post") {
    sessions.appendEvent({
      kind: "post",
      actor_name: rec.name,
      actor_pubkey: rec.pubkey,
      text: args.text,
      image_url: args.image_url || null,
      image_prompt: args.image_prompt || null,
      event_id: result.event_id || null,
      room,
      ...stamp,
    });
    return;
  }
  if (v === "use") {
    sessions.appendEvent({
      kind: "object_used",
      actor_name: rec.name,
      actor_pubkey: rec.pubkey,
      object_type: args.object_type,
      affordance: args.affordance,
      room,
      ...stamp,
    });
    return;
  }
  if (v === "move") {
    // Only log the first move into a new room (room transitions, not
    // per-tile shuffles).
    if (room && lastRecapRoom.get(rec.pubkey) !== room) {
      lastRecapRoom.set(rec.pubkey, room);
      sessions.appendEvent({
        kind: "room_change",
        actor_name: rec.name,
        actor_pubkey: rec.pubkey,
        room,
        ...stamp,
      });
    }
    return;
  }
  if (v === "follow") {
    sessions.appendEvent({
      kind: "follow",
      actor_name: rec.name,
      actor_pubkey: rec.pubkey,
      target_pubkey: args.target_pubkey,
      target_name: args.target_name || (loadCharacter(args.target_pubkey)?.name) || null,
      ...stamp,
    });
    return;
  }
  if (v === "reply") {
    sessions.appendEvent({
      kind: "reply",
      actor_name: rec.name,
      actor_pubkey: rec.pubkey,
      to_event_id: args.to_event_id,
      to_pubkey: args.to_pubkey || null,
      text: args.text,
      image_url: args.image_url || null,
      ...stamp,
    });
    return;
  }
  // Other verbs (say, say_to, set_state, set_mood, idle, wait, emote,
  // face) don't directly feed the recap. Their narrative weight comes
  // through the scene_close path or via moodlet emissions.
}

function summarizeEventsForRecap(rec) {
  const lines = [];
  for (const ev of rec.events || []) {
    const tsLabel = ev.sim_iso || ev.sim_hour != null
      ? ` [${ev.sim_iso || `hour ${ev.sim_hour}`}]`
      : "";
    if (ev.kind === "scene_close") {
      const names = ev.participant_names && ev.participant_names.length === (ev.participants || []).length
        ? ev.participant_names
        : (ev.participants || []).map((pk) => {
            const c = loadCharacter(pk);
            return c?.name || pk.slice(0, 8);
          });
      lines.push(`scene closed (${ev.end_reason}) between ${names.join(" + ")}${tsLabel}` +
        (ev.last_line ? ` — last line ${ev.last_actor_name || "?"}: "${truncate(ev.last_line, 120)}"` : ""));
      for (const m of ev.moodlets || []) {
        const c = loadCharacter(m.pubkey);
        const name = m.actor_name || c?.name || (m.pubkey?.slice(0, 8) ?? "?");
        lines.push(`  ${name} ${m.weight >= 0 ? "+" : ""}${m.weight}: ${m.reason || m.tag}`);
      }
    } else if (ev.kind === "post") {
      lines.push(`${ev.actor_name || "someone"} posted publicly${tsLabel}: "${truncate(ev.text || "", 200)}"`);
    } else if (ev.kind === "object_used") {
      const where = ev.room ? ` in the ${ev.room}` : "";
      lines.push(`${ev.actor_name || "someone"} used the ${ev.object_type}${where} (${ev.affordance})${tsLabel}`);
    } else if (ev.kind === "room_change") {
      lines.push(`${ev.actor_name || "someone"} entered the ${ev.room}${tsLabel}`);
    } else if (ev.kind === "need_low") {
      lines.push(`${ev.actor_name || "someone"} hit low ${ev.axis}${tsLabel}`);
    } else if (ev.kind === "first_meeting") {
      const names = (ev.participant_names || ev.participants || []).slice();
      lines.push(`${names.join(" and ")} met for the first time${tsLabel}`);
    } else if (ev.kind === "follow") {
      lines.push(`${ev.actor_name || "someone"} started following ${ev.target_name || ev.target_pubkey?.slice(0, 8) || "another character"}${tsLabel}`);
    } else if (ev.kind === "reply") {
      lines.push(`${ev.actor_name || "someone"} replied to a post${tsLabel}: "${truncate(ev.text || "", 160)}"`);
    } else if (ev.kind === "post_seen") {
      // Pulled into the recap so the LLM can describe how a post landed.
      // Skip if the same actor already posted (avoid duplicate signal).
      const photo = ev.image_url ? " [photo]" : "";
      lines.push(`${ev.seen_by_name || "someone"} read ${ev.actor_name || "someone"}'s post${photo}${tsLabel}: "${truncate(ev.text || "", 120)}"`);
    } else {
      lines.push(`${ev.kind}: ${JSON.stringify(ev).slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s, max) {
  return typeof s === "string" && s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fallbackRecap(rec) {
  const events = rec.events || [];
  if (events.length === 0) {
    return `Day ${rec.sim_day} passed quietly. Nobody said anything worth recording.`;
  }
  // Walk the day in order, naming things. Names per-actor are pulled
  // from the event payload (verb-driven events) or from participant
  // names (scene_close events).
  const lines = [];
  for (const ev of events) {
    if (ev.kind === "scene_close") {
      const names = (ev.participant_names && ev.participant_names.length === (ev.participants || []).length
        ? ev.participant_names
        : (ev.participants || []).map((pk) => loadCharacter(pk)?.name || pk.slice(0, 8))).join(" and ");
      lines.push(`${names} shared a moment in the ${ev.room || "apartment"}.`);
    } else if (ev.kind === "post") {
      const name = ev.actor_name || "someone";
      const text = (ev.text || "").trim().slice(0, 120);
      lines.push(`${name} wrote: "${text}".`);
    } else if (ev.kind === "object_used") {
      const name = ev.actor_name || "someone";
      const verb = ev.affordance === "sleep" ? "slept" : ev.affordance === "eat" ? "ate" : `used the ${ev.object_type}`;
      lines.push(`${name} ${verb}.`);
    } else if (ev.kind === "room_change") {
      const name = ev.actor_name || "someone";
      lines.push(`${name} headed to the ${ev.room}.`);
    }
  }
  if (lines.length === 0) {
    return `Day ${rec.sim_day} passed quietly. Nobody said anything worth recording.`;
  }
  return `Day ${rec.sim_day}: ${lines.join(" ")}`;
}

// Reassign the forward-declared runRecap.
runRecap = async function runRecapImpl(rec) {
  const eventsText = summarizeEventsForRecap(rec);
  if (!eventsText.trim()) {
    rec.recap = fallbackRecap(rec);
    rec.recap_source = "fallback";
    console.log(`[recap] sim-day ${rec.sim_day} → fallback (no events)`);
    return;
  }
  if (!RECAP_PROVIDER) {
    rec.recap = fallbackRecap(rec);
    rec.recap_source = "fallback";
    console.log(`[recap] sim-day ${rec.sim_day} → fallback (no provider)`);
    return;
  }
  try {
    const endpoint = RECAP_PROVIDER === "nvidia-nim"
      ? "https://integrate.api.nvidia.com/v1"
      : LOCAL_LLM_BASE_URL;
    const apiKey = RECAP_PROVIDER === "nvidia-nim" ? NVIDIA_NIM_API_KEY : "";
    const out = await openaiCompatGenerateJson({
      endpoint, apiKey,
      systemPrompt: RECAP_SYSTEM_PROMPT,
      // No JSON mode here — we want prose. The openai-compat helper
      // sets response_format=json_object, which most providers honor
      // strictly. Wrap our request so the model still emits a JSON
      // object with one prose field.
      messages: [{
        role: "user",
        content:
          `Sim day ${rec.sim_day} ran from ${rec.sim_iso_open} to ${rec.sim_iso_close}.\n\n` +
          `Events worth pulling from:\n${eventsText}\n\n` +
          `Output JSON: { "recap": "the full recap text here, 80-150 words" }`,
      }],
      model: RECAP_MODEL,
      timeoutMs: 60_000,
      // Recap is prose-heavy; default 1024 truncates JSON mid-string.
      // 2048 fits the 80-150 word target with comfortable headroom.
      maxTokens: 2048,
    });
    if (!out?.text) {
      console.warn(`[recap] sim-day ${rec.sim_day} → empty LLM response (usage ${JSON.stringify(out?.usage || {})}); using fallback`);
      rec.recap = fallbackRecap(rec);
      rec.recap_source = "fallback";
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch { /* not JSON */ }
    // Defensive: a malformed LLM response can put non-string under
    // `recap` (object, array, boolean, null). Coerce, then trim.
    const rawRecap = parsed && typeof parsed.recap === "string" ? parsed.recap : "";
    const text = rawRecap.trim();
    // Sparse-event days sometimes produce degenerate single-token
    // outputs ("true", "...", a single quote). Treat anything under
    // a minimum prose threshold as a no-result and fall back.
    const MIN_RECAP_CHARS = 40;
    if (text.length < MIN_RECAP_CHARS) {
      console.warn(`[recap] sim-day ${rec.sim_day} → degenerate output (${text.length} chars: "${text.slice(0, 60)}"); using fallback`);
      rec.recap = fallbackRecap(rec);
      rec.recap_source = "fallback";
      return;
    }
    rec.recap = text;
    rec.recap_source = "llm";
    rec.recap_model = RECAP_MODEL;
    console.log(`[recap] sim-day ${rec.sim_day} via ${RECAP_PROVIDER} — ${text.length} chars`);
  } catch (err) {
    console.warn("[recap] LLM call failed:", err?.message || err);
    rec.recap = fallbackRecap(rec);
    rec.recap_source = "fallback";
  }
};

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

  // Read the current needs for the perception block. Tickless here —
  // the global needs interval is already advancing values.
  const needsRec = needsTracker.get(rec.pubkey);
  const needsLine = needsRec ? describeNeeds(needsRec.needs) : "";

  // Mood line (#275) — derived from active moodlets. Independent of
  // the needs decay above; both blocks land in the user-turn prompt.
  const moodLine = describeMood(moodlets.aggregate(rec.pubkey));

  // Smart objects nearby (#245 slice 1) — surface what's within scene
  // radius so the LLM knows what's around. No `use` verb yet, but
  // characters can already mention or describe what they see.
  const nearbyObjects = objectsRegistry.nearby(myPresence.x ?? 0, myPresence.y ?? 0);

  const userTurn = buildUserTurn({
    character: { pubkey: rec.pubkey, x: myPresence.x ?? 0, y: myPresence.y ?? 0 },
    trigger,
    triggerContext,
    roomSnapshot: snapshot,
    lastSeenMessageTs: rec.lastSeenMessageTs,
    perceptionEvents,
    memoryBlock,
    needsLine,
    moodLine,
    nearbyObjects,
    seedMessage,
    // Sim-time anchor (#275 slice 2 follow-up). LLM gets a `When:`
    // line below the trigger with both real-time and sim-clock so
    // schedule decisions, "noon", "by evening" all ground correctly.
    simNow: simClock?.now?.(),
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

async function relayPost(agentId, content, modelTag, extraTags) {
  const rec = agents.get(agentId);
  if (!rec) throw new Error("unknown agent");
  const tags = [];
  if (modelTag) tags.push(["model", modelTag]);
  if (Array.isArray(extraTags)) {
    for (const t of extraTags) {
      if (Array.isArray(t) && t.every((x) => typeof x === "string")) tags.push(t);
    }
  }
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
// Default 100KB is too small for kimodo motion JSONs (~600-800KB) that
// the frontend PUTs to /v1/animations/:id when publishing. 4MB gives
// headroom for longer clips without inviting unbounded payloads.
app.use(express.json({ limit: "4mb" }));

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

// ── Moodlets (#275 slice 3) ──
//
// Per-character event-driven affect. Read endpoints are open; write
// endpoints (POST/DELETE) are intended for the storyteller / cards
// runtime and the dev-mode debug surface.

app.get("/health/moodlets", (_req, res) => {
  res.json(moodlets.snapshot());
});

// Demo seeder (must be registered BEFORE :pubkey routes so Express
// doesn't try to match "seed-demo" as a pubkey). Populates a curated
// mix of warm-skewed moodlets across all known characters; idempotent
// unless force=true.
//
// Body (all optional): { pubkeys?: string[], force?: boolean,
//                        minPerChar?: number, maxPerChar?: number }
// Curated visual-inspiration nudge — emits a sticky-ish moodlet
// whose `reason` reads like the character just noticed something
// worth photographing. The LLM picks this up on its next turn and
// (combined with the post verb's image_prompt arg) tends to choose
// to post an image about it. Used for testing the image-post flow
// without waiting on emergent behavior. Body { reason?: string }.
const VISUAL_INSPIRATION_REASONS = [
  "the morning light hit something on the table in a way she had to keep",
  "she noticed a quiet detail and her hands wanted to write it down with the camera, not the pen",
  "an ordinary thing looked, briefly, like a still life",
  "the angle was right; the angle is rarely right",
  "she caught a small composition out of the corner of her eye and kept looking back",
];
// Debug — emit a verb directly, bypassing the LLM. Used by the e2e
// suite when we want deterministic verbs (small models miss optional
// args like image_prompt or balk at follow/reply).
// Body: { pubkey, verb, args }.
app.post("/debug/verb", async (req, res) => {
  const { pubkey, verb, args } = req.body || {};
  if (!pubkey || !verb) return res.status(400).json({ error: "pubkey + verb required" });
  const active = activeRuntimeForCharacter(pubkey);
  if (!active) return res.status(400).json({ error: "character must be running" });
  const rec = active.rec;
  try {
    const snap = roomSnapshot(active.id);
    const result = await gm.dispatch(
      { agentId: active.id, pubkey: rec.pubkey, name: rec.name, model: rec.model, snapshot: snap },
      { verb, args: args || {} },
    );
    if (result.ok) {
      try { appendActionToSession(rec, result, snap); } catch {}
    }
    res.json(result);
  } catch (err) {
    console.error("[debug:verb] failed:", err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Debug — exercises the full image-post pipeline (FLUX → S3 → kind:1
// with NIP-94 imeta) without requiring the LLM to opt in via the
// image_prompt arg. Useful for verifying the wiring in isolation.
// Body: { pubkey, text, image_prompt }.
app.post("/debug/image-post", async (req, res) => {
  const { pubkey, text, image_prompt } = req.body || {};
  if (!pubkey || !text || !image_prompt) {
    return res.status(400).json({ error: "pubkey, text, image_prompt required" });
  }
  const active = activeRuntimeForCharacter(pubkey);
  if (!active) return res.status(400).json({ error: "character must be running (spawn first)" });
  try {
    const img = await generatePostImage({ pubkey, prompt: image_prompt });
    const content = `${text}\n\n${img.url}`;
    const imeta = ["imeta", `url ${img.url}`, `m ${img.mime}`, `x ${img.sha256}`];
    const event = await relayPost(active.id, content, "debug", [imeta]);
    res.json({
      event_id: event?.id,
      image: { url: img.url, mime: img.mime, sha256: img.sha256 },
      kind1_content: content,
      kind1_tags: event?.tags,
    });
  } catch (err) {
    console.error("[debug:image-post] failed:", err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/moodlets/:pubkey/inspire-image", (req, res) => {
  const pubkey = req.params.pubkey;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  const body = req.body || {};
  const reason = (typeof body.reason === "string" && body.reason.trim())
    || VISUAL_INSPIRATION_REASONS[Math.floor(Math.random() * VISUAL_INSPIRATION_REASONS.length)];
  const m = moodlets.emit(pubkey, {
    tag: "caught_a_visual",
    weight: 3,
    reason,
    source: "user",
    duration_ms: 2 * 60 * 60 * 1000, // 2 real-hours; fades naturally
  });
  if (!m) return res.status(400).json({ error: "rejected (unknown pubkey?)" });
  // Surface as a perception event too so the LLM sees it cleanly on
  // the next turn (the moodlet line + this hint together).
  perception.appendOne(pubkey, {
    kind: "moodlet_added",
    tag: m.tag,
    weight: m.weight,
    reason: m.reason || null,
  });
  res.status(201).json(m);
});

app.post("/moodlets/seed-demo", (req, res) => {
  const body = req.body || {};
  const targets = Array.isArray(body.pubkeys) && body.pubkeys.length > 0
    ? body.pubkeys
    : listCharacters().map((c) => c.pubkey);
  const out = seedDemoMoodlets(moodlets, targets, {
    force: !!body.force,
    minPerChar: Number.isFinite(body.minPerChar) ? body.minPerChar : undefined,
    maxPerChar: Number.isFinite(body.maxPerChar) ? body.maxPerChar : undefined,
  });
  res.json({
    seeded: out.filter((r) => !r.skipped).length,
    skipped: out.filter((r) => r.skipped).length,
    results: out,
  });
});

app.get("/moodlets/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  const active = moodlets.listActive(pubkey);
  const aggregate = moodlets.aggregate(pubkey);
  res.json({ pubkey, active, ...aggregate });
});

app.post("/moodlets/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  const body = req.body || {};
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  if (!body.tag) return res.status(400).json({ error: "tag required" });
  const m = moodlets.emit(pubkey, body);
  if (!m) return res.status(400).json({ error: "rejected" });
  // Mirror as a perception event so the LLM notices the mood change
  // on its next turn.
  perception.appendOne(pubkey, {
    kind: "moodlet_added",
    tag: m.tag,
    weight: m.weight,
    reason: m.reason || null,
  });
  res.status(201).json(m);
});

app.delete("/moodlets/:pubkey/:moodletId", (req, res) => {
  const ok = moodlets.remove(req.params.pubkey, req.params.moodletId);
  res.status(ok ? 204 : 404).end();
});

// ── Sim-clock + sessions (#275 slice 2) ──

app.get("/health/sim-clock", (_req, res) => {
  res.json(simClock.now());
});

app.get("/sessions", (_req, res) => {
  // Always include the in-flight session at the top of the list so
  // the UI can render "today" even before the first rollover.
  const open = sessions.current();
  const closed = sessions.listClosed({ limit: 50 });
  const all = open ? [open, ...closed] : closed;
  res.json({ sessions: all });
});

app.get("/sessions/:simDay", (req, res) => {
  const day = Number(req.params.simDay);
  if (!Number.isFinite(day)) return res.status(400).json({ error: "simDay must be numeric" });
  const rec = sessions.getBySimDay(day);
  if (!rec) return res.status(404).json({ error: "no session for that sim-day" });
  res.json(rec);
});

app.get("/health/sessions", (_req, res) => {
  res.json(sessions.snapshot());
});

// ── Image post log (#415) ───────────────────────────────────────────
//
// Aggregates every `kind: "post"` session event with an `image_url`
// across the open + closed sessions and exposes them newest-first
// for the Image Posts browser view.

function collectImagePosts() {
  const out = [];
  const all = [sessions.current(), ...sessions.listClosed({ limit: 200 })].filter(Boolean);
  for (const s of all) {
    for (const ev of s.events || []) {
      if (ev.kind !== "post" || !ev.image_url) continue;
      out.push({
        event_id: ev.event_id || null,
        actor_pubkey: ev.actor_pubkey,
        actor_name: ev.actor_name,
        text: ev.text || "",
        image_url: ev.image_url,
        image_prompt: ev.image_prompt || null,
        sim_iso: ev.sim_iso || null,
        sim_day: ev.sim_day ?? s.sim_day,
        ts: ev.ts || s.opened_at,
      });
    }
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

app.get("/image-posts", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cursor = Math.max(Number(req.query.cursor) || 0, 0);
  const all = collectImagePosts();
  const items = all.slice(cursor, cursor + limit);
  const nextCursor = cursor + items.length < all.length ? cursor + items.length : null;
  res.json({ items, total: all.length, nextCursor });
});

app.get("/image-posts/status", (_req, res) => {
  const all = collectImagePosts();
  const byCharacter = {};
  for (const p of all) {
    const k = p.actor_pubkey || "unknown";
    byCharacter[k] = (byCharacter[k] || 0) + 1;
  }
  res.json({
    count: all.length,
    latest_ts: all[0]?.ts || null,
    latest_actor_name: all[0]?.actor_name || null,
    latest_sim_iso: all[0]?.sim_iso || null,
    by_character: byCharacter,
  });
});

// ── Storyteller (#305) ──────────────────────────────────────────────
//
// Lets the UI watch the director and force fires for verification.
// /storyteller/snapshot returns intensity + per-card eligibility so
// the operator can see why a card is or isn't firing right now.

app.get("/storyteller/snapshot", (_req, res) => {
  res.json(buildStorytellerSnapshot({
    director,
    cardLoader,
    slot: simClock.currentSlot?.(),
    characterCount: listInRoomPubkeys().length,
    loadErrors: _cardLoadResult.errors,
  }));
});

app.get("/storyteller/cards", (_req, res) => {
  res.json({ cards: cardLoader.listAll() });
});

app.get("/storyteller/log", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  if (!existsSync(DIRECTOR_LOG_PATH)) return res.json({ entries: [] });
  let text;
  try { text = readFileSync(DIRECTOR_LOG_PATH, "utf-8"); }
  catch (err) { return res.status(500).json({ error: err?.message || String(err) }); }
  const lines = text.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-limit);
  const entries = [];
  for (const line of tail) {
    try { entries.push(JSON.parse(line)); }
    catch { /* skip malformed */ }
  }
  // Newest first.
  entries.reverse();
  res.json({ entries, total: lines.length });
});

app.post("/storyteller/tick", async (_req, res) => {
  if (listInRoomPubkeys().length === 0) {
    return res.status(409).json({ error: "no characters in the room — director can't bind roles" });
  }
  const slot = simClock.currentSlot?.();
  const phase = phaseForSimSlot(slot);
  try {
    const r = await director.tick({ phases: new Set([phase]) });
    res.json({ ok: true, phase, ...r });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/storyteller/fire", async (req, res) => {
  const cardId = String(req.body?.card_id || "");
  if (!cardId) return res.status(400).json({ error: "card_id required" });
  const card = cardLoader.get(cardId);
  if (!card) return res.status(404).json({ error: `unknown card "${cardId}"` });
  if (listInRoomPubkeys().length === 0) {
    return res.status(409).json({ error: "no characters in the room — can't bind roles" });
  }
  try {
    const result = await director.fireCard(card, { roleBindings: req.body?.role_bindings, source: "manual" });
    res.json({ ok: result.ok !== false, card_id: cardId, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/storyteller/reset-session", (_req, res) => {
  director.onSessionOpen();
  res.json({ ok: true });
});

// Dev-only: fast-forward the sim-clock to the next sim-day rollover
// so the session machinery + recap pipeline can be exercised on
// demand. Body: { simHours?: number } — default 24 (one full day).
app.post("/sessions/advance", async (req, res) => {
  const simHours = Number(req.body?.simHours);
  const minutes = Number.isFinite(simHours) && simHours > 0 ? simHours * 60 : 24 * 60;
  simClock.advance(minutes * 60_000);
  await sessions.ensureOpen();
  res.json({ now: simClock.now(), opened: sessions.current() });
});

// Live cadence control. Body { simMinutePerRealMs: number } — the
// cadence is preserved across restart via $WORKSPACE/sim-clock.json.
// Re-anchors the origin so sim-time at the moment of change is
// continuous; only the future drift rate flips.
app.post("/sim-clock/cadence", (req, res) => {
  const v = Number(req.body?.simMinutePerRealMs);
  if (!Number.isFinite(v) || v <= 0) {
    return res.status(400).json({ error: "simMinutePerRealMs must be a positive number" });
  }
  const snap = simClock.setCadence(v);
  if (!snap) return res.status(400).json({ error: "rejected" });
  res.json(snap);
});

// Inject synthetic scene_close events into the open session so a
// forced rollover produces a meaningful recap. Cycles through a
// curated set so each call adds three different beats — useful for
// demo/testing the recap voice without waiting on real LLM scenes.
const SEED_EVENTS_TEMPLATES = [
  { participants: ["Cleo", "Bo"], end_reason: "soft_stop", last_actor: "Cleo",
    last_line: "you don't have to keep doing that.",
    moodlets: [{ name: "Cleo", weight: +3, reason: "Bo finally sat with her" },
               { name: "Bo",   weight: +3, reason: "Cleo let him in for a moment" }] },
  { participants: ["Maya", "Tomek"], end_reason: "budget", last_actor: "Tomek",
    last_line: "alright, fine. I'll go.",
    moodlets: [{ name: "Maya",  weight: +2, reason: "convinced Tomek not to make it weird" },
               { name: "Tomek", weight: -2, reason: "lost the morning to a conversation he didn't want" }] },
  { participants: ["Felix", "Eira"], end_reason: "proximity_lost", last_actor: "Eira",
    last_line: "I'll bring tea later.",
    moodlets: [{ name: "Eira",  weight: +1, reason: "brief warmth with Felix" },
               { name: "Felix", weight: +2, reason: "Eira said something kind, sideways" }] },
];

app.post("/sessions/seed-events", (_req, res) => {
  const cur = sessions.current();
  if (!cur) return res.status(400).json({ error: "no open session" });
  // Build synthetic events. We don't have real participant pubkeys
  // for these names; the recap pipeline tolerates that — the LLM gets
  // names directly via last_actor_name / participants in the digest.
  for (const t of SEED_EVENTS_TEMPLATES) {
    const fakePub = (n) => `seed:${n.toLowerCase()}`;
    sessions.appendEvent({
      kind: "scene_close",
      scene_id: `seeded_${Date.now()}_${t.participants.join("_")}`,
      participants: t.participants.map(fakePub),
      participant_names: t.participants.slice(),
      end_reason: t.end_reason,
      last_line: t.last_line,
      last_actor_name: t.last_actor,
      moodlets: t.moodlets.map((m) => ({
        pubkey: fakePub(m.name),
        actor_name: m.name,
        tag: `seeded:${m.name.toLowerCase()}`,
        weight: m.weight,
        reason: m.reason,
      })),
    });
  }
  res.json({ injected: SEED_EVENTS_TEMPLATES.length, session: cur.id, event_count: cur.events.length });
});

// Read the per-character perception buffer. Useful for tests + the
// inspector when we need to see which events the LLM saw on its last
// turn(s). Optional `since` query filters to events newer than the
// given ms epoch.
app.get("/perception/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });
  const since = Number(req.query.since);
  const events = Number.isFinite(since)
    ? perception.eventsSince(pubkey, since)
    : perception.snapshot(pubkey);
  res.json({ pubkey, count: events.length, events });
});

// ── Rooms (#285 phase A) ──
//
// Named regions on the existing tile grid. Read-only via HTTP for
// now; ownership is bound at character create time. Locked rooms
// and unlocks come in phase C.

app.get("/rooms", (_req, res) => {
  res.json(roomsRegistry.snapshot());
});

app.get("/rooms/:id", (req, res) => {
  const room = roomsRegistry.get(req.params.id);
  if (!room) return res.status(404).json({ error: "unknown room" });
  res.json(room);
});

// ── Schedules (#235 reshape — coarse 4-slot timetables) ──
//
// Per-character `slot → room_id` overrides; absent slots fall back
// to the default timetable. The mover tick uses these to route
// characters into shared rooms at shared times.

app.get("/schedules", (req, res) => {
  // Default: snapshot every character. Pass ?pubkey=foo&pubkey=bar to filter.
  const requested = [].concat(req.query.pubkey ?? []).filter(Boolean);
  const list = requested.length > 0
    ? requested
    : listCharacters().map((c) => c.pubkey);
  res.json({ schedules: schedules.snapshot(list), slots: SCHEDULE_SLOTS });
});

app.get("/schedules/:pubkey", (req, res) => {
  const tt = schedules.timetableFor(req.params.pubkey);
  res.json({ pubkey: req.params.pubkey, effective: tt });
});

app.patch("/schedules/:pubkey", (req, res) => {
  const body = req.body || {};
  if (body.slot && (typeof body.room_id === "string" || body.room_id === null)) {
    const out = schedules.setSlot(req.params.pubkey, body.slot, body.room_id);
    if (!out) return res.status(400).json({ error: "invalid slot or pubkey" });
    return res.json({ pubkey: req.params.pubkey, effective: out });
  }
  if (body.timetable && typeof body.timetable === "object") {
    const out = schedules.setTimetable(req.params.pubkey, body.timetable);
    if (!out) return res.status(400).json({ error: "invalid pubkey or timetable" });
    return res.json({ pubkey: req.params.pubkey, effective: out });
  }
  res.status(400).json({ error: "expected { slot, room_id } or { timetable }" });
});

app.get("/health/schedules", (_req, res) => {
  // Sim-time-driven (#275 slice 2): slot derives from sim-clock, not
  // the bridge's wall-clock. The frontend AgentSchedule reads from
  // here so its "current slot" matches what the schedule mover uses.
  const sim = simClock.now();
  const targets = listCharacters().map((c) => ({
    pubkey: c.pubkey,
    name: c.name,
    slot: sim.slot,
    target_room: schedules.targetRoomFor(c.pubkey, sim.slot),
  }));
  res.json({ hour: sim.sim_hour, slot: sim.slot, sim_day: sim.sim_day, sim_iso: sim.sim_iso, targets });
});

// ── Smart objects (#245 slice 1) ──
//
// Read-only listing + placement endpoints. Slice 2 adds the `use`
// verb that consumes affordances.

app.get("/objects/types", (_req, res) => {
  // Public type registry — lets the UI render a picker without
  // duplicating the schema.
  const out = {};
  for (const [id, def] of Object.entries(OBJECT_TYPES)) {
    out[id] = {
      description: def.description,
      capacity: def.capacity === Infinity ? null : def.capacity,
      glyph: def.glyph,
      affordances: def.affordances.map((a) => ({ verb: a.verb })),
    };
  }
  res.json({ types: out });
});

app.get("/objects", (req, res) => {
  if (req.query.near) {
    const [xStr, yStr] = String(req.query.near).split(",");
    const x = Number(xStr); const y = Number(yStr);
    const radius = req.query.radius ? Number(req.query.radius) : 3;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "near must be 'x,y'" });
    }
    return res.json({ objects: objectsRegistry.nearby(x, y, radius) });
  }
  res.json({ objects: objectsRegistry.listAll() });
});

app.get("/objects/:id", (req, res) => {
  const obj = objectsRegistry.get(req.params.id);
  if (!obj) return res.status(404).json({ error: "object not found" });
  res.json(obj);
});

app.post("/objects", (req, res) => {
  try {
    const { type, x, y, state } = req.body || {};
    const inst = objectsRegistry.placeOne({ type, x, y, state });
    res.json(inst);
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.delete("/objects/:id", (req, res) => {
  const ok = objectsRegistry.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: "object not found" });
  res.json({ ok: true });
});

app.get("/health/objects", (_req, res) => {
  res.json(objectsRegistry.snapshot());
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

// ── Editable system prompts ──
// Currently exposes a single overridable prompt: npc-persona, used by
// the persona generator when a character has kind:'npc'. Saving an
// override writes a text file under <WORKSPACE>/prompts/; the next
// generate call reads it. Reset returns to the in-source default.

app.get("/v1/prompts/:name", (req, res) => {
  const name = req.params.name;
  if (!PROMPT_REGISTRY.has(name)) return res.status(404).json({ error: "unknown prompt" });
  res.json({
    name,
    text: loadPrompt(name),
    default: PROMPT_REGISTRY.get(name),
    overridden: isPromptOverridden(name),
  });
});

app.put("/v1/prompts/:name", (req, res) => {
  const name = req.params.name;
  if (!PROMPT_REGISTRY.has(name)) return res.status(404).json({ error: "unknown prompt" });
  const text = req.body?.text;
  if (typeof text !== "string") return res.status(400).json({ error: "text required (string)" });
  if (text.length > 16000) return res.status(400).json({ error: "text too long (max 16k chars)" });
  // Empty body means "use the default" — same effect as DELETE.
  if (!text.trim()) clearPromptOverride(name);
  else savePromptOverride(name, text);
  res.json({
    name,
    text: loadPrompt(name),
    default: PROMPT_REGISTRY.get(name),
    overridden: isPromptOverridden(name),
  });
});

app.delete("/v1/prompts/:name", (req, res) => {
  const name = req.params.name;
  if (!PROMPT_REGISTRY.has(name)) return res.status(404).json({ error: "unknown prompt" });
  clearPromptOverride(name);
  res.json({
    name,
    text: loadPrompt(name),
    default: PROMPT_REGISTRY.get(name),
    overridden: false,
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

// ── External services (flux-kontext, trellis, hunyuan3d, unirig) ──
//
// Surface the per-service state cache from service-state.js. Three
// shapes:
//   GET  /v1/services                  list all (sidebar dots fetch this)
//   GET  /v1/services/:name/status     single-service snapshot
//   POST /v1/services/:name/wake       SSE-streamed warmup; idempotent
//                                      via single-flight in service-state.

app.get("/v1/services", (_req, res) => {
  res.json({ services: services.snapshotAll() });
});

app.get("/v1/services/:name/status", (req, res) => {
  const snap = services.snapshot(req.params.name);
  if (!snap) return res.status(404).json({ error: `unknown service '${req.params.name}'` });
  res.json(snap);
});

app.post("/v1/services/:name/wake", async (req, res) => {
  const name = req.params.name;
  if (!SERVICE_REGISTRY[name]) {
    return res.status(404).json({ error: `unknown service '${name}'` });
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const startedAt = Date.now();
  try {
    const result = await services.ensureWarm(name, {
      onStage: (s) => send("stage", s),
      onHeartbeat: (hb) => send("heartbeat", hb),
    });
    send("done", {
      ...result,
      service: name,
      elapsedMs: Date.now() - startedAt,
      snapshot: services.snapshot(name),
    });
  } catch (err) {
    console.error(`[services:${name}:wake]`, err.message);
    send("error", { error: err.message, service: name });
  } finally {
    res.end();
  }
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

app.get("/characters", (req, res) => {
  // Optional `?kind=npc|player` filter — Shelter pulls NPCs only on
  // mount, the sandbox usually wants everything. Unknown values fall
  // through to the unfiltered list rather than 400ing.
  const wantKind = typeof req.query.kind === "string" ? req.query.kind : null;
  let list = listCharacters().map((c) => ({
    ...c,
    runtime: runtimeSnapshot(c.pubkey),
  }));
  if (wantKind === "npc" || wantKind === "player") {
    list = list.filter((c) => (c.kind ?? "player") === wantKind);
  }
  res.json({ characters: list });
});

app.post("/characters", (req, res) => {
  try {
    const { name, kind, npc_role, npc_default_pos, shift_start, shift_end } = req.body || {};
    const c = createCharacter({
      name,
      kind,
      npc_role,
      npc_default_pos,
      shift_start,
      shift_end,
    });
    res.json({
      pubkey: c.pubkey,
      npub: npubEncode(c.pubkey),
      name: c.name,
      kind: c.kind ?? "player",
      npc_role: c.npc_role ?? null,
      npc_default_pos: c.npc_default_pos ?? null,
      shift_start: c.shift_start ?? null,
      shift_end: c.shift_end ?? null,
      createdAt: c.createdAt,
    });
  } catch (err) {
    // Validation / uniqueness errors → 4xx; everything else → 500.
    const status = err.statusCode ?? (
      /^npc_|kind must be|must be 0\.\.|must be a number/.test(err.message) ? 400 : 500
    );
    if (status >= 500) console.error("[char:create]", err);
    res.status(status).json({ error: err.message });
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
    // Default legacy records to 'player' so consumers can rely on the
    // field always being present.
    kind: c.kind ?? "player",
    starter: !!c.starter,
    npc_role: c.npc_role ?? null,
    npc_default_pos: c.npc_default_pos ?? null,
    shift_start: c.shift_start ?? null,
    shift_end: c.shift_end ?? null,
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

app.get("/characters/:pubkey/tpose", async (req, res) => {
  const pubkey = req.params.pubkey;
  const dir = getCharDir(pubkey);
  const path = join(dir, "tpose.png");
  if (existsSync(path)) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return createReadStream(path).pipe(res);
  }
  res.status(404).json({ error: "no tpose" });
});

app.get("/characters/:pubkey/model", async (req, res) => {
  const pubkey = req.params.pubkey;
  const dir = getCharDir(pubkey);
  const path = join(dir, "model.glb");
  if (existsSync(path)) {
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return createReadStream(path).pipe(res);
  }
  res.status(404).json({ error: "no model" });
});

// UniRig output (Phase 2) — saved by /generate-rig/stream after the
// `rigging` stage. Defaults to the palms-down baked variant once
// kimodo-tools has finalised it (Phase 3); falls back to the raw
// UniRig rig.glb between stages. Pass ?variant=raw to force the
// pre-bake mesh.
app.get("/characters/:pubkey/rig", async (req, res) => {
  const pubkey = req.params.pubkey;
  const dir = getCharDir(pubkey);
  const variant = String(req.query.variant || "").toLowerCase();
  const palms = join(dir, "rig_palmsdown.glb");
  const raw = join(dir, "rig.glb");
  const preferPalms = variant !== "raw";
  const path = preferPalms && existsSync(palms) ? palms
             : existsSync(raw) ? raw
             : null;
  if (!path) return res.status(404).json({ error: "no rig" });
  res.setHeader("Content-Type", "model/gltf-binary");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return createReadStream(path).pipe(res);
});

// Bone mapping derived by kimodo-tools' unirig_mapping.py — the same
// table embedded in the kimodo registry record. Returned as JSON so
// a GlbViewer can attach a KimodoAnimator to the rigged skinned mesh.
app.get("/characters/:pubkey/rig-mapping", async (req, res) => {
  const pubkey = req.params.pubkey;
  const dir = getCharDir(pubkey);
  const path = join(dir, "rig_mapping.json");
  if (existsSync(path)) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return createReadStream(path).pipe(res);
  }
  res.status(404).json({ error: "no rig mapping" });
});

// Kimodo motion-JSON serving — proxy from S3 so the prod frontend
// can resolve user-published motion ids without reaching the kimodo
// motion API directly (it's GPU-bound and runs on dev machines, not
// on Railway). Built-ins still ship as static `/animations/<id>.json`
// in the frontend's public/ directory; this route is the
// user-published fallback for everything else. Idempotent immutable
// cache headers — kimodo motion ids are content-addressed.
app.get("/v1/animations/:id", async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{8,32}$/i.test(id)) {
    return res.status(400).json({ error: "bad animation id" });
  }
  if (!s3.s3Configured) return res.status(503).json({ error: "S3 not configured" });
  try {
    const out = await s3.getAnimationStream(id);
    if (!out) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", out.contentType || "application/json");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    out.body.pipe(res);
  } catch (err) {
    console.error(`[v1/animations] ${id}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// PUT /v1/animations/:id — accepts a kimodo motion JSON body and
// uploads it to S3. The Animations tab calls this directly with the
// motion data the frontend already has cached, so no kimodo round
// trip happens server-side. Validates payload shape so junk doesn't
// poison the cache. Idempotent (PUT + immutable cache).
app.put("/v1/animations/:id", express.json({ limit: "5mb" }), async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{8,32}$/i.test(id)) {
    return res.status(400).json({ error: "bad animation id" });
  }
  if (!s3.s3Configured) return res.status(503).json({ error: "S3 not configured" });
  const body = req.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.bone_names)) {
    return res.status(400).json({ error: "not a kimodo motion (missing bone_names)" });
  }
  try {
    const buf = Buffer.from(JSON.stringify(body));
    await s3.putAnimation(id, buf);
    res.json({
      id,
      sizeKb: Math.round(buf.length / 1024),
      publishedAt: Date.now(),
    });
  } catch (err) {
    console.error(`[v1/animations:put] ${id}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /v1/animations — list of published animation ids. Drives the
// "Published" badge in the Animations tab.
app.get("/v1/animations", async (req, res) => {
  if (!s3.s3Configured) return res.json({ animations: [] });
  try {
    const animations = await s3.listAnimations();
    res.json({ animations });
  } catch (err) {
    console.error(`[v1/animations:list]`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// Tag map — single-tenant key/value of tag → animation id. Replaces
// per-browser localStorage so prod + dev share the same map. Stored
// as `tags.json` in the bucket. Shape:
//   { tags: string[], assignments: Record<string, string> }
app.get("/v1/tags", async (_req, res) => {
  if (!s3.s3Configured) return res.json({ tags: [], assignments: {} });
  try {
    const map = await s3.getTagMap();
    res.json(map ?? { tags: [], assignments: {} });
  } catch (err) {
    console.error(`[v1/tags:get]`, err.message);
    res.status(502).json({ error: err.message });
  }
});

app.put("/v1/tags", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.tags)
      || typeof body.assignments !== "object"
      || body.assignments === null) {
    return res.status(400).json({ error: "expected { tags: string[], assignments: Record<string,string> }" });
  }
  if (!s3.s3Configured) return res.status(503).json({ error: "S3 not configured" });
  try {
    // Normalize: strip non-string assignments.
    const clean = {
      tags: body.tags.filter((t) => typeof t === "string"),
      assignments: Object.fromEntries(
        Object.entries(body.assignments).filter(([_, v]) => typeof v === "string")
      ),
    };
    await s3.putTagMap(clean);
    res.json(clean);
  } catch (err) {
    console.error(`[v1/tags:put]`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// Publish an NPC's full content (manifest + sk + assets) from the
// bridge's local workspace dir to S3. After this, prod's bridge
// boot pulls the NPC into its own workspace from the S3 keyspace —
// no git commit / push, no seed-npcs/ directory. Idempotent.
app.post("/v1/npcs/:pubkey/publish", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "character not found" });
  if ((c.kind ?? "player") !== "npc") {
    return res.status(400).json({ error: "not an NPC" });
  }
  if (!c.npc_role || !c.npc_default_pos) {
    return res.status(400).json({ error: "NPC needs npc_role + npc_default_pos before publishing" });
  }
  if (!s3.s3Configured) return res.status(503).json({ error: "S3 not configured" });

  const npub = npubEncode(pubkey);
  const dir = getCharDir(pubkey);

  try {
    // Strip avatarUrl from the manifest before publishing — it carries
    // whatever bridge origin generated it (often a LAN IP). The seeder
    // synthesises a fresh URL from PUBLIC_BRIDGE_URL on each install.
    const manifestPath = join(dir, "agent.json");
    const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const cleanManifest = { ...manifestRaw };
    delete cleanManifest.avatarUrl;
    await s3.putNpcAsset(npub, "agent.json", Buffer.from(JSON.stringify(cleanManifest, null, 2)), "application/json");

    // sk.hex
    const skPath = join(dir, "sk.hex");
    if (!existsSync(skPath)) throw new Error("sk.hex missing");
    await s3.putNpcAsset(npub, "sk.hex", readFileSync(skPath), "text/plain");

    // Heavy assets — best-effort, all tolerated as missing.
    const ASSETS = [
      ["avatar.png", "image/png"],
      ["avatar.jpg", "image/jpeg"],
      ["avatar.jpeg", "image/jpeg"],
      ["avatar.webp", "image/webp"],
      ["tpose.png", "image/png"],
      ["model.glb", "model/gltf-binary"],
      ["rig.glb", "model/gltf-binary"],
      ["rig_palmsdown.glb", "model/gltf-binary"],
      ["rig_mapping.json", "application/json"],
      ["kimodo.json", "application/json"],
    ];
    const uploaded = [];
    const skipped = [];
    for (const [filename, mime] of ASSETS) {
      const path = join(dir, filename);
      if (!existsSync(path)) { skipped.push(filename); continue; }
      await s3.putNpcAsset(npub, filename, readFileSync(path), mime);
      uploaded.push({ filename, sizeKb: Math.round(statSync(path).size / 1024) });
    }
    res.json({ pubkey, npub, name: c.name, uploaded, skipped });
  } catch (err) {
    console.error(`[v1/npcs:publish] ${pubkey}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// Post-image serving (#355). Filename pattern: <shortId>.<ext>.
// Prefers S3 when configured; falls back to disk under the character
// dir for local dev. Immutable URLs — no cache-buster needed.
app.get("/posts/:pubkey/:filename", async (req, res) => {
  const pubkey = req.params.pubkey;
  const m = String(req.params.filename || "").match(/^([a-f0-9]{8,40})\.(jpe?g|png|webp|gif)$/i);
  if (!m) return res.status(400).json({ error: "bad filename" });
  const shortId = m[1];
  const ext = m[2].toLowerCase();
  if (s3.s3Configured) {
    try {
      const { body, contentType } = await s3.getPostImageStream(pubkey, shortId, ext);
      res.setHeader("Content-Type", contentType || `image/${ext}`);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return body.pipe(res);
    } catch (err) {
      console.error(`[post-image:s3] ${pubkey.slice(0, 12)} ${shortId} — ${err?.message}`);
    }
  }
  const dir = getCharDir(pubkey);
  const path = join(dir, `post-${shortId}.${ext}`);
  if (existsSync(path)) {
    const mime =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "webp" ? "image/webp" :
      ext === "png" ? "image/png" :
      ext === "gif" ? "image/gif" : "image/jpeg";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return createReadStream(path).pipe(res);
  }
  res.status(404).json({ error: "no post image" });
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
    const { promptOverride, seed } = req.body || {};
    const { avatarUrl, prompt } = await generateAvatar({
      pubkey,
      name: c.name,
      about: c.about,
      promptOverride,
      seed,
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

app.post("/characters/:pubkey/generate-tpose", apiQuota.middleware, async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    return res.status(404).json({ error: "not found" });
  }
  try {
    const { tposeUrl } = await generateTpose({ pubkey });
    apiQuota.recordSuccess();
    res.json({ tposeUrl });
  } catch (err) {
    apiQuota.refund();
    console.error("[char:tpose]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// SSE variant — emits stage transitions and heartbeats so the client
// can show elapsed time and warn the user about Cloud Run cold-starts
// (the NIM downloads ~30 GB of weights from NGC on every cold boot).
app.post("/characters/:pubkey/generate-tpose/stream", apiQuota.middleware, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    send("error", { error: "not found" });
    return res.end();
  }

  let heartbeat = null;
  let endInflight = null;
  try {
    if (!FLUX_KONTEXT_URL) throw new Error("FLUX_KONTEXT_URL not configured");
    const avatar = readAvatarBytesFromDisk(pubkey);
    if (!avatar) throw new Error("character has no avatar yet — generate one first");

    const base = FLUX_KONTEXT_URL.replace(/\/$/, "");
    send("stage", { stage: "probing", message: "checking flux-kontext service" });

    // Single-flight warmup — concurrent SSE flows share one probe loop
    // via the per-service emitter inside ensureWarm.
    await services.ensureWarm("flux-kontext", {
      onStage: (s) => send("stage", s),
      onHeartbeat: (hb) => send("heartbeat", hb),
    });
    const tposeCall = services.startCall("flux-kontext", {
      pubkey,
      characterName: c.name,
      kind: "tpose",
      prompt: TPOSE_PROMPT,
    });
    endInflight = (info = {}) => tposeCall.end(info);

    const startedAt = Date.now();
    send("stage", { stage: "generating", message: "generating t-pose", startedAt });
    heartbeat = setInterval(() => {
      send("heartbeat", { elapsedMs: Date.now() - startedAt });
    }, 5000);

    // Build [avatar | reference] side-by-side composite as the input.
    // Kontext doesn't preserve the layout in its output — it produces a
    // single full-figure T-pose centered on the canvas, drawing identity
    // from the avatar half and pose/anatomy from the reference half. So
    // we save the full response (no cropping); the result is already a
    // standalone character image at the canvas's aspect ratio.
    const composite = await buildTposeComposite(avatar.buffer, avatar.mime);
    const dataUri = `data:${composite.mime};base64,${composite.buffer.toString("base64")}`;

    // Retry on safety blocks. Flux returns a ~6KB near-uniform JPEG when
    // its safety filter trips on a particular seed. Probing showed ~80%
    // of random seeds clear the filter cleanly, so 3 attempts effectively
    // never fails. We re-roll the seed each attempt; the prompt and
    // composite stay constant.
    //
    // The whole retry loop runs inside withSerializedCall so a caller
    // owns the upstream Cloud Run instance for all 3 attempts. Cloud
    // Run is concurrency=1 — interleaving callers would just trade
    // safety-block 429s for "no available instance" 429s.
    let buffer = null;
    let lastBytes = 0;
    await services.withSerializedCall("flux-kontext", async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`${base}/v1/infer`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            prompt: TPOSE_PROMPT,
            image: dataUri,
            seed: Math.floor(Math.random() * 2_147_483_647),
            steps: 30,
            aspect_ratio: TPOSE_ASPECT_RATIO,
            resize_response_image: false,
            cfg_scale: TPOSE_CFG_SCALE,
          }),
        });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          throw new Error(`flux-kontext ${r.status}: ${body.slice(0, 200)}`);
        }
        const data = await r.json();
        const b64 = data.artifacts?.[0]?.base64;
        if (!b64) throw new Error("flux-kontext returned no image");
        const buf = Buffer.from(b64, "base64");
        lastBytes = buf.length;
        if (buf.length >= 15_000) {
          buffer = buf;
          return;
        }
        console.warn(`[char:tpose:stream] attempt ${attempt + 1}: ${buf.length}B — safety-blocked, retrying with new seed`);
      }
    }, {
      onQueued: ({ queuedAt }) => send("stage", {
        stage: "queued", message: "another flux-kontext call in progress; queued",
      }),
      onAcquired: ({ waitMs }) => {
        if (waitMs > 0) send("stage", {
          stage: "acquired", message: `acquired flux-kontext after ${Math.round(waitMs / 1000)}s wait`,
        });
      },
    });
    if (!buffer) {
      throw new Error(
        `flux-kontext kept returning safety-blocked images (last: ${lastBytes}B) after 3 attempts`
      );
    }
    const dir = getCharDir(pubkey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tpose.png"), buffer);

    apiQuota.recordSuccess();
    if (endInflight) endInflight({ ok: true, bytes: buffer.length });
    endInflight = null;
    send("done", {
      tposeUrl: `${PUBLIC_BRIDGE_URL}/characters/${pubkey}/tpose?t=${Date.now()}`,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    apiQuota.refund();
    console.error("[char:tpose:stream]", err.message);
    if (endInflight) endInflight({ ok: false, error: err.message });
    endInflight = null;
    send("error", { error: err.message });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (endInflight) endInflight({ ok: false, error: "stream terminated unexpectedly" });
    res.end();
  }
});

// SSE 3D-model generation. Reads the saved T-pose, calls Trellis,
// writes model.glb. Same staging/heartbeat pattern as the T-pose flow:
// probe → optional cold-start poll → generate → done. Trellis cold
// starts run 5–10 min; warm calls are 20–30 s.
// Mesh-generation backend dispatch. Each backend is its own callable
// that takes the t-pose buffer + an SSE `send` callback and returns
// the GLB bytes. Differences between backends:
//   trellis    NIM /v1/infer, data-URI image, JSON {artifacts[0].base64}
//   hunyuan3d  Tencent /generate, bare-base64 image, binary GLB body
async function callTrellisMesh({ tpose, send }) {
  if (!TRELLIS_URL) throw new Error("TRELLIS_URL not configured");
  const base = TRELLIS_URL.replace(/\/$/, "");
  send("stage", { stage: "probing", message: "checking trellis service" });

  await services.ensureWarm("trellis", {
    onStage: (s) => send("stage", s),
    onHeartbeat: (hb) => send("heartbeat", hb),
  });

  const startedAt = Date.now();
  send("stage", { stage: "generating", message: "generating 3D model (trellis)", startedAt, backend: "trellis" });

  // Cloud Run trellis is concurrency=1 max-instances=1; serialize at
  // the bridge so concurrent SSE flows queue here instead of hitting
  // upstream and getting 429 "no available instance".
  const dataUri = `data:${tpose.mime};base64,${tpose.buffer.toString("base64")}`;
  const buf = await services.withSerializedCall("trellis", async () => {
    const r = await fetch(`${base}/v1/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        image: dataUri,
        seed: Math.floor(Math.random() * 2_147_483_647),
        output_format: "glb",
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`trellis ${r.status}: ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const b64 = data.artifacts?.[0]?.base64;
    if (!b64) throw new Error("trellis returned no artifact");
    return Buffer.from(b64, "base64");
  }, {
    onQueued: () => send("stage", {
      stage: "queued", message: "another trellis call in progress; queued",
    }),
    onAcquired: ({ waitMs }) => {
      if (waitMs > 0) send("stage", {
        stage: "acquired", message: `acquired trellis after ${Math.round(waitMs / 1000)}s wait`,
      });
    },
  });
  return { buffer: buf, startedAt };
}

async function callHunyuan3dMesh({ tpose, send }) {
  if (!HUNYUAN3D_URL) throw new Error("HUNYUAN3D_URL not configured");
  const base = HUNYUAN3D_URL.replace(/\/$/, "");
  send("stage", { stage: "probing", message: "checking hunyuan3d service" });

  await services.ensureWarm("hunyuan3d", {
    onStage: (s) => send("stage", s),
    onHeartbeat: (hb) => send("heartbeat", hb),
  });

  const startedAt = Date.now();
  send("stage", { stage: "generating", message: "generating 3D model (hunyuan3d)", startedAt, backend: "hunyuan3d" });

  // Cloud Run hunyuan3d is concurrency=1; serialize at the bridge.
  const buf = await services.withSerializedCall("hunyuan3d", async () => {
    // Hunyuan3d expects a bare base64 string, NOT a data URI.
    const r = await fetch(`${base}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: tpose.buffer.toString("base64"),
        seed: Math.floor(Math.random() * 2_147_483_647),
        texture: true,
        octree_resolution: 256,
        num_inference_steps: 5,
        guidance_scale: 5.0,
        type: "glb",
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`hunyuan3d ${r.status}: ${body.slice(0, 200)}`);
    }
    // Hunyuan upstream returns the GLB directly as the body. It also
    // signals all internal failures via HTTP 404 with JSON body
    // {"error_code": 1, "text": "..."} — surface that distinctly so
    // we don't confuse it with routing 404s.
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = await r.json().catch(() => null);
      if (body?.error_code === 1) {
        throw new Error(`hunyuan3d internal failure: ${body.text || "unknown"} (check Cloud Run logs)`);
      }
      throw new Error(`hunyuan3d returned JSON instead of GLB: ${JSON.stringify(body).slice(0, 200)}`);
    }
    const ab = await r.arrayBuffer();
    if (!ab.byteLength) throw new Error("hunyuan3d returned empty body");
    return Buffer.from(ab);
  }, {
    onQueued: () => send("stage", {
      stage: "queued", message: "another hunyuan3d call in progress; queued",
    }),
    onAcquired: ({ waitMs }) => {
      if (waitMs > 0) send("stage", {
        stage: "acquired", message: `acquired hunyuan3d after ${Math.round(waitMs / 1000)}s wait`,
      });
    },
  });
  return { buffer: buf, startedAt };
}

const MESH_BACKENDS = {
  trellis: callTrellisMesh,
  hunyuan3d: callHunyuan3dMesh,
};

// Auto-rig a GLB via the local UniRig service. Mirrors the mesh
// backends' shape: emits stage events for probing/cold-start/warm,
// then POSTs `model.glb` as multipart/form-data to `${UNIRIG_URL}/rig`
// and returns the rigged GLB bytes.
async function callUniRigService({ modelBytes, send }) {
  if (!UNIRIG_URL) throw new Error("UNIRIG_URL not configured");
  const base = UNIRIG_URL.replace(/\/$/, "");

  send("stage", { stage: "probing", message: "checking unirig service" });
  await services.ensureWarm("unirig", {
    onStage: (s) => send("stage", s),
    onHeartbeat: (hb) => send("heartbeat", hb),
  });

  const startedAt = Date.now();
  send("stage", { stage: "rigging", message: "auto-rigging via UniRig", startedAt });

  // UniRig is concurrency=1 in our deployment; serialize at the
  // bridge so concurrent rig requests queue here instead of
  // hitting upstream.
  const buf = await services.withSerializedCall("unirig", async () => {
    const form = new FormData();
    form.append("file", new Blob([modelBytes]), "model.glb");
    const r = await fetch(`${base}/rig`, { method: "POST", body: form });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`unirig ${r.status}: ${body.slice(0, 200)}`);
    }
    const ab = await r.arrayBuffer();
    if (!ab.byteLength) throw new Error("unirig returned empty body");
    return Buffer.from(ab);
  }, {
    onQueued: () => send("stage", {
      stage: "queued", message: "another unirig call in progress; queued",
    }),
    onAcquired: ({ waitMs }) => {
      if (waitMs > 0) send("stage", {
        stage: "acquired", message: `acquired unirig after ${Math.round(waitMs / 1000)}s wait`,
      });
    },
  });
  return { buffer: buf, startedAt };
}

app.post("/characters/:pubkey/generate-model/stream", apiQuota.middleware, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    send("error", { error: "not found" });
    return res.end();
  }

  // Backend selector — defaults to trellis for back-compat with the
  // existing UI which doesn't yet send a body.
  const backend = (req.body?.backend ?? "trellis").toLowerCase();
  const backendFn = MESH_BACKENDS[backend];
  if (!backendFn) {
    apiQuota.refund();
    send("error", { error: `unknown backend '${backend}' (want one of: ${Object.keys(MESH_BACKENDS).join(", ")})` });
    return res.end();
  }

  let heartbeat = null;
  let endInflight = null;
  try {
    const tpose = readTposeBytesFromDisk(pubkey);
    if (!tpose) throw new Error("character has no t-pose yet — generate one first");

    const meshCall = services.startCall(backend, {
      pubkey,
      characterName: c.name,
      kind: "mesh",
      // Mesh backends don't take a text prompt — record the source
      // (tpose bytes) instead so we can trace which character image
      // produced which mesh.
      extra: { tposeBytes: tpose.buffer.length },
    });
    endInflight = (info = {}) => meshCall.end(info);
    const { buffer, startedAt } = await backendFn({ tpose, send });

    const dir = getCharDir(pubkey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.glb"), buffer);

    apiQuota.recordSuccess();
    if (endInflight) endInflight({ ok: true, bytes: buffer.length });
    endInflight = null;
    send("done", {
      modelUrl: `${PUBLIC_BRIDGE_URL}/characters/${pubkey}/model?t=${Date.now()}`,
      backend,
      elapsedMs: Date.now() - startedAt,
      bytes: buffer.length,
    });
  } catch (err) {
    apiQuota.refund();
    console.error(`[char:model:stream:${backend}]`, err.message);
    if (endInflight) endInflight({ ok: false, error: err.message });
    endInflight = null;
    send("error", { error: err.message, backend });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (endInflight) endInflight({ ok: false, error: "stream terminated unexpectedly" });
    res.end();
  }
});

// PHASE 1 STUB — rig + kimodo finalisation pipeline.
//
// Wraps steps 6-8 of `scripts/generate_character.py` (UniRig →
// palms-down Blender bake → kimodo registry import) behind a single
// SSE endpoint so the frontend can drive the chain progressively.
//
// This phase emits the full stage sequence with `setTimeout`-driven
// stubs so the Section-03 UI can be built against realistic events
// in parallel with the back-end work. Real stages land in:
//   Phase 2: `rigging` (POST to ${UNIRIG_URL}/rig)
//   Phase 3: `mapping` + `palms-down` + `importing` (kimodo-tools
//            sibling container) — including the force-gate for
//            cross-backend regen.
//
// Spec: docs/design/asset-pipeline-rig-import.md.
app.post("/characters/:pubkey/generate-rig/stream", apiQuota.middleware, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  const stage = (name, message, etaSeconds) => {
    send("stage", { stage: name, message, ...(etaSeconds != null ? { etaSeconds } : {}) });
  };

  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) {
    apiQuota.refund();
    send("error", { error: "not found" });
    return res.end();
  }

  const backend = (req.body?.backend ?? "trellis").toLowerCase();
  if (!["trellis", "hunyuan3d"].includes(backend)) {
    apiQuota.refund();
    send("error", { error: `unknown backend '${backend}'`, stage: "probing" });
    return res.end();
  }

  // Heartbeat: 1s tick so the frontend's stale-stream detection has
  // something to chew on between stage transitions.
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    send("heartbeat", { elapsedMs: Date.now() - startedAt });
  }, 1000);

  // setTimeout helper for the still-stubbed back half of the chain.
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let endInflight = null;
  try {
    // ── Probing — ensure model.glb exists on disk before we burn
    //    UniRig minutes on a non-existent input.
    const dir = getCharDir(pubkey);
    const modelPath = join(dir, "model.glb");
    if (!existsSync(modelPath)) {
      throw new Error("character has no 3D model yet — generate one first");
    }
    const modelBytes = readFileSync(modelPath);

    // ── Phase 2: real UniRig stage. callUniRigService emits its own
    //    probing/cold-start/warm/rigging stage events (mirroring the
    //    mesh backend pattern). It returns the rigged GLB bytes.
    const rigCall = services.startCall("unirig", {
      pubkey,
      characterName: c.name,
      kind: "rig",
      extra: { modelBytes: modelBytes.length, backend },
    });
    endInflight = (info = {}) => rigCall.end(info);

    const { buffer: rigBytes } = await callUniRigService({ modelBytes, send });

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rig.glb"), rigBytes);

    if (endInflight) endInflight({ ok: true, bytes: rigBytes.length });
    endInflight = null;

    // ── Phase 3: real kimodo finalisation via the kimodo-tools
    //    sibling container. Bridge emits the three stage events
    //    around one blocking POST (kimodo-tools doesn't stream — the
    //    chain takes ~5-10s end-to-end so per-stage granularity is
    //    cosmetic). Force-gate fires *before* the upstream call so
    //    we don't waste the bake on a record we'll refuse to import.
    const kimodoCharId = `unirig_${pubkey.slice(0, 12)}_${backend}`;
    const label = `${c.name ?? "Unnamed"} (${backend})`;
    const npub = npubEncode(pubkey);
    const kimodoMarkerPath = join(dir, "kimodo.json");

    // Force-gate. If a previous run imported this pubkey under a
    // *different* backend, refuse unless the caller passes
    // body.force === true. Same-backend re-runs are silent overwrites
    // (matches the CLI today; non-destructive — same id either way).
    if (existsSync(kimodoMarkerPath) && req.body?.force !== true) {
      try {
        const prev = JSON.parse(readFileSync(kimodoMarkerPath, "utf8"));
        if (prev?.backend && prev.backend !== backend) {
          throw new Error(
            `character was previously rigged with backend '${prev.backend}'; ` +
            `pass {force:true} to overwrite the kimodo registry record`,
          );
        }
      } catch (e) {
        // JSON parse failure on a corrupt marker file shouldn't
        // permanently lock us out; fall through and let the import
        // proceed (kimodo's import_unirig_glb.py overwrites by id).
        if (e?.message?.startsWith("character was previously")) throw e;
      }
    }

    const kimodoToolsCall = services.startCall("kimodo-tools", {
      pubkey, characterName: c.name, kind: "rig-finalize",
      extra: { backend, id: kimodoCharId },
    });
    endInflight = (info = {}) => kimodoToolsCall.end(info);

    stage("mapping", "deriving bone mapping", 2);

    await services.ensureWarm("kimodo-tools", {
      onStage: (s) => send("stage", s),
      onHeartbeat: (hb) => send("heartbeat", hb),
    });

    const finalizeBase = KIMODO_TOOLS_URL.replace(/\/$/, "");
    const finalizeRes = await fetch(`${finalizeBase}/rig-finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pubkey, npub, backend, label, id: kimodoCharId,
      }),
    });
    const finalizeJson = await finalizeRes.json().catch(() => null);
    if (!finalizeRes.ok || !finalizeJson?.ok) {
      const stageHint = finalizeJson?.stage || "unknown";
      const errText = finalizeJson?.error || `kimodo-tools ${finalizeRes.status}`;
      throw new Error(`kimodo-tools (${stageHint}): ${errText}`);
    }

    stage("palms-down", "Blender palms-down bake", 0);
    stage("importing", "registering with kimodo", 0);

    // Persist the import marker so the next bridge restart knows
    // this character is already imported and the force-gate has
    // something to compare against.
    const marker = {
      id: kimodoCharId,
      label,
      backend,
      importedAt: Date.now(),
      palmsGlbBytes: finalizeJson.palmsGlbBytes,
    };
    writeFileSync(kimodoMarkerPath, JSON.stringify(marker, null, 2));

    if (endInflight) endInflight({ ok: true, bytes: finalizeJson.palmsGlbBytes });
    endInflight = null;

    apiQuota.recordSuccess();
    send("done", {
      // The /rig route still serves rig.glb (the raw UniRig output);
      // rig_palmsdown.glb (the imported variant) lives at
      // <char-dir>/rig_palmsdown.glb. Frontend can fetch either as
      // needed once we add a route variant.
      rigUrl: `${PUBLIC_BRIDGE_URL}/characters/${pubkey}/rig?t=${Date.now()}`,
      kimodoCharId,
      label,
      backend,
      elapsedMs: Date.now() - startedAt,
      bytes: finalizeJson.palmsGlbBytes,
      mapping: finalizeJson.mapping ?? null,
      importedAt: marker.importedAt,
    });
  } catch (err) {
    apiQuota.refund();
    console.error(`[char:rig:stream:${backend}]`, err.message);
    if (endInflight) endInflight({ ok: false, error: err.message });
    endInflight = null;
    send("error", { error: err.message, backend });
  } finally {
    clearInterval(heartbeat);
    if (endInflight) endInflight({ ok: false, error: "stream terminated unexpectedly" });
    res.end();
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
    const { seed, overwriteName, model: pinnedModel, skipAvatar } = req.body || {};
    const model = (pinnedModel && PERSONA_MODELS.includes(pinnedModel))
      ? pinnedModel
      : PERSONA_MODELS[Math.floor(Math.random() * PERSONA_MODELS.length)];
    send("model", { model });

    // NPC personas use a different prompt — clinical, role-bound,
    // Severance-adjacent — and the user-prompt scaffolding leans on
    // the role string instead of a free seed. Player characters keep
    // the existing teen-mystery prompt unchanged.
    const isNpc = (c.kind ?? "player") === "npc";
    // NPC prompt is overridable via the prompt registry; player prompt
    // is fixed in source for now.
    const systemPrompt = isNpc ? loadPrompt("npc-persona") : loadPrompt("player-persona");
    let userPrompt;
    if (isNpc) {
      const role = c.npc_role ? `Role: ${c.npc_role}.` : "";
      const seedLine = seed?.trim() ? `User seed: ${seed.trim()}.` : "";
      userPrompt = [role, seedLine, "Invent the NPC's profile. Return JSON only."]
        .filter(Boolean).join("\n\n");
    } else {
      userPrompt = seed?.trim()
        ? `Seed from the user: ${seed.trim()}\n\nInvent a persona that fits. Return JSON only.`
        : "Invent a fresh, surprising persona. Return JSON only.";
    }

    const nimRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
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
    // The NPCs view explicitly separates avatar regen from persona regen,
    // so it passes `skipAvatar: true` to disable this step.
    if (!skipAvatar) {
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
    const persona = await generatePersona({
      seed,
      kind: c.kind ?? "player",
      role: c.npc_role ?? null,
    });
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
  const {
    name, about, state, avatarUrl, model, harness, promptStyle, mood, needs,
    npc_role, npc_default_pos, shift_start, shift_end, starter,
  } = req.body || {};
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
  // NPC field mutations. `kind` is intentionally NOT patchable — once
  // a character is created as a player or NPC, it stays that way; the
  // only escape hatch is to delete and recreate. Role uniqueness is
  // re-validated on each role change. Pos and shift hours are free.
  const isNpc = (c.kind ?? "player") === "npc";
  try {
    if (npc_role !== undefined) {
      if (!isNpc && npc_role !== null) {
        return res.status(400).json({ error: "npc_role only valid for kind:'npc'" });
      }
      const validated = validateNpcRole(npc_role);
      if (validated && validated !== c.npc_role) {
        const conflict = findNpcByRole(validated, { excludePubkey: pubkey });
        if (conflict) {
          return res.status(409).json({
            error: `npc_role '${validated}' already in use by ${conflict.pubkey.slice(0, 12)}...`,
          });
        }
      }
      patch.npc_role = validated;
    }
    if (npc_default_pos !== undefined) {
      if (!isNpc && npc_default_pos !== null) {
        return res.status(400).json({ error: "npc_default_pos only valid for kind:'npc'" });
      }
      patch.npc_default_pos = validateNpcDefaultPos(npc_default_pos);
    }
    if (shift_start !== undefined) patch.shift_start = validateShiftMinute(shift_start);
    if (shift_end !== undefined) patch.shift_end = validateShiftMinute(shift_end);
    // Tutorial-starter flag — coerced to boolean. Persisted on the
    // manifest so the wake-up scenario can pull "the three starters"
    // without hardcoding pubkeys.
    if (starter !== undefined) patch.starter = !!starter;
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  saveCharacterManifest(pubkey, patch);
  // Mirror needs edits into the live tracker — but ONLY if the
  // character is already being tracked (i.e. running). For not-yet-
  // spawned characters we just write the manifest; spawn picks up
  // the persisted values later. Otherwise we'd start ticking decay
  // on a character that isn't even active, and the slider values the
  // user dialed in would silently drift before they got a chance to
  // drag the character into the room.
  if (patch.needs && needsTracker.get(pubkey)) {
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
  const list = Array.from(agents.entries()).map(([id, rec]) => {
    // Resolve current tile + containing room — useful for UI surfaces
    // and the schedule-routing test that wants to see if a mover-driven
    // move has landed.
    let position = null;
    try {
      const snap = roomSnapshot(id);
      const me = (snap?.agents || []).find((a) => a.npub === rec.pubkey);
      if (me) {
        position = {
          x: me.x,
          y: me.y,
          room_id: roomsRegistry?.roomAt(me.x, me.y) ?? null,
        };
      }
    } catch { /* snapshot may not be ready */ }
    return {
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
      position,
    };
  });
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
  // Seed NPCs from the repo's seed-npcs/ tree (manifest+sk) and the
  // bucket's npcs/<npub>/ prefix (heavy assets). Idempotent; honours
  // RESEED_NPCS=1 for a forced manifest refresh. Fire-and-forget so
  // S3 latency doesn't delay bridge readiness.
  seedNpcs({
    charactersDir: CHARACTERS_DIR,
    publishProfile: (pk) => publishCharacterProfile(pk),
  }).catch((err) => {
    console.error("[seed-npcs] failed:", err?.message || err);
  });
});

process.on("SIGTERM", async () => {
  for (const id of agents.keys()) await stopAgent(id);
  process.exit(0);
});
