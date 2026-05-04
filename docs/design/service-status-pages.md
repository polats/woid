# Service-status pages — flux-kontext / trellis / hunyuan3d / unirig

> Generalize the persona-api status pattern across every external
> service the bridge talks to, with a single backend module and a
> single frontend component family. Adds a "wake" button so operators
> can trigger cold-start from the UI rather than waiting for the next
> generation request to do it. Adds per-service call history.
>
> Goal: zero duplicated code across the four services.

## What exists today (the model to copy)

The persona path already has the full shape we want:

| Layer | File | What it does |
|---|---|---|
| Bridge: log buffer | `pi-bridge/persona-log.js` | append-only on-disk JSONL of every persona call (id, ts, ok, durationMs, model, name, error, imagePrompt) |
| Bridge: status endpoint | `pi-bridge/server.js#/v1/personas/status` | `{ quota, providers, recent: { ok24h, fail24h, p50ms } }` |
| Bridge: list endpoint | `pi-bridge/server.js#/v1/personas/log` | paginated entries |
| Bridge: detail endpoint | `pi-bridge/server.js#/v1/personas/log/:id` | full record |
| Frontend: sidebar widget | `src/layout/PersonaApiStatus.jsx` | dot + label, polls `/v1/personas/status`, level=green/amber/red |
| Frontend: dashboard | `src/views/Personas.jsx` | rate-limit + 24h stats header, recent log table, click-to-detail |

Generalizing this for **flux-kontext, trellis, hunyuan3d, unirig** without copy-paste is the whole exercise.

## Design

### One backend module per concept, parameterized by service

Two new modules; everything else is wiring.

**`pi-bridge/service-registry.js`** — single source of truth for what services we have. The other modules iterate over this registry.

```js
export const SERVICES = {
  'flux-kontext': {
    label: 'FLUX.1 Kontext',
    kind:  'nim',                          // probe shape: NIM /v1/health/ready
    url:   () => process.env.FLUX_KONTEXT_URL,
    description: 'Image-to-image edit (T-pose generation).',
    coldBudgetMs: 18 * 60 * 1000,
    warmEtaSeconds: 15,
    coldEtaSeconds: 480,
  },
  'trellis': {
    label: 'TRELLIS',
    kind:  'nim',
    url:   () => process.env.TRELLIS_URL,
    description: 'Image-to-3D mesh.',
    coldBudgetMs: 18 * 60 * 1000,
    warmEtaSeconds: 25,
    coldEtaSeconds: 480,
  },
  'hunyuan3d': {
    label: 'Hunyuan3D-2',
    kind:  'tencent',                      // probe shape: GET / (any 2xx-4xx = warm)
    url:   () => process.env.HUNYUAN3D_URL,
    description: 'Image-to-3D mesh (alternate backend).',
    coldBudgetMs: 5 * 60 * 1000,
    warmEtaSeconds: 70,
    coldEtaSeconds: 150,
  },
  'unirig': {
    label: 'UniRig',
    kind:  'local',
    url:   () => process.env.UNIRIG_URL ?? 'http://172.17.0.1:8081',
    description: 'Auto-rigging (local Docker, always warm).',
    coldBudgetMs: 60_000,
    warmEtaSeconds: 40,
    coldEtaSeconds: 30,
  },
};
```

**`pi-bridge/service-state.js`** — single-flight warm cache + uptime tracking, designed against the `kind` taxonomy so we don't branch in callers. The full design was sketched in the previous turn; one Map keyed by service URL, status enum, awaitable Promise during warming, 60s warm-cache TTL.

**`pi-bridge/service-log.js`** — generic version of `persona-log.js`. Takes a service name when you log; persists to `service-log.jsonl` with `{service, id, ts, ok, durationMs, kind, ...extra}`. Same JSONL ring buffer approach.

### Three call sites, one helper

The existing SSE handlers (`generate-tpose/stream`, `generate-model/stream` for both backends) wrap fetches by hand. Refactor to one helper that does (single-flight wake → recordCall → log → return), so each handler becomes ~10 lines. Roughly:

```js
import { ensureWarm }       from './service-state.js';
import { record }           from './service-log.js';
import { SERVICES }         from './service-registry.js';

async function callService(name, { fetcher, send }) {
  const cfg = SERVICES[name];
  const callId = newId();
  const t0 = Date.now();
  await ensureWarm(cfg, { onHeartbeat: hb => send?.('heartbeat', hb), onStage: s => send?.('stage', s) });
  try {
    const out = await fetcher();
    record(name, { id: callId, ok: true, durationMs: Date.now() - t0, ...summarize(out) });
    return out;
  } catch (err) {
    record(name, { id: callId, ok: false, durationMs: Date.now() - t0, error: err.message });
    throw err;
  }
}
```

Mesh + tpose handlers each call `callService('trellis', { fetcher: () => callTrellisMesh({tpose}) })` etc. Net: zero shared code in the call sites.

### Generic endpoints (replace per-service hardcoding)

```
GET  /v1/services                          list all + state + 24h stats
GET  /v1/services/:name                    single service detail
GET  /v1/services/:name/status             { state, lastWarm, inFlight, recent: {ok24h, fail24h, p50ms} }
POST /v1/services/:name/wake               idempotent warm; returns when warm or budget hit
GET  /v1/services/:name/log?limit=&cursor= recent calls
GET  /v1/services/:name/log/:id            single call
```

`/v1/services/:name/status` is exactly the shape the existing `PersonaApiStatus.jsx` consumes from `/v1/personas/status`, so the frontend dot widget is identical between persona and services. Persona stays at `/v1/personas/*` for back-compat — same shape, different namespace.

### Frontend: one generic widget + one generic page

**`src/layout/ApiStatusBadge.jsx`** — generic version of the existing
`PersonaApiStatus.jsx`. Takes a service name + display label, polls
`/v1/services/:name/status` every 30 s. Render is identical to
existing dot+label. Levels:

- `green`  state=warm, no failures in 24h
- `amber`  warming, OR fail24h > 0, OR in-flight > 0
- `red`    state=failed, OR fetch error
- `grey`   state=unknown (never probed)

**`src/views/ApiStatusPage.jsx`** — generic equivalent of `Personas.jsx`. Renders:

- Header: service label + description
- Top stats row:
  - state badge (warm / warming / cold / failed)
  - in-flight count
  - last-warm timestamp (`5m ago`)
  - 24h: ok / fail / p50 / p95
  - **Wake button** — POSTs `/v1/services/:name/wake`, shows progress (uses the SSE-style heartbeat from the wake response or falls back to spinner+timer)
- Recent log table — same shape as existing personas log, sorted desc
- Click row → modal with full call detail (request size, response size, error, traceback if present)

Per-service tweaks (kind-specific badges in the table) come through small render hooks on the registry — e.g. `trellis` rows include `octree_resolution`, hunyuan rows include `texture:true`. The page itself is service-agnostic.

**Routes** — wire one route per service that mounts the same page:

```js
{ path: '#/services/flux-kontext', component: () => <ApiStatusPage service="flux-kontext" /> },
{ path: '#/services/trellis',      component: () => <ApiStatusPage service="trellis" /> },
{ path: '#/services/hunyuan3d',    component: () => <ApiStatusPage service="hunyuan3d" /> },
{ path: '#/services/unirig',       component: () => <ApiStatusPage service="unirig" /> },
```

**Sidebar** — append four `<ApiStatusBadge service={name} />` next to the existing `<PersonaApiStatus>`. Could also auto-render from a `/v1/services` fetch so adding a new service is zero front-end code, but explicit routes are easier to navigate. Defer that until we have more than four.

## What does NOT get duplicated

| Concern | Single source |
|---|---|
| Service definitions (URL, label, ETAs, probe-shape) | `service-registry.js` |
| Probe + warmup logic | `service-state.js#ensureWarm` |
| Call log persistence | `service-log.js` |
| Status endpoint shape | `service-state.js#snapshot` |
| Status dot rendering | `ApiStatusBadge.jsx` |
| Status page rendering | `ApiStatusPage.jsx` |
| Wake button + progress display | inside `ApiStatusPage.jsx` |
| Polling cadence + level computation | inside `ApiStatusBadge.jsx` |

The only per-service code is the small block that calls the upstream
(e.g. data-URI vs bare base64, NIM JSON vs binary GLB) — that already
exists as `callTrellisMesh` / `callHunyuan3dMesh` from earlier work.

## Migration: persona stays put

`/v1/personas/status` and `Personas.jsx` keep their current paths and
shape. Two ways to reduce duplication later:

1. **Persona log adapts to the new generic** — `persona-log.js`
   re-implements its `recentStats()` over `service-log.js` filtered
   by service name. Same disk schema, single read path. Defer until
   the new module ships.
2. **`Personas.jsx` becomes a thin wrapper** that renders
   `ApiStatusPage` with a `service="persona"` prop and a
   persona-specific row schema. Defer for the same reason.

Don't unify upfront — get the new shape proven for 4 services first,
then collapse. Two passes are cheaper than one big-bang change.

## Build order

1. `service-registry.js` + `service-state.js` (single-flight + cache).
   Verify locally with curl-driven test against the existing 3 SSE
   handlers using the new `ensureWarm`. *No frontend changes yet.*
2. `service-log.js`; refactor mesh/tpose SSE handlers to log via it.
3. New endpoints: `/v1/services`, `/v1/services/:name/{status,wake,log,log/:id}`.
4. Frontend `ApiStatusBadge.jsx`. Add four to sidebar.
5. Frontend `ApiStatusPage.jsx`. Wire routes. Wake button.
6. Optional: collapse persona path onto the new modules (Pass 2).

Step 1 alone is what unblocks the parallel-runs work the operator
actually wants — so it's pulled forward as a milestone before any
frontend work.

Total: ~5–6 hours focused work for the full surface, ~1 hour for just
step 1.

## Open decisions

1. **Should `wake` be SSE or single response?** SSE lets us stream
   cold-start heartbeats to the page (which feels alive); single
   response is simpler. Recommendation: SSE — same shape as the
   existing tpose/model streams, the page already needs to consume
   SSE for the in-progress generation indicator.

2. **Unirig in the picker?** It's local, always warm. Including it
   for symmetry is cheap. Recommendation: include.

3. **Quotas / rate-limits.** The persona endpoints carry an
   `apiQuota` middleware. Mesh / tpose already do. The wake endpoint
   shouldn't — it's idempotent, and rate-limiting it would defeat
   the "operator can pre-warm before a demo" use case. Keep wake
   un-quotad; the inference calls remain quotad.

4. **Where does the call log live?** `persona-log.js` writes to a
   single JSONL file per process. With four services and a generic
   log we have two reasonable shapes:
   - One `service-log.jsonl` with a `service` field. Simpler.
   - One file per service: `services/<name>.jsonl`. Better for
     log rotation + per-service retention.
   Recommendation: single file with `service` field for now; switch
   to per-service later if log volume grows.

5. **Probe semantics across kinds.** NIM exposes `/v1/health/ready`,
   hunyuan exposes nothing dedicated, unirig has its own
   `/v1/health/ready`. The registry's `kind` field plus a small
   strategy table inside `service-state.js` keeps callers
   uniform.

## What this fixes

- **Double-tap cold starts** — single-flight `ensureWarm` means N
  concurrent SSE flows = 1 probe loop.
- **State source of truth** — `/v1/services/:name/status` is the one
  place external tools read from.
- **Operator wake control** — page-level "Wake" button replaces the
  current "fire a generation request and hope" flow.
- **Per-service history** — same dashboard pattern as personas, so
  debugging "did my last 5 trellis calls all 502?" is one URL away.
- **No code duplication** — every per-service file is a registry
  entry plus an upstream-specific fetch helper; everything else is
  generic.
