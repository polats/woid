---
name: World — Relationships graph + follow / cross-character perception / reply
description: First-meeting detection, follow verb (kind:3), cross-character post subscription (followee's kind:1 → follower's perception), reply verb (kind:1 with NIP-10 e/p tags). The infrastructure for the Maya-meets-Roman scenario in docs/design/scenarios/.
status: done
order: 365
epic: world
depends_on: [275, 285, 305, 355]
related: [255, 295]
---

Specified in [docs/design/scenarios/maya-meets-roman.md](../docs/design/scenarios/maya-meets-roman.md).

The smallest believable two-character story — Maya meets Roman, they follow each other, Roman replies to Maya's image post — needs five wiring pieces that don't exist yet. This task lands all of them as a coherent vertical so the story actually plays out from a single forced rollover.

## Slices

### Slice 1 — Relationships store

- `agent-sandbox/pi-bridge/relationships.js` — append-only JSONL of per-pair records: `{from_pubkey, to_pubkey, met_at_real_ms, met_at_sim_iso, scenes_count, last_seen_at}`.
- API: `recordMeeting(a, b)`, `bumpScene(a, b)`, `get(a, b)`, `listFor(pubkey)`.
- Hook into scene-tracker `onSnapshot` `opened` events: if no record exists, call `recordMeeting` and broadcast a `first_meeting` perception event to both participants. Subsequent scenes call `bumpScene`.

### Slice 2 — First-meeting perception event

- New perception kind `first_meeting`: `{from_pubkey, from_name, with_pubkey, with_name}`.
- `perception.js` formatter renders: *"(this is the first time you and Roman have been in the same room)"*.
- Recap event source: capture as a session event so the recap can lead with it.

### Slice 3 — `follow` verb + `relayContacts` helper

- `follow` verb in `gm.js`: `{ target_pubkey: string }`. Handler reads existing follows from manifest, appends, dedupes, persists, calls `relayContacts` to publish kind:3.
- `relayContacts(agentId, follows[])` mirrors `relayPost` but for kind:3.
- The followee gets a perception event `follow_received: {from_pubkey, from_name}`.
- Existing `publishCharacterFollows` (already in server.js) is the foundation; just expose it through GM deps.

### Slice 4 — Cross-character post subscription

- When a follow lands, the bridge opens (or extends) a relay subscription on the follower's behalf for kind:1 events authored by the followee.
- New events fire a `post_seen` perception event on the follower: `{from_pubkey, from_name, event_id, text, image_url, posted_at}`.
- Image URL pulled from NIP-94 `imeta` tags on the kind:1 event.
- Subscriptions persist across follow → store the full follow set on the bridge boot and re-subscribe.

### Slice 5 — `reply` verb

- New verb `reply: { to_event_id, text, image_prompt? }`.
- Handler builds a kind:1 with NIP-10 root/reply `e` tags and `p` tag pointing at the original author. Image-post path inherits from the existing `post` verb.
- Verb prompt: "reply to a post that's been on your mind. Don't reply to everything — only when you have something specific to say."

### Slice 6 — Recap event source widening

- Append session events for: `follow` (with target name), `reply` (with target post excerpt + actor's reply text), `first_meeting`.
- `summarizeEventsForRecap` formats each kind for the LLM prompt.

### Slice 7 — e2e test

- `e2e/maya-meets-roman.spec.ts`:
  - Ensure both Maya and Roman are present (workspace seed).
  - Set cadence to 300×.
  - Spawn both at the seeds in their apartments.
  - Inject a visual-inspiration moodlet on Maya so she's likely to image-post.
  - Wait until both have entered the kitchen (poll position).
  - Wait for a closed scene between them.
  - Assert: relationship record created; both have `follow_received` events.
  - Assert: at least one `post` from Maya with `image_url`.
  - Wait for a `reply` from Roman.
  - Force rollover, assert recap mentions both names.

## Acceptance

- Two characters whose schedules send them to the kitchen overlap → scene opens → `first_meeting` perception fires → both see *"this is the first time …"*.
- Either character emits `follow(target)` → kind:3 publishes; followed character sees `(<name> just followed you)` next turn.
- A subscriber sees the followed character's kind:1 posts as `post_seen` perception events with image URL when present.
- `reply(to_event_id, text)` builds a kind:1 with proper NIP-10 tags; the original author sees the reply as `post_seen` (or a new `reply_received`) perception.
- Forced rollover produces a recap that names both characters and references at least the meeting + follow events.

## Non-goals

- Mass following / DM. Public following only.
- Reply to a reply (multi-level threading) — slice 5 supports a flat reply; deeper threading is a v2 ask.
- Block / unfollow. v2.
- Auto-following based on storyteller cards. Cards drive verbs; verbs drive follows.

## Risk notes

- Relay subscriptions cost a connection per character pair if naive. Use one shared subscription per follower with all their followees as authors. Re-derive on follow set changes.
- The `post_seen` event has to dedupe on `event_id` so a relay re-delivery doesn't fire the LLM twice.
- Reply tags must be NIP-10 compliant or downstream Nostr clients won't render the thread. Use root + reply markers.
- Without trait/relationship UI ([#295](295-narrative-state.md)), the relationship state is inspectable only via the bridge. Acceptable for the scenario; UI follows.
