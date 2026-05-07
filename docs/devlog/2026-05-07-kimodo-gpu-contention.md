# 2026-05-07 — kimodo-gpu-contention

woid started returning 502 on every `/api/kimodo/*` call after a docker
restart. Two gotchas — the GPU contention itself, and a misleading port
binding that made the broken state look like the API was online.

Commits:
- kimodo `polats/kimodo-motion-api` — compose: switch `demo` default
  to `run_motion_api`, default SERVER_PORT to 7862.

---

## Gotcha 1 — kimodo's gradio demo holds 16 GiB of VRAM, leaving no room for the motion API to load

**Symptom:** woid Animations tab shows "kimodo offline?", every fetch
to `/api/kimodo/*` returns 502 from the Vite proxy. The proxy logs
"connection reset by peer" against `http://localhost:7862/info`. The
`demo` container is up. `docker exec demo pgrep python` shows a
process running, but the container's `:7862` is closed.

**Root cause:** `docker-compose.yaml` had

```yaml
demo:
  command: python -m kimodo.demo
```

so the container's PID 1 was the gradio demo, which loads the
diffusion model eagerly at startup and parks ~16 GiB on the GPU. Our
old workflow then `docker exec`'d into the container to launch
`run_motion_api` as a sidecar — and that **also** wants to load its
own diffusion model. On a 24 GiB card there's only ~7 GiB headroom,
which used to be enough for the model itself but isn't enough for the
model + activations.

The motion API process therefore crashes during startup with:

```
hydra.errors.InstantiationException: Error in call to target 'kimodo.model.kimodo_model.Kimodo':
OutOfMemoryError('CUDA out of memory. Tried to allocate 20.00 MiB.
GPU 0 has a total capacity of 23.55 GiB of which 78.75 MiB is free.
Process 1 has 16.31 GiB memory in use. Including non-PyTorch memory,
this process has 774.00 MiB memory in use. ...')
```

The "Process 1 has 16.31 GiB" line names the **gradio** PID 1, not
the API process the user thought was failing. Easy to misread as
"the motion API is leaking memory" when actually a *different*
process is holding the VRAM.

**Fix:** Make the motion API the container's PID 1 instead. compose
`command:` switched to `python -m kimodo.scripts.run_motion_api`,
default `SERVER_PORT` flipped from 7860 to 7862, port mapping
reordered so 7862 is the primary forward and 7860 / 7861 are kept
mapped for opt-in `docker exec` launches of gradio /
`run_simple_app`. Gradio still works if you want it
(`docker exec -d demo python -m kimodo.demo`) — it just doesn't
auto-start and doesn't compete for VRAM by default.

**Trap for next time:**

- **The PyTorch OOM message names *Process 1* for the holding
  process, not the failing one.** When debugging "the motion API
  OOM'd", the first instinct is to look at the motion API's own
  memory usage. Look at `nvidia-smi` first — if the GPU is at >90 %
  before your process tries to allocate, the symptom is contention,
  not a leak.
- **kimodo's diffusion model loads eagerly at process start.** Two
  copies of the demo in the same container is a guaranteed OOM on
  anything below 40 GiB. Don't do `docker exec ... run_motion_api`
  if `kimodo.demo` is also running.
- **`docker exec` against an OOM'd process produces no log file.**
  The motion API in this case wrote no log because the script's
  redirect (`> /tmp/motion-api.log`) was wrapped by `bash -c`, and
  `bash -c` returned before the redirect target was created. Logs
  ended up wherever the docker-exec terminal sent them — which we
  detached, so they vanished. To debug something like this, run the
  command without `&` once first to see the failure live.
- **Diagnostic shortcut:** `docker exec demo python -m kimodo.scripts.run_motion_api`
  in the foreground reproduces the OOM with the full Python
  traceback. Always do that before attempting `-d` or `nohup` —
  otherwise an immediate-exit failure looks like a successful launch.

---

## Gotcha 2 — `SERVER_PORT=${SERVER_PORT:-7860}` in compose silently overrides the script's default

**Symptom:** While debugging, I switched the compose `command` to
`run_motion_api` via `docker compose run -d --service-ports demo
python -m kimodo.scripts.run_motion_api`. The container came up,
`docker logs` showed FastAPI startup messages, requests *appeared*
to be served (the woid kimodo-tools sidecar was getting 200s on
`/characters`). But `curl localhost:7862/info` from the host
returned "connection reset". Inside the container,
`curl localhost:7862` was *also* refused.

**Root cause:** `run_motion_api.py` reads `SERVER_PORT` from env,
defaulting to `7862`. But the compose file's environment block sets

```yaml
- SERVER_PORT=${SERVER_PORT:-7860}
```

which means the *container env* always carries `SERVER_PORT`, set to
7860 unless the host has it exported. The script then sees
`SERVER_PORT=7860` in env and binds **7860** instead of its own
7862 default. Port 7862 is forwarded but nothing listens on it
inside the container; port 7860 is forwarded and the API is
listening — but on the wrong port.

**Fix:** Two parts:

1. The compose change (gotcha 1) flipped the default from 7860 to
   7862, so the script's env-derived port matches the script's own
   default and matches what woid expects.
2. For one-off launches via `docker compose run`, prefix with
   `SERVER_PORT=7862` if the host doesn't have it set:

   ```
   SERVER_PORT=7862 docker compose run -d --service-ports --name demo demo \
     python -m kimodo.scripts.run_motion_api
   ```

**Trap for next time:**

- **`SERVER_PORT` is a leaky abstraction across two hops.** It's a
  host env var (compose's substitution), a container env var
  (compose's `environment:` block), and a Python env var
  (`os.environ.get`). If any layer has a different default, the
  port can silently shift.
- **Diagnostic for "API is up but unreachable":** check what the
  process is actually listening on with `docker exec demo bash -c
  'for p in 7860 7861 7862; do timeout 1 bash -c "</dev/tcp/127.0.0.1/$p"
  && echo $p open; done'`. If a *different* port is open than the
  one you're hitting, the env-var route is suspect.
- **Bizarre 403 WebSocket logs in the docker output** are a sign
  that *something else* is hammering the API's port. In our case,
  the woid kimodo-tools container polls on a websocket connection
  to a different upstream service whose port collided with the
  motion API's wrong-bound port. The 403s are noise but they're
  also evidence that the API really is listening — somewhere.

---

## Pickup notes

- **Reboot recovery:** with the compose fix, `docker compose up -d
  demo` after a daemon reboot restores the motion API on 7862. Was
  not the case before — the previous setup needed a manual
  `docker exec demo bash -c 'SERVER_PORT=7862 python -m
  kimodo.scripts.run_motion_api &'` after every restart.
- **Gradio is still available** via `docker exec -d demo python -m
  kimodo.demo` — but it'll OOM the motion API if launched while the
  motion API is loaded. To use gradio, stop the motion API first:
  `docker compose stop demo`, then run gradio in a fresh container
  with `command: python -m kimodo.demo` overridden.
- **`docker compose run` vs `docker compose up` lifecycle.** While
  debugging I had a window where the container was started by
  `compose run` (one-off, no restart policy) instead of `compose
  up`. `docker compose ps` showed it but `docker compose down`
  didn't necessarily clean it up. The compose-fix means everything
  goes through `compose up` again — keep it that way to avoid
  zombie containers after future debug sessions.
