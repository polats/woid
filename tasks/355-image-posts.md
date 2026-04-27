---
name: World — Image posts via NIP-94 (extend `post` verb with image_prompt)
description: Reuse the FLUX avatar pipeline so characters can attach a generated photograph to their Nostr posts. The LLM emits `post({text, image_prompt})`; the bridge generates → uploads to S3 → builds kind:1 with NIP-94 imeta tag.
status: todo
order: 355
epic: world
depends_on: [275]
related: [245]
---

Specified in [docs/design/follow-ups.md §2](../docs/design/follow-ups.md#2-image-posts--maya-posts-photographs-alongside-her-text).

Audience hook: characters with strong visual sensibilities in their `about` (Maya's silver pocket watch, an artist's sketches, a cook's morning loaf) come alive when their posts are accompanied by an image. We already have the FLUX pipeline for avatars and S3 storage; piping that into the `post` verb is small.

## Slices

### Slice 1 — Refactor avatar gen → generic image gen

- Rename / refactor `generateAvatarBytes` in [server.js](../../agent-sandbox/pi-bridge/server.js) into a more generic `generateImageBytes({ prompt })` that drops the portrait framing.
- `generateAvatar` keeps the portrait prompt but composes from `generateImageBytes`.
- Add `generatePostImage({ pubkey, prompt })` that uploads to S3 under `posts/<pubkey>/<short-id>.<ext>` and returns `{ url, mime, sha256, width, height }`.

### Slice 2 — `post` verb gains `image_prompt`

- Extend `post` args schema with optional `image_prompt: string` (max 400 chars).
- Handler:
  - If `image_prompt` is set, call `generatePostImage` and capture URL + sha256.
  - Append URL to the kind:1 content body: `${text}\n\n${imageUrl}`.
  - Pass an `imeta` tag to `relayPost`:
    ```
    ["imeta", "url <url>", "m image/jpeg", "x <sha256>"]
    ```
- Update verb's `prompt` field with audience-tuned guidance: "images are rare — once or twice a day, when something specifically visual is worth showing. Mundane objects in good light beat dramatic landscapes."

### Slice 3 — Throttling

- Extend `apiQuota` with an `image_post` slot:
  - Per-character daily cap (default 3 per sim-day).
  - Cooldown (default 60 sim-min between posts per character).
- On exceeded cap, the verb returns `{ ok: true, verb: "post", args: {...}, image_skipped: true }` and the post goes through as text-only. The character sees `(your camera battery's flat)` perception event so the LLM doesn't keep retrying.

### Slice 4 — `relayPost` accepts tags

- Extend `relayPost(agentId, content, modelTag?, tags?)`.
- Default tags include the existing model attribution; new caller appends NIP-94 `imeta`.
- No back-compat work — sole caller is `post.handler`.

### Slice 5 — UI

- Recap card surfaces image posts: when a `post` event has `image_url`, render the image as a small thumbnail under the recap quote.
- Inspector context tab — when a `post` action has `image_prompt`, show both the prompt and the generated image.

### Slice 6 — Test

- `e2e/image-post.spec.ts`:
  - Spawn Maya, force a `post` with `image_prompt: "morning light on a silver pocket watch on a wooden table"` via `POST /actions/admin-emit` (a debug endpoint we may need to add) OR by patching her about to nudge her to post an image and waiting.
  - Assert: kind:1 event on the relay has an `imeta` tag with the URL.
  - Assert: the URL responds 200 with `image/*` MIME.
  - Assert: the recap that includes this post shows the image_url field.

## Acceptance

- LLM emits `{verb: "post", args: {text, image_prompt}}` and the bridge produces a kind:1 with the image attached.
- Image uploads to S3, accessible via public URL.
- NIP-94 `imeta` tag carries url + mime + sha.
- Post-image quota prevents Maya from spamming 50 images / sim-day.
- Inspector + recap render the image as a thumbnail.

## Non-goals

- Multi-image posts (NIP-94 supports it; defer).
- Player-uploaded images.
- Reply-with-image to other posts.
- Video.
- Editing / regenerating an image after the post.

## Risk notes

- FLUX safety filters — the `MIN_AVATAR_BYTES` retry pattern catches blank/blocked frames. Keep that retry logic in the generic helper.
- Cost: one image post is ~$0.01–0.05. Default cap of 3/sim-day per character keeps an active Maya at ~$0.30/sim-day worst case. Reasonable for demo; throttle harder if we land production.
- Image prompts can drift from voice. The verb's `prompt` field carries the audience nudge; if generated images feel off, it's a prompt-tuning task.
