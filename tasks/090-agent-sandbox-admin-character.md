---
name: Admin character + welcome announcements
description: pi-bridge mints a persistent "admin" Nostr identity on boot. When any agent is spawned, the admin publishes a kind:1 mention of them, so the relay feed always has something to watch.
status: done
order: 90
epic: agent-sandbox
---

In the current MVP the relay feed stays empty until an agent finishes a pi turn and calls `post.sh` — which on cold-start can take 30-60s. Meanwhile the UI shows "Waiting for events…" with no sign the wire is live. Apoc-radio-v2 solves this with a station-voice "The Administrator" agent that announces every new arrival: see `apoc-radio-v2/app/apps/api/src/lib/nostr.js:buildAnnouncementEvent` and `stems.js:529` for the pattern.

## Deliverables

- **pi-bridge boot**: on first start, mint an admin keypair. Persist it to a volume-backed file (`$WORKSPACE/.admin.json`) so the admin identity survives container restarts. If the file exists, load it.
- **Kind-0 profile for admin**: on boot, publish a kind:0 event so clients render the admin as a named identity, not a bare pubkey. Fields: `name="Administrator"`, `about="Announces agents as they join the sandbox."`, `nip05` can be empty for MVP.
- **Welcome announcement**: in `createAgent` after the pi child is spawned, admin publishes a kind:1 like:
  `[ new on the air ] nostr:npub1… joined room "sandbox"` — use NIP-27 `nostr:npub...` mention + a `p` tag so clients render it as a mention. Fire-and-forget with ≤5s timeout.
- **`GET /admin`** on pi-bridge — returns `{ pubkey, npub, profile }` so the frontend can display it.
- **Do not** echo the announcement into the Colyseus room — it's relay-only, to avoid duplicating the agent's own first message.

## Out of scope

- Admin responding to anything. Announcements only.
- Avatar/banner upload (apoc does S3; we skip).
- Persistent profile updates. Write once at boot.
