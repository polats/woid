#!/usr/bin/env node
/**
 * Publish kimodo motion JSONs to S3 so the production frontend can
 * resolve them via the bridge's `/v1/animations/:id` route.
 *
 *   node scripts/publish-animation.js <id> [<id>...]
 *
 * Each <id> is a kimodo motion id (the 12-hex-char string from
 * /animations on the kimodo motion API). The script:
 *
 *   1. GETs the motion JSON from local kimodo (`KIMODO_URL`,
 *      defaults to http://localhost:7862).
 *   2. Uploads it to S3 under `animations/<id>.json` via the
 *      bridge's S3 credentials (S3_* env vars).
 *
 * Idempotent — kimodo motion ids are content-addressed, so PUTs
 * with the same id always carry the same body. Re-running is a
 * no-op.
 *
 * Env requirements (synced into woid/.env from Railway):
 *   S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY
 *   KIMODO_URL  (optional; defaults to http://localhost:7862)
 */

import { putAnimation, s3Configured, bucket } from "../s3.js";

const KIMODO_URL = process.env.KIMODO_URL || "http://localhost:7862";

function fail(msg) {
  console.error(`[publish-animation] ${msg}`);
  process.exit(1);
}

async function publishOne(id) {
  const r = await fetch(`${KIMODO_URL}/animations/${id}`);
  if (!r.ok) throw new Error(`kimodo HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // Validate it parses + has the bone_names array kimodo motions
  // carry. Catches HTML fallbacks or empty payloads before we PUT
  // them and poison the cache for everyone.
  let parsed;
  try { parsed = JSON.parse(buf.toString("utf-8")); }
  catch { throw new Error("response is not valid JSON"); }
  if (!parsed || !Array.isArray(parsed.bone_names)) {
    throw new Error("response missing bone_names — not a kimodo motion");
  }
  await putAnimation(id, buf);
  const kb = (buf.length / 1024).toFixed(1);
  console.log(`✓ ${id}: uploaded s3://${bucket}/animations/${id}.json (${kb} KB)`);
}

async function main() {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) fail("usage: publish-animation.js <id> [<id>...]");
  if (!s3Configured) fail("S3 not configured — check .env (S3_ENDPOINT/BUCKET/...).");

  let ok = 0;
  let bad = 0;
  for (const id of ids) {
    if (!/^[a-f0-9]{8,32}$/i.test(id)) {
      console.warn(`⚠ ${id}: invalid id, skipping`);
      bad++;
      continue;
    }
    try {
      await publishOne(id);
      ok++;
    } catch (err) {
      console.warn(`⚠ ${id}: ${err.message}`);
      bad++;
    }
  }
  console.log(`\n${ok} published, ${bad} skipped/failed.`);
  if (bad > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[publish-animation] failed:`, err?.message || err);
  process.exit(1);
});
