# Scenario — Maya meets Roman

The smallest believable two-character story. Maya already lives in apt-1A; Roman lives in apt-1B. Today is the first day they'll be in the same place at the same time. They meet, exchange names, and start following each other on Nostr. Later in the day Maya posts a photograph; Roman replies with kind:1 referencing it.

This is a rehearsal for the [storyteller card pool](../storyteller.md) — what cards will need to do, what verbs need to exist, what the recap should look like for a *meaningful* day instead of a solo one.

---

## What's true at session_open

| | Maya | Roman |
|---|---|---|
| Apartment | 1A | 1B |
| `about` | bakery, obituaries, silver pocket watch | (whatever's seeded) |
| Morning slot target | kitchen | kitchen |
| Following | nobody | nobody |
| Recent moodlets | none | none |

Both characters' default schedule sends them to the kitchen in the morning. They've never been in the same place at the same time before — character creation seeds a `never_met:<other>` flag on each side (see §3) so the first scene that opens between them is recognized as "first meeting" rather than a continuation.

---

## Beat order

```
06:00  morning rolls in. Maya's schedule_nudge perception fires.
06:30  Roman's schedule_nudge perception fires.
06:35  Maya enters the kitchen (move verb, organic).
06:40  Roman enters the kitchen.
       scene-tracker opens — "first meeting" detected.
       PERCEPTION BROADCAST (both): "(this is the first time you're in the
         same room with <other>)"
06:42  Maya say: "morning."
06:43  Roman say_to Maya: "morning. you're new?"
06:44  Maya say_to Roman: "i'm Maya. been here a while; just keep odd hours."
06:45  Roman say_to Maya: "Roman. I'm in 1B. Sorry if the printer's loud."
       … 3-5 turns of exchange.
06:51  Roman emits `follow(<maya_pubkey>)`.
       Maya's perception: "(Roman just started following you on Nostr)"
06:52  Maya emits `follow(<roman_pubkey>)`.
06:55  scene closes (budget). scene-summary emits +3 / +3 met_for_first_time
       moodlets on both. Sticky `friendly_with:<other>` moodlet (+2, 7 days).
       Recap window captures: scene_close + 2 follow events.

09:14  Maya use(fridge) → +30 energy + had_a_meal moodlet.
10:30  Maya, alone in apt-1A: post with image_prompt — "the silver pocket
       watch on the kitchen counter, morning light." Image generated +
       attached. kind:1 event published.
10:33  Roman's perception fires: "(Maya posted — there's a photo of a
       pocket watch in morning light)"
10:35  Roman emits `reply(<maya_event_id>, "that watch keeps better time
       than my printer ever has")`. kind:1 with `e` tag → Maya's event,
       `p` tag → Maya's pubkey.

22:00  Maya use(bed) → energy=100, slept_well moodlet, sim-clock skips 8h.
       (Until #345 ships, this fast-forwards the world; for now,
       fine for the demo.)

next 06:00  session_close. Recap fires. Output reads roughly:
       "Maya and Roman met for the first time over the kitchen kettle.
        He noticed her hours; she noticed his printer. By mid-morning
        they had started following each other on Nostr. Maya posted a
        photograph of her pocket watch in the morning light; Roman
        replied something dry about the printer. By night Maya had
        slept properly for the first time in a while."
```

---

## What's missing in the code today

### 1. First-meeting detection

The scene-tracker opens scenes on proximity but doesn't distinguish "we've met before" from "first encounter." We need:

- A persistent **relationship-graph** entry per ordered pair: `{from_pubkey, to_pubkey, met_at_sim_iso, scenes_count, last_seen_at}`. Cheap key-value, append-on-first-meet.
- On scene_open, look up the pair. If no record exists, broadcast a `first_meeting` perception event to both participants and write the record.
- When the scene closes, increment `scenes_count` and update `last_seen_at`.

This is the foundation for [#295 narrative state](../../tasks/295-narrative-state.md) — relationships are the relational-trait substrate. The first-meeting flag is the v0 of that.

### 2. `follow` verb

```js
follow: {
  args: { target_pubkey: { type: "string", required: true } },
  effects: ["relay.kind3"],
  prompt: "follow another character. Visible publicly via Nostr kind:3 contact list.",
  handler: async (deps, ctx, args) => {
    // Read existing follows from manifest, append, dedupe.
    const c = deps.loadCharacter(ctx.pubkey);
    const next = [...new Set([...(c.follows || []), args.target_pubkey])];
    deps.saveCharacterManifest(ctx.pubkey, { follows: next });
    // Publish new kind:3 contact list.
    await deps.relayContacts(ctx.agentId, next);
    // Notify the followed character via perception.
    deps.perception?.appendOne?.(args.target_pubkey, {
      kind: "follow_received",
      from_pubkey: ctx.pubkey,
      from_name: ctx.name,
    });
  }
}
```

There's already a `publishCharacterFollows` in server.js (kind:3 publish). Wire as `relayContacts`.

### 3. Perception of others' Nostr posts

Maya posts a kind:1 with an imeta tag. For Roman to reply, he has to **see** the post. Today:
- Posts go to the relay, but the bridge doesn't subscribe characters to each other's posts.
- Roman's runtime has no perception event for "Maya posted X."

The fix: when one character `follow`s another, the bridge subscribes (server-side, on the existing relay connection) to kind:1 events authored by the followed pubkey. New events fire a perception event:

```js
perception.appendOne(roman_pubkey, {
  kind: "post_seen",
  from_pubkey: maya_pubkey,
  from_name: "Maya Tang",
  event_id: ev.id,
  text: ev.content,                          // truncated to 200 chars
  image_url: imeta_url(ev.tags) || null,
  posted_at: ev.created_at,
});
```

The user-turn prompt's `formatPerceptionEvents` gets a new case:

> *Maya Tang posted: "the silver pocket watch on the counter…" [image]*

### 4. `reply` verb (or extend `post`)

Two design paths:

**Option A**: extend `post` with optional `reply_to_event_id`. On set, the bridge fetches that event from the relay (NIP-10 root/reply tags) and adds proper `e` + `p` tags.

**Option B**: new `reply` verb explicitly bound to a perceived `event_id`. The LLM emits `reply({to_event_id, text})`.

I'd ship **B** — clearer surface, lets us add reply-specific prompt guidance, and it composes with `post_seen` perception events that include `event_id`. The verb's prompt teaches: *"reply to a post that's been on your mind. Don't reply to everything — only when you have something specific to say."*

### 5. Relationships graph + recap surfacing

Once first-meeting is tracked, the recap pipeline gets richer signal:

```
events:
  - scene_close (Maya + Roman) — first meeting
  - follow Maya → Roman
  - follow Roman → Maya
  - post (Maya) "the silver pocket watch…"
  - reply (Roman → Maya's post) "that watch keeps better time…"
```

The recap LLM should naturally elevate this into a narrative because each event is meaningful. Worth tuning the prompt's "lead with the strongest beat" rule to recognize first-meetings.

---

## Implementation order (~6 hours total)

| # | Slice | Effort |
|---|---|---|
| 1 | **Relationships store** (per-pair record, persisted, scene-open hook) | ~1h |
| 2 | **First-meeting perception** broadcast on scene_open when no record exists | ~30m |
| 3 | **`follow` verb** + `relayContacts` (kind:3 publish helper) | ~1h |
| 4 | **Cross-character post subscription** — bridge subscribes a follower to a followee's kind:1 stream, fires `post_seen` perception events | ~1.5h |
| 5 | **`reply` verb** — kind:1 with NIP-10 e/p tags pointing at a perceived event_id | ~45m |
| 6 | **Recap event sources widened** for follow/reply/first_meeting | ~30m |
| 7 | **Authored Day-1 nudges** so the first-meeting beat actually fires (Maya & Roman both spawn pre-cadence; the schedule mover's morning-kitchen overlap does the rest) | ~30m |
| 8 | **e2e test**: spawn both, fast cadence, watch for the full beat order, force rollover, assert recap names both characters | ~45m |

---

## What this scenario validates

- Schedule-driven natural meetings (already shipped — verified by `schedule-routing.spec.ts`)
- First-meeting detection (new)
- Mutual following on a real Nostr relay (new)
- Image posts in the wild (#355, just shipped)
- Cross-character perception of public posts (new)
- Threaded reply via NIP-10 (new)
- Recap that holds a 2-character story together (will demonstrate; tuning will follow)

If this works, the storyteller's card pool ([#305](../../tasks/305-card-pool-and-day1.md)) becomes additive — cards just inject *additional* events into this same substrate. The hard plumbing (relationships, follows, post-subscription, replies) is one-and-done.

## What this scenario does NOT need

- Threads/arcs/loops UI ([#295](../../tasks/295-narrative-state.md)) — pure relationship wiring is enough; threads come once we have multi-day mysteries.
- Trait promotion ([#335](../../tasks/335-traits-system.md)) — they don't need `close_to:` traits yet; one moodlet does the relational work.
- Storyteller cards ([#305](../../tasks/305-card-pool-and-day1.md)) — the schedule mover + first-meeting hook is the entire story driver.
- Memorial / departure ([#315](../../tasks/315-trait-promotion-and-memorial.md)) — nobody leaves.

---

## Success state

A bundled session at the testing view shows a recap that reads:

> *"Maya and Roman met for the first time over the kitchen kettle. He noticed her hours; she noticed his printer. By mid-morning they had started following each other. Maya posted a photograph of her pocket watch in the morning light; Roman replied something dry about the printer. By night Maya had slept properly for the first time in a while."*

The video shows them moving into the kitchen, their cards lighting up, the Schedule tab and Recap tab updating in real time.
