import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
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
