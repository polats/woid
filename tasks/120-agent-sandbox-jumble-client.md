---
name: Jumble web Nostr client
description: Self-hosted Jumble pinned to the local relay, running at :18089 as a fourth sandbox service
status: done
order: 120
epic: agent-sandbox
---

# 120 — Agent Sandbox: Jumble Nostr client

Self-hosted, full-featured web Nostr client running alongside the sandbox stack
and pinned to the local strfry relay via Jumble's community mode.

## Why

`iris.to`-quality browsing/posting UX over our own relay, runnable as a separate
service. Lets us inspect agent activity (kind:1 posts signed by pi-bridge) in a
real client instead of only via `nak req` or the in-app feed panel.

## What

- `agent-sandbox/jumble/` — upstream `CodyTseng/jumble` as a git submodule (MIT).
- `agent-sandbox/jumble.Dockerfile` — wrapper Dockerfile that injects
  `VITE_COMMUNITY_RELAYS` and `VITE_COMMUNITY_RELAY_SETS` at build time so the
  submodule stays pristine. Two-stage: Node/Vite build → nginx:alpine static serve.
- `agent-sandbox/docker-compose.yml` — adds a `jumble` service on
  `127.0.0.1:18089:80` with community-mode args pointing at `ws://localhost:17777/`.

Community-mode vars are **build-time** (Vite `define` baked into the bundle), so
any relay change requires a rebuild: `docker compose build jumble`.

## Gotcha: insecure connection block

Jumble's `SmartPool.ensureRelay` (`src/lib/smart-pool.ts:22`) rejects `ws://` and
`http://` URLs unless the user has toggled "Allow insecure connections" in
Settings. The rejection is silent — subscribe's `.catch(() => undefined)`
swallows the error, the feed EOSEs with 0 events, and the UI shows "No notes
found / check your connection" with no console error.

Our relay is `ws://localhost:17777`, which trips this check. The Dockerfile
sed-injects a tiny `<script>` into `index.html` that sets
`localStorage.allowInsecureConnection=true` before the app bundle loads, so a
fresh visit Just Works without a settings detour.

Remove this injection once we front the relay with TLS (`wss://`).

## Scope decisions

- **Localhost-only**: browser connects directly to `ws://localhost:17777`, which
  only works when Jumble is opened on the same host as the relay. Public exposure
  requires a reverse proxy fronting the relay on `wss://` — tracked separately
  alongside the general hardening work in the sandbox README.
- **No proxy-server**: upstream ships a `jumble-proxy-server` for URL/metadata
  previews. Skipped for MVP — previews degrade gracefully; add later if needed.
- **Submodule, not fork**: keeps us on upstream's release cadence.

## Done when

- [ ] `npm run agent-sandbox:up` brings up Jumble alongside relay/room-server/pi-bridge.
- [ ] Opening `http://localhost:18089` shows the "Woid Sandbox" relay set preselected and the local relay cannot be removed.
- [ ] Posts from a spawned pi agent appear in Jumble's relay feed.
- [ ] `agent-sandbox/README.md` documents the new service + port.
