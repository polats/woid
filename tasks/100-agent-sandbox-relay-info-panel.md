---
name: Relay info panel in the Sandbox view
description: Surface what relay we're on, the admin identity, and agent counts at the top of the sandbox page so users understand the wiring at a glance.
status: done
order: 100
epic: agent-sandbox
---

New top strip in `src/Sandbox.jsx`, above the three existing panes:

- **Relay URL** (`ws://localhost:17777`) + connection status dot
- **Admin identity** — name + truncated npub + copy button, loaded from `GET /admin` on pi-bridge
- **Relay counts** — total kind:1 events seen, admin post count

This is the piece the user sees *before* they spawn anything, so it should explain what's about to happen.

## Deliverables

- Fetch `GET /admin` on mount; store `adminPubkey`, render name.
- Render a one-line strip with the fields above; keep it compact, single row.
- Reuse existing `useRelayFeed` — compute counts from the events array (total, admins-only).
- Name lookup in the relay feed should use the admin profile too — right now bare pubkeys show as hex. Map admin pubkey → "Administrator".

## Out of scope

- Editing admin metadata (it's set at boot).
- Multiple relays — single URL for now.
