import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

/**
 * S3-compatible object store for character avatar bytes.
 *
 * - Configured via env: S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY.
 * - When *any* of those vars are missing, `client` is null and callers fall
 *   back to the local filesystem path. This is how local dev stays working
 *   without MinIO or any other setup: just don't set the vars.
 * - Railway-provided buckets expect path-style requests (`forcePathStyle: true`).
 *
 * Keyspace: `avatars/<pubkey>.<ext>` — one avatar per character, overwritten
 * on regeneration. Using pubkey hex (not npub) matches the rest of the
 * bridge's internal keying.
 */

const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_REGION = process.env.S3_REGION || "auto";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";

export const s3Configured = !!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY);

export const client = s3Configured
  ? new S3Client({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      forcePathStyle: true,
    })
  : null;

export const bucket = S3_BUCKET;

export function avatarKey(pubkey, ext) {
  return `avatars/${pubkey}.${ext}`;
}

/**
 * Per-post image keys live under `posts/<pubkey>/<short-id>.<ext>` so
 * a single character can have many posted images coexisting (avatars
 * are overwritten; post images aren't). The short-id is the caller's
 * responsibility — we don't generate it here so callers can derive
 * deterministic IDs (e.g. event sha256) when convenient.
 */
export function postImageKey(pubkey, shortId, ext) {
  return `posts/${pubkey}/${shortId}.${ext}`;
}

export async function putAvatar(pubkey, ext, buffer, contentType) {
  if (!client) throw new Error("S3 not configured");
  const Key = avatarKey(pubkey, ext);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key,
    Body: buffer,
    ContentType: contentType,
    // Long browser/CDN cache so subsequent loads don't round-trip S3.
    // The cache-buster `?t=<ts>` on the published avatarUrl bumps clients
    // when the image changes.
    CacheControl: "public, max-age=604800, immutable",
  }));
  return Key;
}

export async function putPostImage(pubkey, shortId, ext, buffer, contentType) {
  if (!client) throw new Error("S3 not configured");
  const Key = postImageKey(pubkey, shortId, ext);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key,
    Body: buffer,
    ContentType: contentType,
    // Post images are immutable — same URL forever, so we can cache
    // aggressively without a cache-buster.
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return Key;
}

export async function getPostImageStream(pubkey, shortId, ext) {
  if (!client) throw new Error("S3 not configured");
  const out = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: postImageKey(pubkey, shortId, ext),
  }));
  return { body: out.Body, contentType: out.ContentType };
}

export async function headAvatar(pubkey) {
  if (!client) return null;
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    try {
      const out = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: avatarKey(pubkey, ext),
      }));
      return { ext, contentType: out.ContentType, contentLength: out.ContentLength };
    } catch (err) {
      if (err.$metadata?.httpStatusCode !== 404 && err.name !== "NotFound") throw err;
    }
  }
  return null;
}

export async function getAvatarStream(pubkey, ext) {
  if (!client) throw new Error("S3 not configured");
  const out = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: avatarKey(pubkey, ext),
  }));
  return { body: out.Body, contentType: out.ContentType };
}

export async function deleteAvatar(pubkey) {
  if (!client) return;
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    try {
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: avatarKey(pubkey, ext),
      }));
    } catch { /* best-effort cleanup */ }
  }
}

/**
 * NPC asset shipping — large-file half of the Git+S3 hybrid (see
 * docs/design/npc-deploy.md). Manifests + sk live in the woid repo;
 * heavy assets (avatar.png, tpose.png, model.glb, rig.glb) live here.
 *
 * Keyspace: `npcs/<npub>/<filename>`. npub instead of pubkey hex
 * because the bridge stores characters under their npub directory
 * locally and we want one-to-one correspondence on disk.
 */
export function npcAssetKey(npub, filename) {
  return `npcs/${npub}/${filename}`;
}

export async function putNpcAsset(npub, filename, buffer, contentType) {
  if (!client) throw new Error("S3 not configured");
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: npcAssetKey(npub, filename),
    Body: buffer,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return npcAssetKey(npub, filename);
}

export async function getNpcAsset(npub, filename) {
  if (!client) throw new Error("S3 not configured");
  try {
    const out = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: npcAssetKey(npub, filename),
    }));
    // Convert the body stream into a Buffer for the seed-script's
    // simple file-write path. (Streaming straight to disk is also
    // possible but adds complexity for a one-shot boot pull.)
    const chunks = [];
    for await (const chunk of out.Body) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: out.ContentType };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === "NoSuchKey") return null;
    throw err;
  }
}

export async function headNpcAsset(npub, filename) {
  if (!client) return null;
  try {
    const out = await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: npcAssetKey(npub, filename),
    }));
    return { contentType: out.ContentType, contentLength: out.ContentLength };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === "NotFound") return null;
    throw err;
  }
}

/**
 * Kimodo motion-JSON shipping. Mirrors the NPC asset pattern — local
 * dev pushes content-addressed motion JSONs (~400 KB each) up; prod
 * frontends GET them through the bridge's `/v1/animations/:id` route.
 *
 * Keyspace: `animations/<id>.json`. The id is the kimodo motion id
 * (12-hex-char, content-addressed by the model's output) so PUTs are
 * idempotent and a re-publish is a no-op.
 */
export function animationKey(id) {
  return `animations/${id}.json`;
}

export async function putAnimation(id, buffer) {
  if (!client) throw new Error("S3 not configured");
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: animationKey(id),
    Body: buffer,
    ContentType: "application/json",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return animationKey(id);
}

export async function getAnimationStream(id) {
  if (!client) throw new Error("S3 not configured");
  try {
    const out = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: animationKey(id),
    }));
    return { body: out.Body, contentType: out.ContentType, contentLength: out.ContentLength };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === "NoSuchKey") return null;
    throw err;
  }
}

/**
 * Enumerate published animation IDs from the bucket. Used by the
 * Animations tab to mark cards as "published". Paginates over the
 * `animations/` prefix; in practice we expect tens-to-hundreds, so
 * a single ListObjectsV2 call is enough.
 */
export async function listAnimations() {
  if (!client) return [];
  const results = [];
  let continuationToken;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "animations/",
      ContinuationToken: continuationToken,
    }));
    for (const obj of out.Contents ?? []) {
      const m = obj.Key?.match(/^animations\/([a-f0-9]{8,32})\.json$/);
      if (!m) continue;
      results.push({
        id: m[1],
        sizeKb: Math.round((obj.Size ?? 0) / 1024),
        publishedAt: obj.LastModified?.getTime() ?? null,
      });
    }
    continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (continuationToken);
  return results;
}

/**
 * Tag map storage — single-tenant key/value blob. Lives in S3 so it
 * survives a Railway volume wipe. Shape is identical to what the
 * frontend's animationLibrary stores in localStorage:
 *   { tags: string[], assignments: Record<string, string> }
 */
const TAGS_KEY = "tags.json";

export async function getTagMap() {
  if (!client) return null;
  try {
    const out = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: TAGS_KEY,
    }));
    const chunks = [];
    for await (const chunk of out.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === "NoSuchKey") return null;
    throw err;
  }
}

export async function putTagMap(tagMap) {
  if (!client) throw new Error("S3 not configured");
  const buf = Buffer.from(JSON.stringify(tagMap));
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: TAGS_KEY,
    Body: buf,
    ContentType: "application/json",
    // Mutable; let clients revalidate.
    CacheControl: "no-cache",
  }));
  return TAGS_KEY;
}

/**
 * Enumerate NPCs published to S3 — returns the unique npub directory
 * prefixes under `npcs/`. Used at bridge boot to find which NPCs to
 * seed onto the local volume. Replaces the legacy seed-npcs/ dir
 * walk for the publish-from-frontend flow.
 */
export async function listPublishedNpcs() {
  if (!client) return [];
  const npubs = new Set();
  let continuationToken;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "npcs/",
      ContinuationToken: continuationToken,
    }));
    for (const obj of out.Contents ?? []) {
      const m = obj.Key?.match(/^npcs\/(npub1[a-z0-9]+)\//);
      if (m) npubs.add(m[1]);
    }
    continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (continuationToken);
  return [...npubs];
}
