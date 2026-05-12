#!/usr/bin/env python3
"""End-to-end room pipeline: prompt → playable room in drafts.

Mirrors the structure of generate_character.py. Drives every stage the
bridge exposes for room generation so a fresh prompt produces a room
the editor can immediately render (including per-prop FLUX images and
TRELLIS meshes):

    (1) initial room concept via gemma / k2 → metadata + palette +
        proposed_props + layout.json (deterministic placement from
        zones)
    (2) FLUX concept mockup of the whole room (~wide-angle)
    (3) per-prop FLUX text-to-image (image.png on the bridge)
    (4) per-prop TRELLIS image-to-3d (model.glb on the bridge)
    (5) (optional) flip room status from 'draft' to 'added'

Each stage logs elapsed time. Re-running with the same --room-id and
--output-dir is idempotent: each stage checks the bridge for prior
artifacts and skips ahead unless --regenerate names that stage.

Usage:

    ./scripts/generate_room.py \\
        --prompt "Severance-style mailroom with pneumatic-tube wall" \\
        --output-dir ./e2e-runs/room-mailroom

    # second run, regenerate just the concept image:
    ./scripts/generate_room.py --room-id ... --output-dir ... \\
        --regenerate concept

    # full re-run for an existing built-in room:
    ./scripts/generate_room.py --room-id lobby --output-dir ... \\
        --prompt "..." --regenerate initial,concept,images,models

Exit codes:
    0  success — room is visible at /rooms in the drafts list
    1  user error (bad args, missing service)
    2  upstream failure after retries
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from lib.sse import stream_sse  # noqa: E402


# ─── CLI ──────────────────────────────────────────────────────────────

REGEN_STAGES = ["initial", "concept", "images", "models", "status"]


def _argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--prompt",
                   help="creative seed for the room; required unless the "
                        "room already exists on the bridge and you only "
                        "want to (re)run prop stages")
    p.add_argument("--room-id",
                   help="slug for this room; default derived from --prompt")
    p.add_argument("--output-dir", type=Path, required=True,
                   help="local directory for cached artifacts + report")
    p.add_argument("--bridge-url", default="http://localhost:13457")
    p.add_argument("--provider-id", default="nim-kimi-k2-instruct",
                   help="LLM provider for the initial concept JSON")
    p.add_argument("--image-provider-id", default=None,
                   help="FLUX provider override (concept + per-prop)")
    p.add_argument("--mesh-backend", choices=["trellis", "hunyuan3d"],
                   default="trellis",
                   help="image-to-3d backend for per-prop meshes")
    p.add_argument("--skip-concept", action="store_true",
                   help="skip the FLUX room mockup (step 2)")
    p.add_argument("--skip-props", action="store_true",
                   help="stop after the room JSON (no per-prop assets)")
    p.add_argument("--skip-images", action="store_true",
                   help="skip per-prop FLUX (implies --skip-models)")
    p.add_argument("--skip-models", action="store_true",
                   help="skip per-prop TRELLIS/Hunyuan; keep FLUX images")
    p.add_argument("--mark-added", action="store_true",
                   help="flip the room from 'draft' to 'added' on success")
    p.add_argument("--regenerate", default="",
                   help=f"comma-separated stages to force-regen "
                        f"({'|'.join(REGEN_STAGES)})")
    p.add_argument("--max-retries", type=int, default=3)
    p.add_argument("--retry-base-delay", type=float, default=4.0)
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def parse_regen(s: str) -> set[str]:
    out = set()
    for part in (s or "").split(","):
        part = part.strip().lower()
        if not part:
            continue
        if part not in REGEN_STAGES:
            raise SystemExit(f"unknown --regenerate stage {part!r}; "
                             f"want one of {REGEN_STAGES}")
        out.add(part)
    return out


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:32] or f"room-{int(time.time())}"


# ─── Logging + timing (same shape as generate_character.py) ───────────

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


def http_get(url: str, *, timeout: float = 60.0) -> tuple[int, bytes]:
    """Return (status, body). 404 returns (404, b''), not an exception."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, b""
        raise


def post_json_retry(url: str, body: dict, *, timeout: float = 60.0,
                    max_retries: int = 3, base_delay: float = 4.0) -> dict:
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(
                url, method="POST",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json",
                         "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError) as e:
            last_err = e
            delay = base_delay * (2 ** attempt)
            log(f"attempt {attempt+1}/{max_retries} failed ({e}); "
                f"retry in {delay:.0f}s", prefix="!")
            time.sleep(delay)
    raise UpstreamError(f"POST {url} failed after {max_retries} attempts: {last_err}")


# ─── SSE driver (copied from generate_character.py with minor edits) ──

def consume_sse_with_timing(args, url: str, body: dict, *,
                            stage: StageRecord, label: str) -> dict:
    """Drive an SSE endpoint, aggregate timing, return final `done` payload."""
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
                    elif s in ("done", "concept-saved", "concept-skipped",
                               "validating"):
                        if args.verbose:
                            log(f"[{label}] {s}: {msg}", prefix="·")
                    elif s in ("concept-failed", "error"):
                        log(f"[{label}] {s}: {msg}", prefix="!")
                    else:
                        if args.verbose:
                            log(f"[{label}] stage:{s} {msg}", prefix="·")
                elif event == "heartbeat":
                    if args.verbose:
                        log(f"[{label}] heartbeat {data.get('elapsedMs', 0)}ms",
                            prefix="·")
                elif event in ("thinking", "token"):
                    # Verbose-only — the room initial route streams LLM
                    # tokens which would otherwise drown the log.
                    if args.verbose and data.get("text"):
                        print(data["text"], end="", flush=True)
                elif event == "done":
                    last_done = data
                    if inference_t0 is not None:
                        stage.inference_seconds = time.time() - inference_t0
                elif event == "error":
                    last_error = data
                    raise UpstreamError(f"{label}: {data.get('error')}")
            if last_done is not None:
                return last_done
            if last_error:
                raise UpstreamError(f"{label}: {last_error.get('error', 'unknown')}")
            raise UpstreamError(f"{label}: stream ended without done event")
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError, UpstreamError) as e:
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

def stage_initial(args, regen: set[str], report: RunReport) -> dict:
    """Run /rooms/:id/initial and return the resulting layout dict."""
    log_stage_header("(1) initial concept + layout")
    cache = args.output_dir / "layout.json"

    # Resume: if the bridge already has a layout AND we're not asked to
    # regenerate, skip. The bridge is the source of truth — local copy
    # is just a convenience.
    if "initial" not in regen:
        status, body = http_get(f"{args.bridge_url}/rooms/{args.room_id}/layout")
        if status == 200:
            rec = report.record("initial")
            rec.cached = True
            rec.finished_at = time.time()
            rec.bytes_out = len(body)
            layout = json.loads(body)["layout"]
            cache.write_text(json.dumps(layout, indent=2))
            log(f"cached on bridge: {len(layout.get('props', []))} props, "
                f"name={layout.get('name')!r}", prefix="↻")
            return layout

    if not args.prompt:
        raise SystemExit("--prompt is required to (re)run the initial stage")

    rec = report.record("initial")
    # Concept image is its own stage, but /initial does it inline. We
    # pass skipConcept=True so the FLUX render is decoupled from the
    # JSON pass — gives us per-stage timing and lets --regenerate concept
    # work without re-rolling the layout.
    body = {
        "prompt": args.prompt,
        "providerId": args.provider_id,
        "skipConcept": True,
    }
    done = consume_sse_with_timing(
        args,
        f"{args.bridge_url}/rooms/{args.room_id}/initial",
        body, stage=rec, label="initial",
    )
    rec.finished_at = time.time()

    _status, layout_body = http_get(
        f"{args.bridge_url}/rooms/{args.room_id}/layout")
    layout = json.loads(layout_body)["layout"]
    cache.write_text(json.dumps(layout, indent=2))
    rec.bytes_out = len(layout_body)
    n_props = len(layout.get("props", []))
    n_int = sum(1 for p in layout.get("props", []) if p.get("tier") == "interactable")
    n_dec = n_props - n_int
    log(f"name={layout.get('name')!r}  props={n_props} (int={n_int}, dec={n_dec})  "
        f"dims={layout.get('dimensions')}  total={rec.total_seconds:.1f}s")
    if args.verbose and done:
        log(f"done payload keys: {list(done.keys())}", prefix="·")
    return layout


def stage_concept(args, regen: set[str], layout: dict,
                  report: RunReport) -> Path | None:
    log_stage_header("(2) FLUX concept mockup")
    out = args.output_dir / "concept.png"
    rec = report.record("concept")
    if args.skip_concept:
        rec.skipped = True
        rec.notes.append("--skip-concept")
        rec.finished_at = time.time()
        log("skipped (--skip-concept)", prefix="↻")
        return None

    concept_url = f"{args.bridge_url}/rooms/{args.room_id}/concept"
    if "concept" not in regen:
        status, body = http_get(concept_url)
        if status == 200 and len(body) > 1024:
            rec.cached = True
            rec.finished_at = time.time()
            rec.bytes_out = len(body)
            out.write_bytes(body)
            log(f"cached on bridge: {len(body)}B → {out.name}", prefix="↻")
            return out

    # /rooms/:id/concept/regenerate is a plain JSON POST — it uses the
    # layout.fluxPrompt already on disk and writes concept.png. No need
    # to touch the layout JSON, which is what we want here.
    regen_url = f"{args.bridge_url}/rooms/{args.room_id}/concept/regenerate"
    body: dict = {}
    if args.image_provider_id:
        body["imageProviderId"] = args.image_provider_id
    log("calling /concept/regenerate (FLUX)")
    post_json_retry(regen_url, body, timeout=600,
                    max_retries=args.max_retries,
                    base_delay=args.retry_base_delay)
    rec.finished_at = time.time()

    status, body = http_get(concept_url)
    if status == 200 and body:
        out.write_bytes(body)
        rec.bytes_out = len(body)
        log(f"saved {out.name} ({rec.bytes_out}B) total={rec.total_seconds:.1f}s")
        return out
    raise UpstreamError("concept image generation finished but image is missing")


def prop_image_url(args, prop_id: str) -> str:
    return f"{args.bridge_url}/props/{prop_id}/image"


def prop_model_url(args, prop_id: str) -> str:
    return f"{args.bridge_url}/props/{prop_id}/model"


def stage_prop_images(args, regen: set[str], layout: dict,
                      report: RunReport) -> None:
    log_stage_header("(3) per-prop FLUX images")
    if args.skip_props or args.skip_images:
        rec = report.record("prop-images")
        rec.skipped = True
        rec.notes.append("--skip-props" if args.skip_props else "--skip-images")
        rec.finished_at = time.time()
        log("skipped", prefix="↻")
        return

    palette = layout.get("palette") or {}
    images_dir = args.output_dir / "prop-images"
    images_dir.mkdir(parents=True, exist_ok=True)

    props = layout.get("props") or []
    # When a prop already has a sourceAssetId, share the source's image
    # instead of generating a fresh one (matches editor + shelter
    # behaviour).
    seen_assets: set[str] = set()
    for prop in props:
        target_id = prop.get("sourceAssetId") or prop["id"]
        if target_id in seen_assets:
            continue
        seen_assets.add(target_id)

        rec = report.record(f"image:{target_id}")
        url = prop_image_url(args, target_id)
        if "images" not in regen:
            status, body = http_get(url)
            if status == 200 and len(body) > 1024:
                rec.cached = True
                rec.finished_at = time.time()
                rec.bytes_out = len(body)
                (images_dir / f"{target_id}.png").write_bytes(body)
                log(f"[{target_id}] cached ({len(body)}B)", prefix="↻")
                continue

        log(f"[{target_id}] generating  kind={prop.get('kind')}  "
            f"tier={prop.get('tier', '?')}")
        consume_sse_with_timing(
            args,
            f"{args.bridge_url}/props/{target_id}/image/generate/stream",
            {
                "prompt": prop.get("prompt") or target_id,
                "palette": palette,
                "roomId": args.room_id,
                "imageProviderId": args.image_provider_id,
            },
            stage=rec, label=f"img:{target_id}",
        )
        rec.finished_at = time.time()
        status, body = http_get(url)
        if status == 200 and body:
            (images_dir / f"{target_id}.png").write_bytes(body)
            rec.bytes_out = len(body)
        log(f"[{target_id}] saved {rec.bytes_out}B  total={rec.total_seconds:.1f}s")


def stage_prop_models(args, regen: set[str], layout: dict,
                      report: RunReport) -> None:
    log_stage_header("(4) per-prop TRELLIS meshes")
    if args.skip_props or args.skip_models or args.skip_images:
        rec = report.record("prop-models")
        rec.skipped = True
        if args.skip_props: rec.notes.append("--skip-props")
        if args.skip_models: rec.notes.append("--skip-models")
        if args.skip_images: rec.notes.append("--skip-images (implies models)")
        rec.finished_at = time.time()
        log("skipped", prefix="↻")
        return

    models_dir = args.output_dir / "prop-models"
    models_dir.mkdir(parents=True, exist_ok=True)

    seen_assets: set[str] = set()
    for prop in layout.get("props") or []:
        target_id = prop.get("sourceAssetId") or prop["id"]
        if target_id in seen_assets:
            continue
        seen_assets.add(target_id)

        rec = report.record(f"model:{target_id}")
        url = prop_model_url(args, target_id)
        if "models" not in regen:
            status, body = http_get(url)
            if status == 200 and len(body) > 1024:
                rec.cached = True
                rec.finished_at = time.time()
                rec.bytes_out = len(body)
                (models_dir / f"{target_id}.glb").write_bytes(body)
                log(f"[{target_id}] cached ({len(body)}B)", prefix="↻")
                continue

        # Image must exist on the bridge before TRELLIS can run.
        img_status, _ = http_get(prop_image_url(args, target_id))
        if img_status != 200:
            rec.skipped = True
            rec.notes.append("no source image on bridge")
            rec.finished_at = time.time()
            log(f"[{target_id}] skipped (no image)", prefix="!")
            continue

        log(f"[{target_id}] generating  backend={args.mesh_backend}")
        consume_sse_with_timing(
            args,
            f"{args.bridge_url}/props/{target_id}/model/generate/stream",
            {"backend": args.mesh_backend},
            stage=rec, label=f"mesh:{target_id}",
        )
        rec.finished_at = time.time()
        status, body = http_get(url, timeout=120)
        if status == 200 and body:
            (models_dir / f"{target_id}.glb").write_bytes(body)
            rec.bytes_out = len(body)
        log(f"[{target_id}] saved {rec.bytes_out}B  "
            f"cold={rec.cold_start_seconds:.1f}s "
            f"inference={rec.inference_seconds:.1f}s "
            f"total={rec.total_seconds:.1f}s")


def stage_status(args, regen: set[str], report: RunReport) -> None:
    log_stage_header("(5) room status")
    rec = report.record("status")
    if not args.mark_added:
        rec.skipped = True
        rec.notes.append("default keeps room in drafts")
        rec.finished_at = time.time()
        log("keeping in drafts (default)", prefix="↻")
        return
    post_json_retry(
        f"{args.bridge_url}/rooms/{args.room_id}/status",
        {"status": "added"},
        max_retries=args.max_retries, base_delay=args.retry_base_delay,
    )
    rec.finished_at = time.time()
    log("flipped status → 'added'")


# ─── Main ─────────────────────────────────────────────────────────────

def main() -> int:
    args = _argparser().parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    regen = parse_regen(args.regenerate)

    if not args.room_id:
        if not args.prompt:
            raise SystemExit("provide --prompt or --room-id")
        args.room_id = slugify(args.prompt)

    report = RunReport()
    overall_t0 = time.time()

    log_stage_header("e2e room pipeline")
    log(f"room id: {args.room_id}")
    log(f"output dir: {args.output_dir}")
    log(f"bridge: {args.bridge_url}")
    log(f"mesh backend: {args.mesh_backend}")
    if regen:
        log(f"regenerate: {','.join(sorted(regen))}")

    layout = stage_initial(args, regen, report)
    stage_concept(args, regen, layout, report)
    # Re-read layout in case the concept stage regenerated it.
    cache = args.output_dir / "layout.json"
    if cache.exists():
        layout = json.loads(cache.read_text())
    stage_prop_images(args, regen, layout, report)
    stage_prop_models(args, regen, layout, report)
    stage_status(args, regen, report)

    # Final report
    log_stage_header("summary")
    log(f"total wall-clock: {time.time() - overall_t0:.1f}s")
    for s in report.stages:
        if s.skipped:
            note = f"SKIPPED ({s.notes[0]})" if s.notes else "SKIPPED"
            log(f"{s.name:<28} {note}", prefix=" ")
        elif s.cached:
            log(f"{s.name:<28} cached ({s.bytes_out}B)", prefix="↻")
        else:
            cs = f" cold={s.cold_start_seconds:.1f}s" if s.cold_start else ""
            log(f"{s.name:<28} {s.total_seconds:6.1f}s{cs} "
                f"({s.bytes_out}B)", prefix="·")
    (args.output_dir / "report.json").write_text(
        json.dumps(report.to_dict(), indent=2))
    log(f"report saved to {args.output_dir / 'report.json'}", prefix="✓")
    log(f"room visible at /rooms · drafts tab · {args.room_id}", prefix="✓")
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
