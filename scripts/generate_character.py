#!/usr/bin/env python3
"""End-to-end character pipeline: prompt → kimodo-animatable rig.

Goes through every stage we've stood up:

    (1) persona via gemma-4-31b   -> {name, about}
    (2) character mint            -> pubkey
    (3) avatar via flux.1-schnell -> avatar.jpeg
    (4) t-pose via flux1-kontext  -> tpose.png
    (5) mesh via trellis OR hunyuan3d -> model.glb
    (6) rig via local UniRig      -> rig.glb
    (7) wrist-rotate post-process -> rig_palmsdown.glb   (TODO: step 7
         is sketched but not wired yet — see --skip-palms-fix)
    (8) kimodo registry import    -> .kimodo-characters/<id>.json

Each stage logs its elapsed time, distinguishing cold-start from warm
inference. On network failure the script can be re-run with the same
--output-dir to resume from the last successfully-cached intermediate.

Usage:

    ./scripts/generate_character.py \\
        --prompt "a serene tea master in feudal Japan" \\
        --mesh-backend trellis \\
        --output-dir ./e2e-runs/run-001

    # second run, hunyuan3d backend, force-regen the t-pose only:
    ./scripts/generate_character.py \\
        --prompt "..." \\
        --mesh-backend hunyuan3d \\
        --output-dir ./e2e-runs/run-002 \\
        --regenerate tpose

Exit codes:
    0  success — character is registered in kimodo and visible in /web
    1  user error (bad args, missing service)
    2  upstream failure after retries
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Import sibling lib by adjusting sys.path so we can run as a script
# without packaging.
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from lib.sse import stream_sse  # noqa: E402


# ─── CLI ──────────────────────────────────────────────────────────────

def _argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--prompt", required=False,
                   help="creative seed for persona generation")
    p.add_argument("--seed-name", help="skip persona; use this name (with --seed-about)")
    p.add_argument("--seed-about", help="bio to pair with --seed-name")
    p.add_argument("--mesh-backend", choices=["trellis", "hunyuan3d"], default="trellis")
    p.add_argument("--output-dir", type=Path, required=True,
                   help="where to save artifacts; resume-friendly")
    p.add_argument("--label", help="kimodo registry label (default: derived from name)")
    p.add_argument("--bridge-url", default="http://localhost:13457")
    p.add_argument("--unirig-url", default="http://localhost:8081")
    p.add_argument("--kimodo-import-script",
                   default="/home/paul/projects/kimodo/web/scripts/import_unirig_glb.py")
    p.add_argument("--regenerate", action="append", default=[],
                   choices=["persona", "avatar", "tpose", "model", "rig", "palms", "import"],
                   help="force-regen a stage (repeatable)")
    p.add_argument("--skip-rig", action="store_true",
                   help="stop after model.glb (skip UniRig + import)")
    p.add_argument("--skip-palms-fix", action="store_true",
                   help="ship rig.glb as palms-forward (no step 7)")
    # Step-7 wrist rotation. Defaults: --axis Y --degrees 90 are the
    # values that landed at palms-down for rest-align in our manual A/B.
    # They might shift if UniRig's bone-roll convention changes for a
    # different mesh source.
    p.add_argument("--palms-axis", choices=["X", "Y", "Z"], default="Y",
                   help="wrist rotation axis for the palms-down bake (default Y)")
    p.add_argument("--palms-degrees", type=float, default=90.0,
                   help="wrist rotation in degrees for the LEFT wrist; "
                        "right wrist gets the opposite sign (default 90)")
    p.add_argument("--skip-kimodo-import", action="store_true")
    p.add_argument("--max-retries", type=int, default=3)
    p.add_argument("--retry-base-delay", type=float, default=4.0,
                   help="exponential backoff base in seconds")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="print SSE heartbeats as they arrive")
    return p


# ─── Logging + timing ─────────────────────────────────────────────────

@dataclass
class StageRecord:
    name: str
    started_at: float = 0.0
    finished_at: float = 0.0
    cold_start: bool = False
    cold_start_seconds: float = 0.0
    inference_seconds: float = 0.0
    bytes_out: int = 0
    notes: list[str] = field(default_factory=list)
    skipped: bool = False
    cached: bool = False

    @property
    def total_seconds(self) -> float:
        return self.finished_at - self.started_at


@dataclass
class RunReport:
    stages: list[StageRecord] = field(default_factory=list)

    def record(self, name: str) -> StageRecord:
        rec = StageRecord(name=name, started_at=time.time())
        self.stages.append(rec)
        return rec

    def to_dict(self) -> dict:
        return {
            "stages": [
                {
                    "name": s.name,
                    "total_seconds": round(s.total_seconds, 2),
                    "cold_start": s.cold_start,
                    "cold_start_seconds": round(s.cold_start_seconds, 2),
                    "inference_seconds": round(s.inference_seconds, 2),
                    "bytes_out": s.bytes_out,
                    "skipped": s.skipped,
                    "cached": s.cached,
                    "notes": s.notes,
                }
                for s in self.stages
            ],
            "total_seconds": round(sum(s.total_seconds for s in self.stages), 2),
        }


def log(msg: str, *, prefix: str = "•") -> None:
    print(f"  {prefix} {msg}", flush=True)


def log_stage_header(stage: str) -> None:
    print(f"\n━━ {stage} ━━", flush=True)


# ─── HTTP helpers with retry ──────────────────────────────────────────

class UpstreamError(RuntimeError):
    pass


def post_json_retry(url: str, body: dict, *, timeout: float = 600.0,
                    max_retries: int = 3, base_delay: float = 4.0) -> dict:
    """POST JSON with exponential backoff on transient failures."""
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(
                url, method="POST",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last_err = e
            delay = base_delay * (2 ** attempt)
            log(f"attempt {attempt+1}/{max_retries} failed ({e}); retry in {delay:.0f}s",
                prefix="!")
            time.sleep(delay)
    raise UpstreamError(f"POST {url} failed after {max_retries} attempts: {last_err}")


def post_multipart_file(url: str, file_path: Path, *, field_name: str = "file",
                        timeout: float = 600.0) -> bytes:
    """POST a single file as multipart/form-data, return response bytes."""
    boundary = "----woid" + os.urandom(8).hex()
    body = bytearray()
    body += f"--{boundary}\r\n".encode()
    body += (f'Content-Disposition: form-data; name="{field_name}"; '
             f'filename="{file_path.name}"\r\n').encode()
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += file_path.read_bytes()
    body += f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        url, method="POST", data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get_bytes(url: str, *, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# ─── Stage helpers ────────────────────────────────────────────────────

def consume_sse_with_timing(args, url: str, body: dict, *, stage: StageRecord,
                            verbose: bool, label: str) -> dict:
    """Drive an SSE endpoint and aggregate timing into `stage`. Returns the
    final `done` event payload."""
    cold_start_t0: float | None = None
    inference_t0: float | None = None
    last_done: dict | None = None
    last_error: dict | None = None

    last_err: Exception | None = None
    for attempt in range(args.max_retries):
        try:
            for event, data in stream_sse(url, body):
                if event == "stage":
                    s = data.get("stage")
                    msg = data.get("message", "")
                    if s == "cold-start" and cold_start_t0 is None:
                        cold_start_t0 = time.time()
                        stage.cold_start = True
                        log(f"[{label}] cold start: {msg}", prefix="…")
                    elif s == "warm":
                        if cold_start_t0 is not None:
                            stage.cold_start_seconds = time.time() - cold_start_t0
                            log(f"[{label}] warm after {stage.cold_start_seconds:.1f}s",
                                prefix="✓")
                        else:
                            log(f"[{label}] {msg}", prefix="✓")
                    elif s == "generating":
                        inference_t0 = time.time()
                        log(f"[{label}] {msg}", prefix="…")
                    elif s == "done":
                        log(f"[{label}] done")
                    elif s == "error":
                        log(f"[{label}] error stage: {msg}", prefix="!")
                    else:
                        if verbose:
                            log(f"[{label}] stage:{s} {msg}", prefix="·")
                elif event == "heartbeat":
                    if verbose:
                        log(f"[{label}] heartbeat {data.get('elapsedMs', 0)}ms",
                            prefix="·")
                elif event == "done":
                    last_done = data
                    if inference_t0 is not None:
                        stage.inference_seconds = time.time() - inference_t0
                elif event == "error":
                    last_error = data
                    raise UpstreamError(f"{label}: {data.get('error')}")
            if last_done:
                return last_done
            if last_error:
                raise UpstreamError(f"{label}: {last_error.get('error', 'unknown')}")
            raise UpstreamError(f"{label}: stream ended without done event")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, UpstreamError) as e:
            last_err = e
            stage.notes.append(f"attempt {attempt+1}/{args.max_retries}: {e}")
            if attempt + 1 == args.max_retries:
                break
            delay = args.retry_base_delay * (2 ** attempt)
            log(f"[{label}] attempt {attempt+1}/{args.max_retries} failed ({e}); "
                f"retry in {delay:.0f}s", prefix="!")
            time.sleep(delay)
    raise UpstreamError(f"{label}: gave up after {args.max_retries} attempts ({last_err})")


# ─── Stages ───────────────────────────────────────────────────────────

def stage_persona_and_avatar(args, report: RunReport) -> tuple[dict, dict, Path]:
    """Steps 1–3 in one bridge call.

    /v1/personas/generate is a one-shot that:
      - generates persona text (gemma)
      - mints a character (gives us pubkey)
      - generates the avatar (NIM flux.1-schnell)
      - publishes the kind:0 to the relay
    Returns (persona_dict, character_dict, avatar_path).
    """
    log_stage_header("(1+2+3) persona + character + avatar")
    persona_cache = args.output_dir / "persona.json"
    character_cache = args.output_dir / "character.json"
    avatar_path = args.output_dir / "avatar.jpeg"

    cache_complete = (persona_cache.exists() and character_cache.exists()
                      and avatar_path.exists())
    if "persona" not in args.regenerate and cache_complete:
        rec = report.record("persona+avatar")
        rec.cached = True
        rec.finished_at = time.time()
        rec.bytes_out = avatar_path.stat().st_size
        persona = json.loads(persona_cache.read_text())
        character = json.loads(character_cache.read_text())
        log(f"cached: name={persona.get('name')!r} pubkey={character['pubkey'][:12]}… "
            f"avatar={rec.bytes_out}B", prefix="↻")
        return persona, character, avatar_path

    if args.seed_name and args.seed_about:
        # User supplied seed name+about; mint a character explicitly and
        # call /generate-avatar separately. Slower path (2 calls) but
        # respects the user's seed.
        rec = report.record("persona+avatar")
        log(f"seeded persona (skipping gemma): name={args.seed_name!r}")
        char = post_json_retry(
            f"{args.bridge_url}/characters",
            {"name": args.seed_name, "about": args.seed_about},
            max_retries=args.max_retries, base_delay=args.retry_base_delay,
        )
        log(f"minted pubkey={char['pubkey'][:12]}…")
        log("calling /generate-avatar (NIM flux.1-schnell)")
        av = post_json_retry(
            f"{args.bridge_url}/characters/{char['pubkey']}/generate-avatar", {},
            timeout=600,
            max_retries=args.max_retries, base_delay=args.retry_base_delay,
        )
        avatar_url = av.get("avatarUrl")
        if not avatar_url:
            raise UpstreamError("avatar response missing avatarUrl")
        blob = http_get_bytes(avatar_url, timeout=60)
        avatar_path.write_bytes(blob)
        rec.bytes_out = len(blob)
        rec.finished_at = time.time()
        persona = {"name": args.seed_name, "about": args.seed_about, "_source": "seed"}
        persona_cache.write_text(json.dumps(persona, indent=2))
        character_cache.write_text(json.dumps(char, indent=2))
        log(f"saved avatar ({rec.bytes_out}B) in {rec.total_seconds:.1f}s")
        return persona, char, avatar_path

    if not args.prompt:
        raise SystemExit("--prompt is required when --seed-name/--seed-about are not given")

    rec = report.record("persona+avatar")
    log(f"calling /v1/personas/generate (gemma + flux-schnell) seed={args.prompt!r}")
    data = post_json_retry(
        f"{args.bridge_url}/v1/personas/generate",
        {"seed": args.prompt},
        timeout=600,
        max_retries=args.max_retries, base_delay=args.retry_base_delay,
    )
    image_error = data.get("imageError")
    image_url = data.get("imageUrl")
    if image_error or not image_url:
        raise UpstreamError(f"persona avatar failed: {image_error or 'no imageUrl'}")
    blob = http_get_bytes(image_url, timeout=60)
    avatar_path.write_bytes(blob)

    persona = {
        "name": data.get("name"),
        "about": data.get("about"),
        "model": data.get("model"),
    }
    character = {
        "pubkey": data["pubkey"],
        "npub": data.get("npub"),
        "jumbleUrl": data.get("jumbleUrl"),
        "name": data.get("name"),
    }
    persona_cache.write_text(json.dumps(persona, indent=2))
    character_cache.write_text(json.dumps(character, indent=2))
    rec.finished_at = time.time()
    rec.bytes_out = len(blob)
    log(f"name={persona['name']!r} pubkey={character['pubkey'][:12]}… "
        f"avatar={rec.bytes_out}B in {rec.total_seconds:.1f}s")
    return persona, character, avatar_path


def stage_tpose(args, character: dict, report: RunReport) -> Path:
    log_stage_header("(4) t-pose")
    pubkey = character["pubkey"]
    tpose_path = args.output_dir / "tpose.png"
    if "tpose" not in args.regenerate and tpose_path.exists():
        rec = report.record("tpose")
        rec.cached = True
        rec.finished_at = time.time()
        rec.bytes_out = tpose_path.stat().st_size
        log(f"cached: {tpose_path.name} ({rec.bytes_out} bytes)", prefix="↻")
        return tpose_path

    rec = report.record("tpose")
    done = consume_sse_with_timing(
        args,
        f"{args.bridge_url}/characters/{pubkey}/generate-tpose/stream",
        {}, stage=rec, verbose=args.verbose, label="tpose",
    )
    rec.finished_at = time.time()
    blob = http_get_bytes(done["tposeUrl"], timeout=60)
    tpose_path.write_bytes(blob)
    rec.bytes_out = len(blob)
    log(f"saved {tpose_path.name} ({rec.bytes_out} bytes); "
        f"cold={rec.cold_start_seconds:.1f}s inference={rec.inference_seconds:.1f}s "
        f"total={rec.total_seconds:.1f}s")
    return tpose_path


def stage_model(args, character: dict, report: RunReport) -> Path:
    log_stage_header(f"(5) model [{args.mesh_backend}]")
    pubkey = character["pubkey"]
    model_path = args.output_dir / f"model_{args.mesh_backend}.glb"
    if "model" not in args.regenerate and model_path.exists():
        rec = report.record(f"model[{args.mesh_backend}]")
        rec.cached = True
        rec.finished_at = time.time()
        rec.bytes_out = model_path.stat().st_size
        log(f"cached: {model_path.name} ({rec.bytes_out} bytes)", prefix="↻")
        return model_path

    rec = report.record(f"model[{args.mesh_backend}]")
    done = consume_sse_with_timing(
        args,
        f"{args.bridge_url}/characters/{pubkey}/generate-model/stream",
        {"backend": args.mesh_backend},
        stage=rec, verbose=args.verbose, label=f"model[{args.mesh_backend}]",
    )
    rec.finished_at = time.time()
    blob = http_get_bytes(done["modelUrl"], timeout=120)
    model_path.write_bytes(blob)
    rec.bytes_out = len(blob)
    log(f"saved {model_path.name} ({rec.bytes_out} bytes); "
        f"cold={rec.cold_start_seconds:.1f}s inference={rec.inference_seconds:.1f}s "
        f"total={rec.total_seconds:.1f}s")
    return model_path


def stage_rig(args, model_path: Path, report: RunReport) -> Path:
    log_stage_header("(6) unirig")
    rig_path = args.output_dir / "rig.glb"
    if "rig" not in args.regenerate and rig_path.exists():
        rec = report.record("rig")
        rec.cached = True
        rec.finished_at = time.time()
        rec.bytes_out = rig_path.stat().st_size
        log(f"cached: {rig_path.name} ({rec.bytes_out} bytes)", prefix="↻")
        return rig_path

    rec = report.record("rig")
    log(f"posting {model_path.name} to {args.unirig_url}/rig")
    inf_t0 = time.time()
    last_err: Exception | None = None
    for attempt in range(args.max_retries):
        try:
            blob = post_multipart_file(
                f"{args.unirig_url}/rig", model_path, timeout=600,
            )
            rec.inference_seconds = time.time() - inf_t0
            rig_path.write_bytes(blob)
            rec.bytes_out = len(blob)
            rec.finished_at = time.time()
            log(f"saved {rig_path.name} ({rec.bytes_out} bytes); "
                f"inference={rec.inference_seconds:.1f}s total={rec.total_seconds:.1f}s")
            return rig_path
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last_err = e
            rec.notes.append(f"attempt {attempt+1}: {e}")
            if attempt + 1 == args.max_retries:
                break
            delay = args.retry_base_delay * (2 ** attempt)
            log(f"unirig attempt {attempt+1}/{args.max_retries} failed ({e}); "
                f"retry in {delay:.0f}s", prefix="!")
            time.sleep(delay)
    raise UpstreamError(
        f"unirig failed after {args.max_retries} attempts ({last_err}). "
        f"is the container running? `cd google-cloud/gemma-4-self-hosted/unirig && ./run.sh`"
    )


def stage_palms_fix(args, rig_path: Path, report: RunReport) -> Path:
    """Step 7 — bake palms-down into the mesh + new rest pose.

    Two-stage Blender pass driven by `lib/glb_palms_down.py`:
      a. Derive the bone-name → kimodo-joint mapping for this rig
         using the existing unirig_mapping.py labeler.
      b. Blender script: rotate wrist bones, apply Armature modifier
         (bakes deformation into vertex data), pose-as-rest, re-bind,
         export. The mesh-data bake is what actually lets the rotation
         survive `alignMode='rest'` in the kimodo animator — a pure
         bone rotation gets cancelled by the inverse-bind matrices.
    """
    log_stage_header("(7) palms-down")
    out = args.output_dir / "rig_palmsdown.glb"
    rec = report.record("palms-fix")
    if args.skip_palms_fix:
        rec.skipped = True
        rec.notes.append("--skip-palms-fix")
        rec.finished_at = time.time()
        log("skipped (--skip-palms-fix); ship rig.glb as-is", prefix="↻")
        return rig_path

    if "palms" not in args.regenerate and out.exists():
        rec.cached = True
        rec.finished_at = time.time()
        rec.bytes_out = out.stat().st_size
        log(f"cached: {out.name} ({rec.bytes_out} bytes)", prefix="↻")
        return out

    # (a) Derive mapping. The labeler is in the kimodo repo; falls back
    # to a side-by-side run via `python3 unirig_mapping.py <rig.glb>` so
    # we don't need to import its module.
    mapping_path = args.output_dir / "rig_mapping.json"
    if "palms" in args.regenerate or not mapping_path.exists():
        labeler = "/home/paul/projects/kimodo/web/scripts/unirig_mapping.py"
        if not Path(labeler).exists():
            raise UpstreamError(
                f"unirig_mapping.py not found at {labeler}; "
                "set --kimodo-import-script's neighbor or fix the path"
            )
        proc = subprocess.run(
            ["python3", labeler, str(rig_path), "-o", str(mapping_path)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise UpstreamError(
                f"mapping derivation failed: {proc.stderr.strip() or proc.stdout.strip()}"
            )

    # (b) Blender mesh-bake.
    blender_script = SCRIPT_DIR / "lib" / "glb_palms_down.py"
    blender_bin = shutil.which("blender") or "/snap/bin/blender"
    cmd = [
        blender_bin, "--background", "--python", str(blender_script), "--",
        str(rig_path), str(mapping_path), str(out),
        "--axis", args.palms_axis,
        "--degrees", str(args.palms_degrees),
    ]
    log(f"baking palms-down ({args.palms_axis} {args.palms_degrees:+g}°) via Blender")
    inf_t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    rec.inference_seconds = time.time() - inf_t0
    if proc.returncode != 0:
        # Blender prints version banner on stderr even on success; only
        # surface the LAST 600 chars of stderr so we don't dump ~2K of
        # GLTF import noise.
        tail = (proc.stderr or proc.stdout or "")[-600:]
        raise UpstreamError(f"glb_palms_down failed: {tail}")
    if not out.exists():
        raise UpstreamError("glb_palms_down ran without error but produced no output GLB")
    rec.bytes_out = out.stat().st_size
    rec.finished_at = time.time()
    log(f"saved {out.name} ({rec.bytes_out} bytes); inference={rec.inference_seconds:.1f}s")
    return out


def stage_kimodo_import(args, persona: dict, character: dict, palms_path: Path,
                       report: RunReport) -> dict:
    log_stage_header("(8) kimodo import")
    rec = report.record("kimodo-import")
    if args.skip_kimodo_import:
        rec.skipped = True
        rec.finished_at = time.time()
        log("skipped (--skip-kimodo-import)", prefix="↻")
        return {}

    pubkey = character["pubkey"]
    label = args.label or f"{persona.get('name', 'unirig')} ({args.mesh_backend})"
    char_id = f"unirig_{pubkey[:12]}_{args.mesh_backend}"
    cmd = [
        "python3", args.kimodo_import_script, str(palms_path),
        "--id", char_id, "--label", label,
    ]
    log(f"running {' '.join(cmd[1:3])} ...")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    rec.finished_at = time.time()
    if proc.returncode != 0:
        rec.notes.append(proc.stderr.strip())
        # The kimodo import is sometimes blocked by perms (the .kimodo-
        # characters/ dir is root-owned because docker created it). The
        # script is best-effort; fall through to docker-exec retry.
        log(f"kimodo import direct call failed; trying via docker exec", prefix="!")
        # Copy GLB into the kimodo container and re-run inside it.
        try:
            subprocess.run(
                ["docker", "cp", str(palms_path), f"demo:/tmp/{palms_path.name}"],
                check=True, capture_output=True,
            )
            proc2 = subprocess.run(
                ["docker", "exec", "demo", "python", "web/scripts/import_unirig_glb.py",
                 f"/tmp/{palms_path.name}", "--id", char_id, "--label", label],
                capture_output=True, text=True,
            )
            if proc2.returncode == 0:
                log(f"imported via docker exec (id={char_id})")
                return {"id": char_id, "label": label, "via": "docker"}
            rec.notes.append(f"docker fallback: {proc2.stderr.strip()}")
        except subprocess.CalledProcessError as e:
            rec.notes.append(f"docker cp failed: {e}")
        raise UpstreamError(f"kimodo import failed: {rec.notes[-1] if rec.notes else 'unknown'}")
    log(f"imported (id={char_id})")
    return {"id": char_id, "label": label}


# ─── Main ─────────────────────────────────────────────────────────────

def main() -> int:
    args = _argparser().parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = RunReport()
    overall_t0 = time.time()

    log_stage_header("e2e character pipeline")
    log(f"output dir: {args.output_dir}")
    log(f"mesh backend: {args.mesh_backend}")
    if args.regenerate:
        log(f"regenerate: {','.join(args.regenerate)}")

    persona, character, _avatar_path = stage_persona_and_avatar(args, report)
    stage_tpose(args, character, report)
    model_path = stage_model(args, character, report)

    if args.skip_rig:
        log("\n--skip-rig given; stopping after model.glb", prefix="↻")
    else:
        rig_path = stage_rig(args, model_path, report)
        palms_path = stage_palms_fix(args, rig_path, report)
        stage_kimodo_import(args, persona, character, palms_path, report)

    # Final report
    log_stage_header("summary")
    log(f"total wall-clock: {time.time() - overall_t0:.1f}s")
    for s in report.stages:
        if s.skipped:
            note = f"SKIPPED ({s.notes[0]})" if s.notes else "SKIPPED"
            log(f"{s.name:<22} {note}", prefix=" ")
        elif s.cached:
            log(f"{s.name:<22} cached", prefix="↻")
        else:
            cs = f" cold={s.cold_start_seconds:.1f}s" if s.cold_start else ""
            log(f"{s.name:<22} {s.total_seconds:6.1f}s{cs}", prefix="·")
    (args.output_dir / "report.json").write_text(json.dumps(report.to_dict(), indent=2))
    log(f"report saved to {args.output_dir / 'report.json'}", prefix="✓")
    if not args.skip_kimodo_import and not args.skip_rig:
        log("character is now visible at http://localhost:5174", prefix="✓")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UpstreamError as e:
        print(f"\n[FAIL] {e}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        print("\n[ABORT] interrupted", file=sys.stderr)
        sys.exit(130)
