/**
 * Single source of truth for the external services the bridge talks to.
 *
 * Each entry describes one upstream — its URL, how to probe it, how
 * long cold-start typically takes, and how the readiness response
 * shape differs (NIMs use /v1/health/ready, Tencent's hunyuan3d has
 * no dedicated probe so we hit /, etc.).
 *
 * service-state.js iterates over these entries; route handlers and
 * frontend pages reference services by their key (e.g. "flux-kontext").
 */

// Probe strategies. NIM exposes a Kubernetes-style /v1/health/ready
// endpoint that returns 200 when warmed up, 503 when not. Tencent's
// hunyuan3d server exposes nothing — we hit / and treat any quick
// 4xx response as "warm-enough" (the FastAPI router answers 404 for
// unknown paths once it's accepting requests). Local services have
// the fastest path. 429 always means "warm-but-busy" — concurrency=1
// instance is processing some other request — which is fine for our
// "is it warm?" question.
const PROBE_STRATEGIES = {
  nim: {
    path: "/v1/health/ready",
    isWarm: (res) => res.ok || res.status === 429,
  },
  tencent: {
    path: "/",
    // Tencent's hunyuan3d returns 4xx (typically 404) from /; that's
    // "FastAPI is up." Anything <500 means the container is serving.
    isWarm: (res) => (res.status > 0 && res.status < 500) || res.status === 429,
  },
  local: {
    path: "/v1/health/ready",
    isWarm: (res) => res.ok,
  },
};

export const SERVICES = {
  "flux-kontext": {
    label: "FLUX.1 Kontext",
    description: "Image-to-image edit. Used by the Assets tab T-pose generator.",
    kind: "nim",
    urlEnv: "FLUX_KONTEXT_URL",
    coldBudgetMs: 18 * 60 * 1000,
    warmEtaSeconds: 15,
    coldEtaSeconds: 480,
    idleTimeoutMs: 15 * 60 * 1000,    // Cloud Run scales to zero ~15 min after last request
  },
  "trellis": {
    label: "TRELLIS",
    description: "Image-to-3D mesh generator (clean topology, faster).",
    kind: "nim",
    urlEnv: "TRELLIS_URL",
    coldBudgetMs: 18 * 60 * 1000,
    warmEtaSeconds: 25,
    coldEtaSeconds: 480,
    idleTimeoutMs: 15 * 60 * 1000,
  },
  "hunyuan3d": {
    label: "Hunyuan3D-2",
    description: "Image-to-3D mesh (alt backend; better textures).",
    kind: "tencent",
    urlEnv: "HUNYUAN3D_URL",
    // The API doc quotes ~90–150s cold start, but real Cloud Run
    // behavior runs longer when the image cache has been evicted
    // (full pull + GPU init + weight load). 5 min was timing out the
    // wake endpoint repeatedly. Match flux-kontext / trellis at 18 min
    // — same Cloud Run + GPU stack, same worst-case budget.
    coldBudgetMs: 18 * 60 * 1000,
    warmEtaSeconds: 70,
    coldEtaSeconds: 150,
    idleTimeoutMs: 15 * 60 * 1000,
  },
  "unirig": {
    label: "UniRig",
    description: "Auto-rigging (local Docker, always warm).",
    kind: "local",
    // UniRig runs in a sibling container on the host, reachable via
    // host.docker.internal from inside other Docker containers, or via
    // the Docker bridge from the host. Set UNIRIG_URL in the env to
    // override; the default uses host.docker.internal which compose's
    // extra_hosts directive resolves to the host gateway.
    urlEnv: "UNIRIG_URL",
    fallbackUrl: "http://host.docker.internal:8081",
    coldBudgetMs: 60_000,
    warmEtaSeconds: 40,
    coldEtaSeconds: 30,
    idleTimeoutMs: null,              // local container, no scale-to-zero
  },
};

/** Resolve the runtime URL for a service from its env var. */
export function urlOf(name) {
  const cfg = SERVICES[name];
  if (!cfg) return null;
  return process.env[cfg.urlEnv] || cfg.fallbackUrl || "";
}

/** Probe strategy for a service, by kind. */
export function probeStrategyOf(name) {
  const cfg = SERVICES[name];
  if (!cfg) return null;
  return PROBE_STRATEGIES[cfg.kind] || PROBE_STRATEGIES.nim;
}

/** Iterate (name, cfg) pairs for endpoints that list everything. */
export function entries() {
  return Object.entries(SERVICES);
}
