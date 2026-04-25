---
name: Storage scale-out phase 2 — SQLite character store + S3-only avatars
description: Replace the per-character directory layout with a single SQLite database for manifests, push avatars fully to S3, and stream session logs off the bridge volume. Lifts the cap from ~thousands to ~tens of thousands stored.
status: todo
order: 215
epic: agent-sandbox
---

Depends on #205 (cache + multi-room) being in place. That gets us to ~thousands of stored characters comfortably; this card targets the next order of magnitude.

The current model — one filesystem directory per character — has three structural costs that compound as N grows:

- **Inode pressure:** ~10 inodes per character. 10K chars = 100K inodes; 100K chars = a million. Filesystems handle it but the volume becomes hard to back up, replicate, or move.
- **Volume size:** session.jsonl growth is unbounded. At 10 turns/min × 1 KB/turn × 1000 active × 24h ≈ 14 GB/day. The Railway volume isn't sized for this.
- **No real query layer:** "all characters whose harness=external" or "all characters who haven't moved in a week" require scanning every directory. The cache from #205 helps for the full list but not for filtered queries.

## Deliverables

### SQLite character store

- `agent-sandbox/pi-bridge/store.js` — opens (or migrates to) `$WORKSPACE/characters.db` (SQLite via `better-sqlite3`).
- Table `characters` with columns mirroring `agent.json`:
  - `pubkey` (PK, hex), `npub`, `name`, `about`, `state`, `mood_energy`, `mood_social`, `model`, `harness`, `prompt_style`, `avatar_url`, `profile_source`, `profile_model`, `created_at`, `updated_at`
- `sk.hex` stays on disk per-character (file-level mode 0600 is more defensible than a column in a DB everyone reads).
  - Path: `$WORKSPACE/keys/<pubkey>.hex` — flatter, no per-character dir.
- All callers of `loadCharacter`, `saveCharacterManifest`, `listCharacters`, `findAgentByPubkey`, `activeRuntimeForCharacter` go through `store.js`.
- The cache from #205 collapses into a thin layer over the DB — DB lookups are already O(log N); the cache becomes optional.

### Migration path

- One-shot script `scripts/migrate-fs-to-sqlite.mjs`:
  1. Reads every existing `$WORKSPACE/characters/<npub>/` dir.
  2. Inserts manifest fields into the new SQLite DB.
  3. Moves `sk.hex` to `$WORKSPACE/keys/<pubkey>.hex`.
  4. Leaves session.jsonl / turns.jsonl in place (handled by the next deliverable).
  5. Renames the old per-character dir to `<npub>.migrated` rather than deleting (rollback-safe).
- Bridge boots run a one-shot check: if `characters.db` exists, use it; else if any per-character dirs exist, log "run migrate script" and refuse to start; else fresh.

### S3-only avatars

- After the bridge has S3 configured, stop writing the local mirror. The current dual-write was insurance against missing S3; once we trust the bucket, drop it.
- `GET /characters/:pubkey/avatar` fetches from S3 directly (the route already does S3-first, falls back to disk). After this change, the disk path stops existing.
- One-shot avatar migration: walk all characters, upload any `avatar.jpg` to S3, update `avatar_url` to `${PUBLIC_BRIDGE_URL}/characters/...` (path stays the same since the route handler is unchanged).

### Session log offload

Session JSONL stays append-only on the bridge volume **unless the volume is filling up**. Add:

- `SESSION_LOG_TARGET=local|s3` env (default `local`).
- When `s3`: rotate `session.jsonl` / `turns.jsonl` to S3 once per day or when over 10 MB; keep the most recent file local for fast tail-reads.
- New endpoints `/characters/:pubkey/turns?archive=true` to fetch from S3 transparently when the local file is empty.

This is the only piece that's optional — small deployments stay on local disk forever and never notice.

## Acceptance

- 10,000 character manifests in SQLite. `listCharacters()` (now `getCharacters`) responds in <20 ms. Lookup by pubkey is <1 ms.
- Migration script runs cleanly against a real workspace: every character round-trips through the DB intact (PATCH then GET returns identical data).
- Avatars fully on S3 — `du -sh $WORKSPACE` no longer grows with avatar generations.
- With `SESSION_LOG_TARGET=s3`, the volume size stays bounded at ~10 MB per active agent regardless of session age.
- 38+ tests still pass. Add ~10 new tests for the store layer: insert, get, list, update, delete, concurrent writes (single-process so this is just sequential), missing key behavior.

## Non-goals

- Postgres / multi-bridge horizontal scaling (when one SQLite-backed bridge isn't enough, the right move is sharded multi-bridge — a different card).
- Object-storage migration of admin / persona-log / .pi/skills (not bottlenecks).
- Real-time replication / HA (single bridge with a backed-up SQLite file is the durability story; no live replicas).

## Risk notes

- SQLite + `better-sqlite3` is one C++ binary in the container. We've avoided native deps so far — adding one is a deliberate trade for performance + reliability.
- Schema migrations: bake in a `schema_version` table from day one so future changes (mood as a JSON column, multi-mood dimensions, etc.) have an obvious migration target.
- Backups: a SQLite file is easier to back up than a directory tree of millions of files. Add a nightly `cp characters.db characters.db.bak` cron + S3 sync.
