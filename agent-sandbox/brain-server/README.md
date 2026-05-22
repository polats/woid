# brain-server

Transport-agnostic HTTP server hosting woid's harness logic. Sbox (and
later mobile, web, anything else) talks to this single port to drive
characters. Contract: `examples/woid/CONTRACT.md` in `polats/sbox-public`.

## Quick start

```bash
cd agent-sandbox/brain-server
npm install
npm start
# → brain-server listening on http://127.0.0.1:8080
```

## First-slice MVP (v0.1.0)

Five endpoints, hard-coded utility brain, in-memory state. Sufficient
for sbox's "1 NPC sits on chair" e2e milestone.

| Endpoint | Status |
|---|---|
| `GET  /status`              | ✓ utility-only, no model |
| `GET  /verbs`               | ✓ one verb (`sit`) |
| `POST /character`           | ✓ idempotent on id |
| `GET  /character/:id`       | ✓ |
| `POST /brain/step`          | ✓ hard-coded rule: energy<50 → sit |
| `GET  /brain/trace/:id`     | ✓ ring buffer of recent traces |

Not yet implemented: `/verb/resolve`, `/perception/*`, `/persona/generate`,
`/storyteller/*`, `/brain/observation/:id`, `/brain/actions/:id`,
`/brain/stats/:id`, SSE upgrade, llama-server child spawn.

## Curl smoke test

```bash
# 1. Service alive
curl -s localhost:8080/status | jq

# 2. Spawn a character
curl -s -X POST localhost:8080/character \
  -H 'content-type: application/json' \
  -d '{"id":"alice","identity":{"name":"Alice","about":"sleepy"}}' | jq

# 3. Brain tick — high energy → idle
curl -s -X POST localhost:8080/brain/step \
  -H 'content-type: application/json' \
  -d '{"selfId":"alice","tick":1,"trigger":{"kind":"heartbeat"},"perception":[],"needs":{"energy":80}}' | jq

# 4. Brain tick — low energy → sit
curl -s -X POST localhost:8080/brain/step \
  -H 'content-type: application/json' \
  -d '{"selfId":"alice","tick":2,"trigger":{"kind":"heartbeat"},"perception":[],"needs":{"energy":12}}' | jq

# 5. Recent trace
curl -s localhost:8080/brain/trace/alice | jq
```

## Architecture notes

- **Single Node process**, single port. See CONTRACT.md.
- **No Colyseus knowledge**: brain-server is transport-agnostic. Sbox
  uses native multiplayer; brain-server just answers HTTP per-tick.
- **Future**: spawns upstream `llama-server` as a child when
  `BRAIN_LLM_PROVIDER=llama-server`. Provider abstraction shared with
  mobile (`src/lib/gemmaLocal.js`) via `LlmAdapter` interface.
- **State is in-memory**. On restart, sbox re-POSTs `/character` for each
  active character. Idempotent on id.
