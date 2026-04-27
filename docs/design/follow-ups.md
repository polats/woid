# Follow-ups — sleep, image posts, sim-time on triggers

Three tracked items pulled out of the Maya-day slice. Each has a clear scope and a "when to ship" gate.

## 1. Sleep silence — multi-character compatibility

**Today.** The `use(bed)` effect chain calls `simClock.advance(8 * 60 * 60_000)`, jumping sim-time forward 8 sim-hours. For solo Maya this works perfectly: the next heartbeat fires after 30–60 real-sec and reads "Day N+0 · 06:00 morning" — she wakes up.

**Where it breaks.** A multi-character world would have other agents experience the sim-clock leap as 8 hours of teleported time without their consent. They'd see Maya disappear-and-reappear with no narrative explanation. For [#305](../../tasks/305-card-pool-and-day1.md)'s storyteller-driven cast, this is wrong.

**The right fix (later).** Per-character sleep state on the heartbeat scheduler:

```js
scheduler.attach(rec, { asleep_until_sim_minutes: 14 * 60 })
```

When the heartbeat fires, if `asleep_until_sim_minutes > simClock.now().sim_minutes`, skip the turn (no LLM call, no perception drain). When sim-time crosses the threshold, automatically clear and emit a `woke_up` perception event so the LLM sees `(you woke at 06:00)` on its first morning turn.

This **replaces** the `advance_sim` effect — `use(bed)` becomes:

```js
{ kind: "asleep_until", offset_sim_minutes: 8 * 60 }   // sleeps 8 sim-hours
```

The sim-clock advances naturally; only this character is paused.

**When to ship.** When [#305](../../tasks/305-card-pool-and-day1.md) lands the second character. Right now `advance_sim` is good enough and ships zero risk.

**Task.** [#345](../../tasks/345-sleep-silence-scheduler.md) — created below.

---

## 2. Image posts — Maya posts photographs alongside her text

The hook from her `about` is right there: *"keeps a silver pocket watch she found in the attic"*. Photographs of small mundane objects fit her voice perfectly. Right now `post` writes pure text to Nostr; we have a working FLUX image pipeline already (`generateAvatarBytes` in [server.js:902](../../agent-sandbox/pi-bridge/server.js)) and S3 storage. Extending the loop is small.

### API

Extend the existing `post` verb (don't add a new verb — keeps the LLM's surface compact):

```js
post: {
  args: {
    text: { type: "string", required: true, max: POST_LIMIT },
    image_prompt: { type: "string", required: false, max: 400 },
  },
  effects: ["relay.kind1", "image.gen"],
  prompt: `public social post → goes to your Nostr followers' feeds. RARE and DELIBERATE — only when worth broadcasting. Pass an optional 'image_prompt' to attach a generated photograph (small mundane things work better than landscapes; describe the lighting and the framing).`,
}
```

LLM emits `{ verb: "post", args: { text: "...", image_prompt: "morning light on a silver pocket watch on a wooden table" } }` when an image fits.

### Pipeline

1. `post` handler — if `image_prompt` is set:
2. Call `generateImageBytes({ prompt })` — refactor `generateAvatarBytes` to take an arbitrary prompt (drop the `name + about` portrait framing).
3. Upload to S3 under `posts/<pubkey>/<short-id>.<ext>` (new `s3.putPostImage` helper).
4. Build kind:1 event with **NIP-94 `imeta` tag** containing the URL + dim/sha:
   ```
   ["imeta",
     "url https://...",
     "m image/jpeg",
     "x <sha256>"
   ]
   ```
5. Append the URL to the content body (most clients render it as an inline image): `${text}\n\n${imageUrl}`.
6. `relayPost` already handles publish — extend its signature to accept optional tags.

### Cost / throttling

FLUX calls aren't free. Without throttling Maya could post 50 images a day at fast cadence.

- **Per-character daily cap** (default 3 image posts per sim-day). Tracked in `apiQuota` (already exists for avatar gen — add a `image_post` slot).
- **Cooldown** (60 sim-min between image posts per character).
- **Prompt nudge** in the verb's `prompt` field discourages spam: *"images are rare — once or twice a day, when something specifically visual is worth showing."*

### Tonal calibration

The LLM's prompt for "should this be image-worthy" needs guidance. From [vertical-slice.md](vertical-slice.md):

> Audience-tuned image post grammar:
> - **Mundane > spectacular.** A coffee cup at golden hour > a dramatic landscape.
> - **Specific > generic.** "Eira's red kettle on the windowsill" > "morning kitchen vibes."
> - **Personal > observational.** Her own things, her own light.

A small nudge in the verb prompt covers this without a separate voice doc.

### Subtasks

| Slice | Effort |
|---|---|
| Refactor `generateAvatarBytes` → `generateImageBytes` (parametric prompt, return shared bytes/mime/ext shape) | ~30m |
| `s3.putPostImage` helper, posts/ prefix | ~15m |
| `post` verb gains `image_prompt` arg + handler branch | ~30m |
| Image-quota slot in `apiQuota` (per-character per-sim-day cap) | ~30m |
| `relayPost` extended with optional tags array (NIP-94 imeta) | ~30m |
| LLM verb prompt + tonal nudge | ~10m |
| e2e: spawn Maya, poke a `post` with image_prompt, verify kind:1 with imeta tag, verify image renders in the relay's stored event | ~45m |

**~3 hours total. Task: [#355](../../tasks/355-image-posts.md).**

### What this isn't

- Not arbitrary user-uploaded images. Generated only.
- Not video. FLUX returns stills.
- Not a "share this image" action separate from posting — image-posts go through `post` to keep the action surface narrow.
- Not multi-image. One image per post (NIP-94 supports multiple `imeta` tags but our LLM doesn't need that complexity yet).

---

## 3. Sim-time on every turn — small + immediate

The user-turn prompt currently opens with:

```
Trigger: A moment has passed. You're still here, still listening.

You are at (3, 1).
```

It should open with:

```
Trigger: A moment has passed. You're still here, still listening.
When: 2026-04-26 17:46 (real) · Day 11 · 09:14 morning (sim)

You are at (3, 1).
```

This gives the LLM:
- A real-world clock so timestamps in events make sense
- A sim-clock so sleep / schedule / "noon" decisions are grounded
- The slot label so she can self-narrate ("by mid-afternoon, …")

### Implementation

- `buildUserTurn` accepts a new `simNow` arg (the `simClock.now()` snapshot).
- After the `Trigger:` line, append a `When:` line with both clocks.
- Wire from `server.js`'s call site (one new arg).

Tiny change. Shipping now in this turn.

---

## What I'm NOT planning right now (parking lot)

- **Schedule edit UI** — clickable slot rows in the Schedule drawer tab to PATCH overrides. Worthwhile, not blocking.
- **Multi-image posts** (collages, before/after).
- **Image generation for scene_close moments** (auto-snapshot of the moment two characters had a meaningful exchange). Cool but expensive.
- **Voice / TTS for posts.** Tomodachi-style. Way later.
- **Post threading / reply chains.** Nostr supports it via `e` tags; defer until two characters are running and likely to reply.
