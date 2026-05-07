/**
 * Boot-time NPC seeder. Companion to scripts/publish-npc.js.
 *
 * The pipeline:
 *
 *   1. For each `<npub>/` directory under `seed-npcs/`, copy the
 *      manifest + sk into the workspace's `characters/<npub>/` dir
 *      (creating it if missing). Existing characters are not
 *      overwritten unless RESEED_NPCS=1 is set in env.
 *   2. For each canonical asset filename, if the workspace copy is
 *      missing, fetch from S3 (`npcs/<npub>/<filename>`) and write
 *      to disk. Skipped silently if S3 isn't configured or the asset
 *      doesn't exist remotely.
 *   3. Publish the character's kind:0 profile to the relay so any
 *      relay-connected client (Jumble, the woid network view) sees
 *      the NPC immediately on a fresh deploy.
 *
 * Idempotent — running twice on the same workspace is a no-op the
 * second time.
 *
 * Called once from server.js before `app.listen()`.
 */

import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode as nip19Decode } from "nostr-tools/nip19";

import { s3Configured, getNpcAsset } from "../s3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo-side seed directory. Co-located with scripts/ so it's at a
// stable path on both local dev and the Railway build.
const SEED_DIR = join(__dirname, "..", "seed-npcs");

// Canonical asset filenames the seeder pulls from S3 when missing
// locally. Order doesn't matter; missing files are tolerated (the
// frontend's avatar factory has fallbacks for everything except the
// manifest itself).
const SEED_ASSETS = [
  "avatar.png",
  "avatar.jpg",
  "avatar.jpeg",
  "avatar.webp",
  "tpose.png",
  "model.glb",
  "rig.glb",
  "rig_palmsdown.glb",
  "rig_mapping.json",
  "kimodo.json",
];

function decodeNpub(npub) {
  if (typeof npub !== "string" || !npub.startsWith("npub1")) return null;
  try {
    const decoded = nip19Decode(npub);
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

/**
 * Seed NPCs into the workspace.
 *
 * @param {object}   opts
 * @param {string}   opts.charactersDir  Absolute path to <WORKSPACE>/characters/.
 * @param {function} [opts.publishProfile]  Optional async fn called per seeded
 *   NPC with the pubkey hex; used to publish kind:0 to the relay. Pass null
 *   to skip relay publication.
 * @returns {Promise<{ seeded: string[], reseeded: string[], skipped: string[] }>}
 */
export async function seedNpcs({ charactersDir, publishProfile = null }) {
  if (!existsSync(SEED_DIR)) {
    return { seeded: [], reseeded: [], skipped: [] };
  }
  const reseed = process.env.RESEED_NPCS === "1";
  const seeded = [];
  const reseeded = [];
  const skipped = [];

  let entries;
  try {
    entries = readdirSync(SEED_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch (err) {
    console.warn(`[seed-npcs] failed to read ${SEED_DIR}:`, err.message);
    return { seeded, reseeded, skipped };
  }

  for (const dirent of entries) {
    const npub = dirent.name;
    const pubkey = decodeNpub(npub);
    if (!pubkey) {
      console.warn(`[seed-npcs] skipping invalid npub directory: ${npub}`);
      skipped.push(npub);
      continue;
    }

    const seedDirNpc = join(SEED_DIR, npub);
    const targetDir = join(charactersDir, npub);
    const manifestSeed = join(seedDirNpc, "agent.json");
    const skSeed = join(seedDirNpc, "sk.hex");

    if (!existsSync(manifestSeed) || !existsSync(skSeed)) {
      console.warn(`[seed-npcs] ${npub}: missing agent.json or sk.hex; skipping`);
      skipped.push(npub);
      continue;
    }

    const alreadyExists = existsSync(join(targetDir, "agent.json"));
    if (alreadyExists && !reseed) {
      // Manifest already in workspace; assets may still be missing
      // on a fresh volume so fall through to the asset-pull pass.
      // No "seeded" classification — this is a partial sync.
    } else {
      // Fresh seed (or RESEED_NPCS=1): copy manifest + sk and write
      // the .pi/identity helper file. Rewrite avatarUrl using the
      // CURRENT PUBLIC_BRIDGE_URL so a manifest exported from a
      // local-network bridge doesn't leave a LAN IP baked in on
      // prod. If the seed manifest has no avatarUrl at all, we
      // synthesise one — the bridge serves /characters/:pubkey/avatar
      // from disk regardless, but frontends read the field to render.
      mkdirSync(join(targetDir, ".pi"), { recursive: true });
      const rawManifest = JSON.parse(readFileSync(manifestSeed, "utf-8"));
      const publicUrl = process.env.PUBLIC_BRIDGE_URL;
      if (publicUrl) {
        rawManifest.avatarUrl = `${publicUrl}/characters/${pubkey}/avatar?t=${Date.now()}`;
      }
      writeFileSync(join(targetDir, "agent.json"), JSON.stringify(rawManifest, null, 2));
      writeFileSync(join(targetDir, "sk.hex"), readFileSync(skSeed), { mode: 0o600 });
      writeFileSync(join(targetDir, ".pi", "identity"), pubkey);
      if (alreadyExists) reseeded.push(npub);
      else seeded.push(npub);
    }

    // Asset pull — silent skip when S3 isn't configured.
    if (s3Configured) {
      for (const filename of SEED_ASSETS) {
        const dest = join(targetDir, filename);
        if (existsSync(dest)) continue;
        try {
          const got = await getNpcAsset(npub, filename);
          if (!got) continue; // remote missing too; tolerated
          writeFileSync(dest, got.buffer);
          console.log(`[seed-npcs] ${npub}: pulled ${filename} (${got.buffer.length} bytes)`);
        } catch (err) {
          console.warn(`[seed-npcs] ${npub}: failed to pull ${filename}:`, err.message);
        }
      }
    }

    if (publishProfile && (seeded.includes(npub) || reseeded.includes(npub))) {
      try {
        await publishProfile(pubkey);
      } catch (err) {
        console.warn(`[seed-npcs] ${npub}: kind:0 publish failed:`, err.message);
      }
    }
  }

  if (seeded.length) console.log(`[seed-npcs] seeded ${seeded.length} new NPC(s):`, seeded.join(", "));
  if (reseeded.length) console.log(`[seed-npcs] re-seeded ${reseeded.length} NPC(s):`, reseeded.join(", "));
  return { seeded, reseeded, skipped };
}
