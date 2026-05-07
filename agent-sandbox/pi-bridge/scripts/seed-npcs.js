/**
 * Boot-time NPC seeder.
 *
 * Two sources, in order of precedence:
 *
 *   1. S3 — `s3://<bucket>/npcs/<npub>/{agent.json, sk.hex, …}`. This
 *      is the canonical store. The Animations / NPCs views POST to
 *      `/v1/npcs/<pubkey>/publish` which uploads everything here, no
 *      git commit needed.
 *   2. Legacy repo dir — `seed-npcs/<npub>/{agent.json, sk.hex}` (the
 *      old git-tracked path). Used as a fallback for NPCs that haven't
 *      been migrated to the S3 path yet, and only runs if S3 is
 *      unconfigured or has no entries. Will be removed once everything
 *      is on S3.
 *
 * For each NPC found, copy manifest + sk into
 * `<charactersDir>/<npub>/`, pull missing heavy assets from S3
 * (avatar / tpose / model / rig / mapping JSONs), and publish a
 * fresh kind:0 to the relay so external clients see the NPC. Existing
 * characters are not overwritten unless RESEED_NPCS=1 is set.
 *
 * Idempotent — running twice on the same workspace re-pulls only
 * missing assets the second time.
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

import {
  s3Configured,
  getNpcAsset,
  listPublishedNpcs,
} from "../s3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Legacy seed dir — kept as a fallback for the transition period.
const LEGACY_SEED_DIR = join(__dirname, "..", "seed-npcs");

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
 * Resolve the manifest + sk for an NPC by trying S3 first, then the
 * legacy repo directory. Returns `null` if neither has the files.
 */
async function loadSeed(npub) {
  // S3 path.
  if (s3Configured) {
    const manifest = await getNpcAsset(npub, "agent.json").catch(() => null);
    if (manifest) {
      const sk = await getNpcAsset(npub, "sk.hex").catch(() => null);
      if (sk) {
        return {
          source: "s3",
          manifest: manifest.buffer,
          sk: sk.buffer,
        };
      }
    }
  }
  // Legacy repo dir.
  const legacyDir = join(LEGACY_SEED_DIR, npub);
  const manifestPath = join(legacyDir, "agent.json");
  const skPath = join(legacyDir, "sk.hex");
  if (existsSync(manifestPath) && existsSync(skPath)) {
    return {
      source: "legacy",
      manifest: readFileSync(manifestPath),
      sk: readFileSync(skPath),
    };
  }
  return null;
}

/** Enumerate every npub we know about across both sources. */
async function enumerateNpcs() {
  const npubs = new Set();
  if (s3Configured) {
    try {
      for (const npub of await listPublishedNpcs()) npubs.add(npub);
    } catch (err) {
      console.warn(`[seed-npcs] S3 list failed:`, err.message);
    }
  }
  if (existsSync(LEGACY_SEED_DIR)) {
    try {
      for (const dirent of readdirSync(LEGACY_SEED_DIR, { withFileTypes: true })) {
        if (dirent.isDirectory() && dirent.name.startsWith("npub1")) {
          npubs.add(dirent.name);
        }
      }
    } catch (err) {
      console.warn(`[seed-npcs] legacy dir read failed:`, err.message);
    }
  }
  return [...npubs];
}

export async function seedNpcs({ charactersDir, publishProfile = null }) {
  const reseed = process.env.RESEED_NPCS === "1";
  const seeded = [];
  const reseeded = [];
  const skipped = [];

  const npubs = await enumerateNpcs();
  if (npubs.length === 0) {
    return { seeded, reseeded, skipped };
  }

  for (const npub of npubs) {
    const pubkey = decodeNpub(npub);
    if (!pubkey) {
      console.warn(`[seed-npcs] skipping invalid npub: ${npub}`);
      skipped.push(npub);
      continue;
    }

    const seed = await loadSeed(npub);
    if (!seed) {
      console.warn(`[seed-npcs] ${npub}: no manifest+sk in S3 or legacy dir; skipping`);
      skipped.push(npub);
      continue;
    }

    const targetDir = join(charactersDir, npub);
    const alreadyExists = existsSync(join(targetDir, "agent.json"));

    if (alreadyExists && !reseed) {
      // Manifest already present — fall through to asset-pull pass.
    } else {
      // Fresh seed (or RESEED_NPCS=1): copy manifest + sk and write
      // the .pi/identity helper. Rewrite avatarUrl to use the current
      // PUBLIC_BRIDGE_URL so a manifest exported on a local-network
      // machine doesn't leave a LAN IP baked into prod.
      mkdirSync(join(targetDir, ".pi"), { recursive: true });
      const rawManifest = JSON.parse(seed.manifest.toString("utf-8"));
      const publicUrl = process.env.PUBLIC_BRIDGE_URL;
      if (publicUrl) {
        rawManifest.avatarUrl = `${publicUrl}/characters/${pubkey}/avatar?t=${Date.now()}`;
      }
      writeFileSync(join(targetDir, "agent.json"), JSON.stringify(rawManifest, null, 2));
      writeFileSync(join(targetDir, "sk.hex"), seed.sk, { mode: 0o600 });
      writeFileSync(join(targetDir, ".pi", "identity"), pubkey);
      if (alreadyExists) reseeded.push(npub);
      else seeded.push(npub);
    }

    // Asset pull — missing-locally only. Tolerated when remote also
    // missing (frontend has a fallback render path).
    if (s3Configured) {
      for (const filename of SEED_ASSETS) {
        const dest = join(targetDir, filename);
        if (existsSync(dest)) continue;
        try {
          const got = await getNpcAsset(npub, filename);
          if (!got) continue;
          writeFileSync(dest, got.buffer);
          console.log(`[seed-npcs] ${npub}: pulled ${filename} (${got.buffer.length} bytes) from S3`);
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
