#!/usr/bin/env node
/**
 * Publish a local NPC to the Git+S3 hybrid distribution channel.
 *
 *   node scripts/publish-npc.js <pubkey-or-npub-or-role>
 *
 * The pipeline:
 *
 *   1. Resolve the NPC by pubkey hex, npub, or `npc_role`.
 *   2. Validate kind === 'npc' (refuse to publish a player character)
 *      and that the manifest has `npc_role` + `npc_default_pos` set.
 *   3. Copy `agent.json` and `sk.hex` from the local workspace to
 *      `seed-npcs/<npub>/`, ready for `git add`.
 *   4. Upload heavy assets (avatar.{png|jpg|webp}, tpose.png,
 *      model.glb, rig.glb) to `s3://<bucket>/npcs/<npub>/<filename>`.
 *      Missing-locally files are skipped with a note — the NPC just
 *      ships with whatever's been generated so far.
 *   5. Print the next-steps git incantation.
 *
 * Idempotent — running twice on the same NPC re-uploads the assets
 * (S3 PUT is idempotent at this scope) and overwrites the seed
 * manifest. Run after the asset pipeline completes.
 *
 * Env requirements (synced into woid/.env from Railway):
 *   S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY
 *   WORKSPACE   (defaults to ${tmpdir}/woid-agent-sandbox if unset;
 *                set this to your local bridge's workspace dir)
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

import { putNpcAsset, s3Configured, bucket } from "../s3.js";

const SEED_DIR = join(__dirname, "..", "seed-npcs");
const WORKSPACE = process.env.WORKSPACE || join(tmpdir(), "woid-agent-sandbox");
const CHARACTERS_DIR = join(WORKSPACE, "characters");

// Asset filenames + MIME types we ship. Missing files are tolerated;
// extensions cover the variants the bridge / image pipelines produce.
const ASSETS = [
  { file: "avatar.png", mime: "image/png" },
  { file: "avatar.jpg", mime: "image/jpeg" },
  { file: "avatar.jpeg", mime: "image/jpeg" },
  { file: "avatar.webp", mime: "image/webp" },
  { file: "tpose.png", mime: "image/png" },
  { file: "model.glb", mime: "model/gltf-binary" },
  { file: "rig.glb", mime: "model/gltf-binary" },
  { file: "rig_palmsdown.glb", mime: "model/gltf-binary" },
  { file: "rig_mapping.json", mime: "application/json" },
  { file: "kimodo.json", mime: "application/json" },
];

function fail(msg) {
  console.error(`[publish-npc] ${msg}`);
  process.exit(1);
}

function loadManifest(npub) {
  const path = join(CHARACTERS_DIR, npub, "agent.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Resolve the user's argument to an npub. Accepts pubkey hex, npub,
 * or `npc_role` (e.g. "receptionist") — for the latter we scan the
 * workspace's character dirs for a matching role.
 */
function resolveNpub(arg) {
  if (typeof arg !== "string" || !arg) return null;
  if (arg.startsWith("npub1")) return arg;
  if (/^[0-9a-f]{64}$/i.test(arg)) return npubEncode(arg);
  // Role lookup — slow path; only NPCs typically.
  if (!existsSync(CHARACTERS_DIR)) return null;
  const dirs = readdirSync(CHARACTERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("npub1"));
  for (const d of dirs) {
    const m = loadManifest(d.name);
    if (m?.kind === "npc" && m?.npc_role === arg) return d.name;
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) fail("usage: publish-npc.js <pubkey-or-npub-or-role>");
  if (!s3Configured) fail("S3 not configured — check .env (S3_ENDPOINT/BUCKET/...).");

  const npub = resolveNpub(arg);
  if (!npub) fail(`could not resolve "${arg}" — pass a pubkey, npub, or NPC role.`);

  const manifest = loadManifest(npub);
  if (!manifest) fail(`no manifest at ${join(CHARACTERS_DIR, npub, "agent.json")}`);
  if (manifest.kind !== "npc") fail(`refusing to publish non-NPC character (kind="${manifest.kind ?? "player"}").`);
  if (!manifest.npc_role) fail(`manifest is missing npc_role; assign one in the NPCs view first.`);
  if (!manifest.npc_default_pos) fail(`manifest is missing npc_default_pos; assign one in the NPCs view first.`);

  const skPath = join(CHARACTERS_DIR, npub, "sk.hex");
  if (!existsSync(skPath)) fail(`no sk.hex at ${skPath}`);

  const decoded = nip19Decode(npub);
  const pubkeyHex = decoded.type === "npub" ? decoded.data : null;
  if (!pubkeyHex) fail(`could not decode npub "${npub}".`);

  console.log(`\n📦 Publishing NPC: ${manifest.name} (${npub.slice(0, 16)}...)`);
  console.log(`   role=${manifest.npc_role}  room=${manifest.npc_default_pos.roomId}`);

  // 1. Copy manifest + sk to seed-npcs/<npub>/
  const seedTarget = join(SEED_DIR, npub);
  mkdirSync(seedTarget, { recursive: true });
  writeFileSync(join(seedTarget, "agent.json"), readFileSync(join(CHARACTERS_DIR, npub, "agent.json")));
  writeFileSync(join(seedTarget, "sk.hex"), readFileSync(skPath), { mode: 0o600 });
  console.log(`✓ wrote seed-npcs/${npub.slice(0, 24)}.../{agent.json,sk.hex}`);

  // 2. Upload heavy assets to S3 npcs/<npub>/<filename>
  let uploaded = 0;
  let skipped = 0;
  for (const { file, mime } of ASSETS) {
    const src = join(CHARACTERS_DIR, npub, file);
    if (!existsSync(src)) { skipped++; continue; }
    const buf = readFileSync(src);
    await putNpcAsset(npub, file, buf, mime);
    const kb = (buf.length / 1024).toFixed(1);
    console.log(`✓ uploaded s3://${bucket}/npcs/${npub.slice(0, 16)}.../${file} (${kb} KB)`);
    uploaded++;
  }
  if (uploaded === 0) console.warn(`⚠ no assets uploaded — none of {${ASSETS.map((a) => a.file).join(", ")}} exist locally yet.`);
  if (skipped > 0) console.log(`  ${skipped} asset(s) skipped (not generated locally yet).`);

  console.log(`\nNext steps:`);
  console.log(`  cd ${REPO_ROOT}`);
  console.log(`  git add agent-sandbox/pi-bridge/seed-npcs/${npub}`);
  console.log(`  git commit -m "npc: ${manifest.name} (${manifest.npc_role})"`);
  console.log(`  git push   # Railway redeploys → seed-npcs.js seeds on boot.\n`);
}

main().catch((err) => {
  console.error(`[publish-npc] failed:`, err?.message || err);
  process.exit(1);
});
