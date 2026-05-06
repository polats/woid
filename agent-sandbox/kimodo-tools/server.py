"""kimodo-tools — rig-finalisation worker.

Wraps the existing kimodo + woid CLI scripts behind one HTTP endpoint so
the bridge can drive the chain without subprocessing into another
container itself.

Endpoints
---------

GET  /v1/health/ready
        200 { ok: true } when Blender + the bind-mounted scripts are
        present. Used by the bridge's service probe (kind: 'local').

POST /rig-finalize
        body:
          { pubkey, npub, backend, label, id, axis?, degrees? }
        Reads:
          /workspace/characters/<npub>/rig.glb
        Writes:
          /workspace/characters/<npub>/rig_mapping.json
          /workspace/characters/<npub>/rig_palmsdown.glb
          /kimodo/.kimodo-characters/<id>.json
          /kimodo/web/public/models/<id>.glb
        Returns:
          { ok: true, kimodoCharId, label, mapping, palmsGlbPath, palmsGlbBytes }
        On failure:
          { ok: false, stage, error }

The bridge handles the workflow's `kimodo.json` audit record itself
(it's just a small JSON marker telling the next bridge restart that
this character is already imported, plus what backend produced it).
The bridge's force-gate also lives there — kimodo-tools just runs
the chain when called.

References
----------
- generate_character.py (steps 6-8) — the same chain as a host CLI.
- docs/design/asset-pipeline-rig-import.md
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel


# Bind-mounted paths inside the container — see docker-compose.yml.
WORKSPACE = Path(os.environ.get("WORKSPACE", "/workspace"))
KIMODO_DIR = Path(os.environ.get("KIMODO_DIR", "/kimodo"))
WOID_SCRIPTS = Path(os.environ.get("WOID_SCRIPTS", "/woid-scripts"))

UNIRIG_MAPPING_PY = KIMODO_DIR / "web" / "scripts" / "unirig_mapping.py"
IMPORT_UNIRIG_GLB_PY = KIMODO_DIR / "web" / "scripts" / "import_unirig_glb.py"
GLB_PALMS_DOWN_PY = WOID_SCRIPTS / "lib" / "glb_palms_down.py"

BLENDER_BIN = os.environ.get("BLENDER_BIN", "blender")

DEFAULT_PALMS_AXIS = "Y"
DEFAULT_PALMS_DEGREES = 90.0

app = FastAPI(title="kimodo-tools", version="0.1.0")


# ── Health probe ──────────────────────────────────────────────────

def _missing_bits() -> list[str]:
    """Return whichever bind-mounts / binaries are absent."""
    miss: list[str] = []
    if shutil.which(BLENDER_BIN) is None:
        miss.append(f"blender binary ('{BLENDER_BIN}') not on PATH")
    for label, path in [
        ("unirig_mapping.py", UNIRIG_MAPPING_PY),
        ("import_unirig_glb.py", IMPORT_UNIRIG_GLB_PY),
        ("glb_palms_down.py", GLB_PALMS_DOWN_PY),
        ("/workspace", WORKSPACE),
        ("/kimodo", KIMODO_DIR),
        ("/woid-scripts", WOID_SCRIPTS),
    ]:
        if not Path(path).exists():
            miss.append(f"{label}: {path} not found")
    return miss


@app.get("/v1/health/ready")
def ready():
    miss = _missing_bits()
    if miss:
        return JSONResponse({"ok": False, "missing": miss}, status_code=503)
    return {"ok": True}


# ── /rig-finalize ─────────────────────────────────────────────────

class FinalizeRequest(BaseModel):
    pubkey: str
    npub: str
    backend: str
    label: str
    id: str
    axis: Optional[str] = DEFAULT_PALMS_AXIS
    degrees: Optional[float] = DEFAULT_PALMS_DEGREES


def _run(cmd: list, *, stage: str, timeout_s: float = 240.0) -> dict:
    """Run a subprocess; on failure, raise with stage label + tail of stderr."""
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    elapsed = time.time() - started
    if proc.returncode != 0:
        # Blender prints its version banner on stderr even on success;
        # surface only the tail so we don't dump pages of GLTF noise.
        tail = (proc.stderr or proc.stdout or "")[-800:]
        raise StageError(stage, f"{cmd[0]} exited {proc.returncode}: {tail.strip()}")
    return {"elapsed_s": round(elapsed, 2)}


class StageError(Exception):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


@app.post("/rig-finalize")
def rig_finalize(req: FinalizeRequest):
    char_dir = WORKSPACE / "characters" / req.npub
    rig_glb = char_dir / "rig.glb"
    mapping_json = char_dir / "rig_mapping.json"
    palms_glb = char_dir / "rig_palmsdown.glb"

    if not char_dir.is_dir():
        return JSONResponse(
            {"ok": False, "stage": "preflight",
             "error": f"character dir not found: {char_dir}"},
            status_code=400,
        )
    if not rig_glb.is_file():
        return JSONResponse(
            {"ok": False, "stage": "preflight",
             "error": f"rig.glb not present at {rig_glb}"},
            status_code=400,
        )

    miss = _missing_bits()
    if miss:
        return JSONResponse(
            {"ok": False, "stage": "preflight",
             "error": "kimodo-tools not fully provisioned: " + "; ".join(miss)},
            status_code=503,
        )

    try:
        # 1. Bone mapping. The labeler writes its own JSON output.
        _run(
            ["python3", str(UNIRIG_MAPPING_PY), str(rig_glb), "-o", str(mapping_json)],
            stage="mapping",
        )

        # 2. Blender palms-down bake. Same args the CLI uses.
        _run(
            [BLENDER_BIN, "--background", "--python", str(GLB_PALMS_DOWN_PY), "--",
             str(rig_glb), str(mapping_json), str(palms_glb),
             "--axis", req.axis or DEFAULT_PALMS_AXIS,
             "--degrees", str(req.degrees if req.degrees is not None else DEFAULT_PALMS_DEGREES)],
            stage="palms-down",
            timeout_s=600.0,
        )
        if not palms_glb.exists():
            raise StageError("palms-down",
                             "blender ran without error but produced no output GLB")

        # 3. Register with kimodo. The script copies the GLB into
        #    /kimodo/web/public/models/ and writes the registry record.
        _run(
            ["python3", str(IMPORT_UNIRIG_GLB_PY), str(palms_glb),
             "--id", req.id, "--label", req.label],
            stage="importing",
        )
    except StageError as e:
        return JSONResponse(
            {"ok": False, "stage": e.stage, "error": str(e)},
            status_code=500,
        )

    mapping_data = None
    try:
        mapping_data = json.loads(mapping_json.read_text())
    except Exception:
        pass

    return {
        "ok": True,
        "kimodoCharId": req.id,
        "label": req.label,
        "mapping": mapping_data,
        "palmsGlbPath": str(palms_glb),
        "palmsGlbBytes": palms_glb.stat().st_size,
    }
