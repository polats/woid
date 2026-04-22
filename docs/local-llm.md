# Running a local LLM for the sandbox

The agent sandbox can drive pi with three providers: NVIDIA NIM (remote),
Google Gemini (remote), and **local** — an OpenAI-compat server you run on
your own machine. This guide walks through standing up the local option
with a llama.cpp stack that ships in this repo.

## What you need

- A Linux host (tested on Ubuntu 25.10). macOS and Windows/WSL should work
  but aren't exercised here.
- Docker 24+.
- For acceptable speed: an NVIDIA GPU with ≥6 GB VRAM + the NVIDIA driver
  installed. CPU-only works for Gemma 4 E2B/E4B but expect ~5–30 tok/s.
- **No** HuggingFace token needed for the default catalog — all listed
  models are public. Set `HF_TOKEN` in `agent-sandbox/llama-cpp/.env` if
  you swap in a gated repo.

## One-time setup

```bash
# 1. Clone the repo and fetch the frontend deps as usual
git clone https://github.com/polats/woid.git
cd woid && npm install

# 2. Enable GPU access inside Docker (sudo, ~5 minutes)
sudo bash agent-sandbox/llama-cpp/scripts/install-nvidia-container-toolkit.sh

# 3. Smoke: should print nvidia-smi output from inside a container
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

Skip step 2 for CPU-only — instead edit
`agent-sandbox/llama-cpp/docker-compose.yml`, change the image from
`:server-cuda` to `:server`, and delete the `deploy.resources` block.

## Start llama.cpp

```bash
cd agent-sandbox/llama-cpp

# Pick a model from catalog.json. Recommended starting point:
./scripts/swap-local-model.sh gemma-4-E4B-it-Q4_K_M

# First boot downloads the GGUF (~5 GB) into a named Docker volume;
# subsequent starts are instant.
docker compose --env-file .env.llama-cpp logs -f llama-cpp
# Wait for "server is listening on http://0.0.0.0:8080"
```

Verify it's up:

```bash
curl -s http://localhost:18080/health
# {"status":"ok"}

curl -s http://localhost:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"x","messages":[{"role":"user","content":"say OK"}],"max_tokens":40}'
```

To swap models:

```bash
./scripts/swap-local-model.sh gemma-4-E2B-it-Q4_K_M         # smaller
./scripts/swap-local-model.sh gemma-4-31B-it-Q4_K_M         # bigger
./scripts/swap-local-model.sh --help                        # list ids
```

## Point the sandbox at it

```bash
cd agent-sandbox

# In agent-sandbox/.env — pick whichever works for your Docker setup:
NVIDIA_NIM_API_KEY=...
GEMINI_API_KEY=...
LOCAL_LLM_BASE_URL=http://172.17.0.1:18080/v1              # Linux default docker bridge
# LOCAL_LLM_BASE_URL=http://host.docker.internal:18080/v1   # Docker Desktop (macOS/Windows)

docker compose up -d --force-recreate pi-bridge
```

`host.docker.internal:host-gateway` is wired up in
`agent-sandbox/docker-compose.yml`, so the pi-bridge container can reach
the llama-server running on the host.

## Use it

Open the sandbox UI → **Settings** (collapsible at the top of the sidebar):

- **Provider**: `Local` (enabled once `LOCAL_LLM_BASE_URL` is set and
  pi-bridge restarted)
- **Model**: pick the id that matches what you loaded with
  `swap-local-model.sh` — these must agree; llama-server ignores the id
  in the request body but pi-bridge uses it to select the right provider
  config.

Spawn any character. The first turn triggers the full model pipeline; from
then on the inspector's **Live** tab streams pi events and the **Turns**
tab shows the waterfall.

## Caveats

- **One model at a time.** llama.cpp holds the weights in VRAM; swap
  blocks the sandbox for 5–60 s depending on size.
- **Per-character model overrides still win.** If you set a model in a
  character's profile, that's what gets used — the Settings default only
  applies to characters with no `model` set.
- **Tool-calling quality varies.** Gemma 4 E2B/E4B, Qwen 3.5/3.6, and
  Gemma 4 26B/31B all pass our `woid-skills` benchmark (see
  [nim-skill-test/docs/woid-skills-report.md](https://github.com/polats/nim-skill-test/blob/master/docs/woid-skills-report.md)).
  Hermes 3 fails out-of-the-box because Nous's template expects a
  different tool-call format.
- **Defaults stay on NIM.** The sandbox default provider is still
  `nvidia-nim`; flip `PI_DEFAULT_PROVIDER=local` + `PI_MODEL=<id>` in
  `agent-sandbox/.env` if you want every spawn (including auto-welcomes)
  to use the local model.

## Troubleshooting

**`docker run --gpus all` fails "no known GPU vendor"** → nvidia-container-toolkit
not installed. Rerun step 2 above.

**llama-server: "HEAD failed, status: 404"** → harmless; happens during
preset lookup before the real download. If it keeps happening after a
minute, check the `-hf` line in `.env.llama-cpp` matches a real quant in
the target HF repo.

**Sandbox "Local" button greyed out** → `LOCAL_LLM_BASE_URL` isn't set in
`agent-sandbox/.env`, or pi-bridge hasn't restarted. `docker compose
logs pi-bridge` should include `wrote pi models.json with N models` and
N should be higher than when Local was disabled.

**Connection refused from pi-bridge → host** / **"Connection error." in
inspector events + `auto_retry_start` loop** → pi can't reach the
llama-server. Easiest fix is to set
`LOCAL_LLM_BASE_URL=http://172.17.0.1:18080/v1` (default Docker bridge
gateway on Linux) in `agent-sandbox/.env`, then
`docker compose up -d --force-recreate pi-bridge`. pi-bridge also
auto-probes at boot and falls back from `host.docker.internal` to
`172.17.0.1` if resolution fails — look for
`[pi-bridge] local llm reachable at ...` in the logs.
