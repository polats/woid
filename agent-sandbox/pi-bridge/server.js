import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync, renameSync, createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateSecretKey } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";
import WebSocket from "ws";

// nostr-tools SimplePool uses global WebSocket; Node doesn't expose one by default.
useWebSocketImplementation(WebSocket);
import { buildSystemPrompt, buildUserTurn } from "./buildContext.js";
import { joinRoom, leaveRoom, sendSay, sayAs, moveAs, moveAgent, onNewMessage, onPositionChange, roomSnapshot } from "./room-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3457");
const PI_BIN = process.env.PI_BIN || "pi";
const WORKSPACE = process.env.WORKSPACE || join(tmpdir(), "woid-agent-sandbox");
const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7777";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
// URL browsers/Nostr clients use to fetch resources served by this bridge.
// Inside docker-compose the bridge is reachable at http://pi-bridge:3457,
// but kind:0 profiles need a URL external tools can resolve — default to
// the host-mapped port.
const PUBLIC_BRIDGE_URL = process.env.PUBLIC_BRIDGE_URL || "http://localhost:13457";
const SKILL_TEMPLATES_DIR = join(__dirname, "skill-templates");
const DEFAULT_SKILLS = ["post", "room"];

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
        avatarUrl: c.avatarUrl ?? null,
        model: c.model ?? null,
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
  const manifest = saveCharacterManifest(pubkey, {
    name: (name && String(name).trim()) || randomName(),
    createdAt: Date.now(),
  });
  console.log(`[char] created ${pubkey.slice(0, 12)}... name="${manifest.name}"`);
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

async function generateAvatar({ pubkey, name, about, promptOverride }) {
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

  const dir = getCharDir(pubkey);
  mkdirSync(dir, { recursive: true });
  const filename = `avatar.${ext}`;
  writeFileSync(join(dir, filename), Buffer.from(b64, "base64"));
  const avatarUrl = `${PUBLIC_BRIDGE_URL}/characters/${pubkey}/avatar?t=${Date.now()}`;
  return { avatarUrl, prompt, filename };
}

function deleteCharacter(pubkey) {
  const dir = getCharDir(pubkey);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
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
  for (const [id, rec] of agents.entries()) {
    if (rec.pubkey === pubkey) return { id, rec };
  }
  return null;
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
  return {
    agentId: r.id,
    running: !!r.rec.listening,
    listening: !!r.rec.listening,
    thinking: !!r.rec.process,
    turns: r.rec.turns ?? 0,
    model: r.rec.model ?? null,
    roomName: r.rec.roomName ?? null,
    exitedAt: r.rec.exitedAt ?? null,
    exitCode: r.rec.exitCode ?? null,
  };
}

// Spawn a single pi turn for an existing agent record. Non-blocking;
// mutates rec.process and rec.events as stdout events arrive. Returns
// the child immediately.
function runPiTurn(rec, { seedMessage, trigger = "heartbeat", triggerContext = {} }) {
  const charDir = getCharDir(rec.pubkey);
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
  });

  const userTurn = buildUserTurn({
    character: { pubkey: rec.pubkey, x: myPresence.x ?? 0, y: myPresence.y ?? 0 },
    trigger,
    triggerContext,
    roomSnapshot: snapshot,
    lastSeenMessageTs: rec.lastSeenMessageTs,
    seedMessage,
  });

  // Pi owns the conversation history per character. The session JSONL
  // lives next to agent.json so it survives bridge restarts, container
  // rebuilds, and host reboots. Each pi invocation appends to it.
  // buildUserTurn carries only the delta since lastSeenMessageTs.
  const sessionPath = join(getCharDir(rec.pubkey), "session.jsonl");
  const args = [
    "--provider", "nvidia-nim",
    "--model", rec.model,
    "--mode", "json",
    "--print",
    "--session", sessionPath,
    "--system-prompt", systemPrompt,
  ];
  args.push(userTurn);

  const child = spawn(PI_BIN, args, {
    cwd: charDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NVIDIA_NIM_API_KEY, HOME: homedir() },
  });
  rec.process = child;
  rec.turns = (rec.turns ?? 0) + 1;
  rec.lastTriggerAt = Date.now();

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      rec.events.push({ kind: "pi", data: parsed });
    } catch {
      rec.events.push({ kind: "stdout", text: trimmed });
    }
  });
  child.stderr.on("data", (d) => {
    const text = d.toString().trimEnd();
    if (!text) return;
    console.error(`[pi:${rec.agentId}:err] ${text}`);
    rec.events.push({ kind: "stderr", text });
  });
  child.on("exit", (code) => {
    console.log(`[pi:${rec.agentId}] turn=${rec.turns} exited code=${code}`);
    rec.events.push({ kind: "exit", code, turn: rec.turns });
    if (agents.get(rec.agentId) === rec) rec.process = null;
    // Bump the high-water mark so the next turn's user message only
    // carries messages newer than this turn's snapshot.
    const latest = snapshot.messages?.length
      ? Math.max(...snapshot.messages.map((m) => m.ts ?? 0))
      : rec.lastSeenMessageTs ?? 0;
    rec.lastSeenMessageTs = latest;
  });
  return child;
}

// Per-agent caps for continuous listening. Tunable via env.
const AGENT_MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 20);
const AGENT_MIN_TRIGGER_GAP_MS = Number(process.env.AGENT_MIN_TRIGGER_GAP_MS || 15_000);
const AGENT_DEBOUNCE_MS = Number(process.env.AGENT_DEBOUNCE_MS || 1_500);
const AGENT_IDLE_TIMEOUT_MS = Number(process.env.AGENT_IDLE_TIMEOUT_MS || 5 * 60_000);

async function createAgent({ pubkey, name, seedMessage, roomName, model, x, y }) {
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

  saveCharacterManifest(character.pubkey, { model: chosenModel });

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

  // First turn — typed trigger "spawn". If no explicit seed, the intro
  // nudge encourages the agent to say hello. Listener-triggered turns
  // later carry "message_received" / "arrival" with a triggerContext.
  const firstSeed =
    seedMessage
    || "Introduce yourself briefly to the room by posting a short greeting.";
  runPiTurn(rec, { seedMessage: firstSeed, trigger: "spawn", triggerContext: {} });

  console.log(`[agent] spawned ${agentId} name="${resolvedName}" model=${chosenModel} npub=${character.pubkey.slice(0, 12)}...`);
  return { agentId, npub: character.pubkey, pubkey: character.pubkey, model: chosenModel, name: resolvedName };
}

// Called from the room-message listener (debounced). Runs a new pi turn if:
//   - the driver is still listening
//   - no pi currently running for this agent
//   - we haven't triggered within AGENT_MIN_TRIGGER_GAP_MS
//   - we're under AGENT_MAX_TURNS
function tryListenTurn(rec) {
  if (!rec.listening) return;
  if (rec.process) return; // busy with a turn
  if (rec.turns >= AGENT_MAX_TURNS) {
    console.log(`[driver:${rec.agentId}] reached max turns (${AGENT_MAX_TURNS}), stopping`);
    stopAgent(rec.agentId).catch(() => {});
    return;
  }
  const sinceLast = Date.now() - rec.lastTriggerAt;
  if (sinceLast < AGENT_MIN_TRIGGER_GAP_MS) return;
  const pending = rec.pendingTrigger ?? { trigger: "heartbeat", triggerContext: {} };
  rec.pendingTrigger = null;
  runPiTurn(rec, pending);
}

async function stopAgent(agentId) {
  const rec = agents.get(agentId);
  if (!rec) return false;
  rec.listening = false;
  if (rec.debounceTimer) { clearTimeout(rec.debounceTimer); rec.debounceTimer = null; }
  if (rec.idleTimer) { clearInterval(rec.idleTimer); rec.idleTimer = null; }
  if (rec.unsubscribe) { try { rec.unsubscribe(); } catch {} }
  try { rec.process?.kill(); } catch {}
  rec.process = null;
  rec.exitedAt = Date.now();
  rec.events.push({ kind: "exit", code: "stopped", turns: rec.turns });
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

app.get("/human", (_req, res) => {
  res.json({
    pubkey: human.pubkey,
    npub: npubEncode(human.pubkey),
    profile: HUMAN_PROFILE,
  });
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
    const { pubkey, name, seedMessage, roomName, model, x, y } = req.body || {};
    if (!pubkey && !name) return res.status(400).json({ error: "pubkey or name required" });
    const result = await createAgent({ pubkey, name, seedMessage, roomName, model, x, y });
    res.json(result);
  } catch (err) {
    const status = err.code === 409 ? 409 : 500;
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
    avatarUrl: c.avatarUrl ?? null,
    model: c.model ?? null,
    profileSource: c.profileSource ?? null,
    profileModel: c.profileModel ?? null,
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
    runtime: runtimeSnapshot(c.pubkey),
  });
});

app.get("/characters/:pubkey/avatar", (req, res) => {
  const pubkey = req.params.pubkey;
  const dir = getCharDir(pubkey);
  // Check in priority order for the extension that might be on disk.
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

app.post("/characters/:pubkey/generate-avatar", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
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
    res.json({ avatarUrl, prompt });
  } catch (err) {
    console.error("[char:avatar]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// SSE streaming variant of persona generation. Emits events:
//   event: model   data: {model}
//   event: delta   data: {content}
//   event: done    data: {name, about, _generator: {model}}
//   event: error   data: {error}
app.post("/characters/:pubkey/generate-profile/stream", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });

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
  } catch (err) {
    console.error("[char:generate-stream]", err.message);
    send("error", { error: err.message });
  } finally {
    res.end();
  }
});

app.post("/characters/:pubkey/generate-profile", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
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
    console.error("[char:generate]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.patch("/characters/:pubkey", async (req, res) => {
  const pubkey = req.params.pubkey;
  const c = loadCharacter(pubkey);
  if (!c) return res.status(404).json({ error: "not found" });
  const { name, about, avatarUrl, model } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = String(name).trim() || c.name;
  if (about !== undefined) patch.about = about ? String(about) : null;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl ? String(avatarUrl) : null;
  if (model !== undefined) {
    const validIds = new Set(availableModels().map((m) => m.id));
    if (model && !validIds.has(model)) return res.status(400).json({ error: "unknown model" });
    patch.model = model || null;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  saveCharacterManifest(pubkey, patch);
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
    avatarUrl: next.avatarUrl ?? null,
    model: next.model ?? null,
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
    running: !!rec.process,
    exitedAt: rec.exitedAt ?? null,
    exitCode: rec.exitCode ?? null,
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
});

process.on("SIGTERM", async () => {
  for (const id of agents.keys()) await stopAgent(id);
  process.exit(0);
});
