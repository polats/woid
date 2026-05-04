"""Tiny SSE consumer: yields (event, data_dict) tuples from a streaming
HTTP response. Matches the wire format the woid pi-bridge produces:

    event: stage
    data: {"stage":"warm","message":"..."}

    event: heartbeat
    data: {"elapsedMs":1234}

    event: done
    data: {"modelUrl":"..."}

Handles the case where one HTTP chunk contains multiple SSE events,
or an event spans multiple chunks. No external deps.
"""
from __future__ import annotations

import json
from typing import Iterator

import urllib.request
import urllib.error


def stream_sse(url: str, body: dict, *, timeout: float = 60 * 20) -> Iterator[tuple[str, dict]]:
    """Open a POST to `url` with JSON `body` and yield (event, data) pairs."""
    req = urllib.request.Request(
        url,
        method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        buf = b""
        while True:
            chunk = resp.read1(4096)
            if not chunk:
                break
            buf += chunk
            # Events are separated by a blank line (\n\n).
            while b"\n\n" in buf:
                ev_chunk, buf = buf.split(b"\n\n", 1)
                yield from _parse_event(ev_chunk)
        if buf.strip():
            yield from _parse_event(buf)


def _parse_event(chunk: bytes) -> Iterator[tuple[str, dict]]:
    event = "message"
    data_lines: list[str] = []
    for line in chunk.decode("utf-8", errors="replace").split("\n"):
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if not data_lines:
        return
    raw = "\n".join(data_lines)
    try:
        yield event, json.loads(raw)
    except json.JSONDecodeError:
        yield event, {"_raw": raw}
