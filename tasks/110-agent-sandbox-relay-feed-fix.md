---
name: Fix relay feed not rendering live events
description: UI pane shows "Waiting for events…" even when the relay has kind:1 events (confirmed via direct WS REQ in e2e). SimplePool subscription in useRelayFeed isn't firing in-browser.
status: done
order: 110
epic: agent-sandbox
---

The e2e test proves events hit the relay (direct `REQ` over WebSocket succeeds). But `src/hooks/useRelayFeed.js` — which uses `nostr-tools`' `SimplePool.subscribeMany` — never populates the right-pane feed in the UI.

Most likely: `SimplePool` subtly misbehaves in the browser with a single relay URL, or the filter syntax silently rejects. Replace with raw WebSocket + REQ/EVENT like the e2e does. Keeps a dependency-light implementation and matches what we know works.

## Deliverables

- Rewrite `useRelayFeed` with native `WebSocket`. Open connection, send `["REQ", id, {kinds, limit}]`, push each `EVENT` to state, deduplicate by `id`. Reconnect with backoff on close.
- Keep the same return shape `{ events, status }`.
- Once admin announcements (task #090) land, the feed should populate within ~1s of spawning an agent — good validation signal.

## Acceptance

- Clean load of `#/agent-sandbox`, spawn an agent, see at least one event in the relay feed pane within 5 seconds (the admin welcome).
- Existing e2e still passes.
