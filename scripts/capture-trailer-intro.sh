#!/usr/bin/env bash
# Capture Edi's tutorial intro and stage it for the Remotion trailer.
#
#   1. Runs the Playwright spec (records full 1920x1080 webm + timing.json)
#   2. ffmpeg-trims from the "play" click → 1.5s after the target line
#   3. Re-encodes to mp4 (h264, yuv420p, 30fps)
#   4. Copies to openclaw-presentation/public/trailer/edi-intro.mp4
#
# Usage:  scripts/capture-trailer-intro.sh
# Env:    BRIDGE_URL (default http://localhost:13457)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TR_DIR="$ROOT/test-results"
TIMING_FILE="$TR_DIR/trailer-intro-timing.json"
OUT_DIR="$ROOT/../openclaw-presentation/public/trailer"
OUT_MP4="$OUT_DIR/edi-intro.mp4"

mkdir -p "$TR_DIR" "$OUT_DIR"
rm -f "$TIMING_FILE"

echo "── Running Playwright capture ──"
cd "$ROOT"
CAPTURE_TIMING_FILE="$TIMING_FILE" \
  npx playwright test e2e/capture-trailer-intro.spec.ts --headed \
  || { echo "Playwright run failed"; exit 1; }

# locate the webm output Playwright wrote (most-recent under test-results)
WEBM="$(find "$TR_DIR" -name '*.webm' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [[ -z "$WEBM" || ! -f "$WEBM" ]]; then
  echo "No webm found under $TR_DIR" >&2
  exit 1
fi
echo "── Source video: $WEBM"

if [[ ! -f "$TIMING_FILE" ]]; then
  echo "Timing file missing: $TIMING_FILE" >&2
  exit 1
fi

# read offsets + phone-frame crop box
PLAY_OFFSET="$(node -e "console.log(require('$TIMING_FILE').play_click_offset_s)")"
END_OFFSET="$(node -e "console.log(require('$TIMING_FILE').end_offset_s)")"
PX="$(node -e "console.log(require('$TIMING_FILE').phone_x)")"
PY="$(node -e "console.log(require('$TIMING_FILE').phone_y)")"
PW="$(node -e "console.log(require('$TIMING_FILE').phone_w)")"
PH="$(node -e "console.log(require('$TIMING_FILE').phone_h)")"

# ── Measure phone bounds DIRECTLY from the recording ─────────────────
# DOM coords (getBoundingClientRect) report CSS pixels but Wayland
# fractional scaling can render at a different scale, so the phone in
# the recording may not be at exactly the JS-reported (x, y, w, h).
# Scan the actual recording for the phone's dark rounded rectangle to
# get pixel-accurate bounds independent of any scaling.
#
# Strategy: take a frame where the dev panel is visible (which has
# bright high-contrast UI inside the phone), then find the bounding
# box of non-page-background pixels in the phone's horizontal slab.
PROBE_FRAME="/tmp/capture-probe-frame-$$.png"
ffmpeg -y -loglevel error -ss 5 -i "$WEBM" -frames:v 1 "$PROBE_FRAME"

BBOX_JSON="$(PROBE="$PROBE_FRAME" python3 -c "
import os, json
from PIL import Image
img = Image.open(os.environ['PROBE']).convert('RGB')
W, H = img.size
px = img.load()

# Page background is pure black (rgb < ~8). Phone bezel is ~rgb(42).
# Anything else is rendered content. The phone has plenty of cream
# pixels (lobby walls, dialog text, avatar) at most rows — enough to
# find a robust bounding box.
#
# Build a column-presence histogram: for each x, count how many rows
# contain a non-bg pixel. The phone's columns will have high counts;
# the page bg between sidebar and phone has count ≈ 0.
def is_rendered(rgb):
    r, g, b = rgb
    if max(r, g, b) < 10:
        return False  # pure black page bg
    if abs(r - 128) < 12 and abs(g - 128) < 12 and abs(b - 128) < 12:
        return False  # gray screencast padding
    return True

# Sample columns in a stride for speed
col_counts = [0] * W
for y in range(0, H, 2):
    for x in range(W):
        if is_rendered(px[x, y]):
            col_counts[x] += 1

# Find the woid sidebar's right edge: the sidebar is a contiguous
# wide block of high-count columns starting at x=0. Skip past it.
sidebar_end = 0
for x in range(W):
    if col_counts[x] < 5:
        sidebar_end = x
        break

# Phone columns: high count, past sidebar. Use threshold = max/4
# to absorb the dark Edi-suit rows that lower a column's count.
content_after_sidebar = col_counts[sidebar_end:]
max_count = max(content_after_sidebar) if content_after_sidebar else 0
threshold = max(20, max_count // 4)

# Walk past sidebar, find first run of high-count columns; that's
# the phone bezel.
left = right = None
in_run = False
runs = []
start = 0
for x in range(sidebar_end + 1, W):
    if col_counts[x] >= threshold:
        if not in_run:
            in_run = True
            start = x
    else:
        if in_run:
            in_run = False
            runs.append((start, x - 1))
if in_run:
    runs.append((start, W - 1))
if not runs:
    raise SystemExit('no phone column run found')
# longest run = the phone
runs.sort(key=lambda r: r[1] - r[0], reverse=True)
left, right = runs[0]

# Vertical extent: scan rows within [left, right] for any rendered
# pixel. Bounding box of rendered rows = phone y range.
top = None
bottom = None
for y in range(H):
    found = False
    for x in range(left, right + 1, 4):
        if is_rendered(px[x, y]):
            found = True
            break
    if found:
        if top is None:
            top = y
        bottom = y
if top is None or bottom is None:
    raise SystemExit('no phone vertical extent found')

def even(n): return n - (n % 2)
out = {
    'x': even(left),
    'y': even(top),
    'w': even(right - left + 1),
    'h': even(bottom - top + 1),
}
print(json.dumps(out))
")"

rm -f "$PROBE_FRAME"

PX="$(node -e "console.log(${BBOX_JSON}.x)")"
PY="$(node -e "console.log(${BBOX_JSON}.y)")"
PW="$(node -e "console.log(${BBOX_JSON}.w)")"
PH="$(node -e "console.log(${BBOX_JSON}.h)")"
echo "── Phone bounds measured from recording: ${PW}×${PH} @ (${PX},${PY})"

# add small pre-roll so the cut doesn't snap on the click frame
START="$(node -e "console.log(Math.max(0, ${PLAY_OFFSET} - 0.15))")"
END="$(node -e "console.log(${END_OFFSET})")"
DUR="$(node -e "console.log((${END} - ${START}).toFixed(2))")"

echo "── Trim window: ${START}s → ${END}s (${DUR}s)"
echo "── Phone-frame crop: ${PW}×${PH} @ (${PX},${PY})"

# Crop to just the phone frame so the trailer composes a clean phone
# silhouette into its 3D scene (no woid sidebar / surrounding chrome).
ffmpeg -y -hide_banner -loglevel warning \
  -ss "$START" -to "$END" -i "$WEBM" \
  -vf "crop=${PW}:${PH}:${PX}:${PY},fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -an \
  "$OUT_MP4"

echo "── Wrote $OUT_MP4"
ls -lh "$OUT_MP4"

# Aspect ratio for the trailer code (PHONE_ASPECT_H_OVER_W)
ASPECT="$(node -e "console.log((${PH} / ${PW}).toFixed(4))")"
echo "── Phone aspect (h/w) for trailer: ${ASPECT}"
echo "   Update PHONE_ASPECT_H_OVER_W in TheAgencyTrailer.tsx if changed."
