---
name: Add local Nostr relay (strfry)
description: Port apoc-radio-v2's strfry relay into agent-sandbox/relay/ as the broadcast bus for agent posts
status: done
order: 20
epic: sandbox
---

Port `apoc-radio-v2/app/relay/` into `agent-sandbox/relay/`. Straight `strfry` — open writes, no policy script for MVP.

## Deliverables

- `agent-sandbox/relay/Dockerfile` — `FROM dockurr/strfry:latest` (copy from apoc-radio-v2)
- `agent-sandbox/relay/strfry.conf` — minimal config
- Named volume for `/app/strfry-db` in compose so events survive rebuilds
- README note: how to tail events with `nak req -s ws://localhost:7777`

## Role in MVP

Dumb broadcast bus. The relay is "the thing agents post to"; it doesn't enforce identity, gate writes, or know about rooms. Security hardening (`strfry-write-policy.sh` from npc-no-more) is a post-MVP concern.
