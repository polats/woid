#!/usr/bin/env node
/**
 * Walk Playwright's `test-results/` directory, pair each test's
 * `video.webm` with its `details.json` (written by e2e/lib/test-details),
 * and emit a single rich session bundle under
 * `testing/sessions/<timestamp>/` that the Testing view (src/Testing.jsx)
 * renders.
 *
 * The Vite plugin (server/testing.js) serves these on the same port
 * as the SPA, so the result lands at:
 *   http://localhost:5174/#/testing/<session-name>
 *
 *   $ node testing/scripts/bundle-session.mjs
 *   session: testing/sessions/2026-04-26-1647 — 2 tests, 2 videos
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, "test-results");
const SESSIONS_DIR = path.join(ROOT, "testing", "sessions");

function safe(s) {
  return s.replace(/[^a-z0-9]+/gi, "_").toLowerCase().replace(/^_+|_+$/g, "");
}

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); }
  catch { return null; }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  if (!(await exists(RESULTS_DIR))) {
    console.error(`No ${RESULTS_DIR} — run a test first.`);
    process.exit(1);
  }

  const dirs = (await fs.readdir(RESULTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => path.join(RESULTS_DIR, d.name));

  /** @type {Array<object>} */
  const tests = [];
  let totalDuration = 0;
  let allPass = true;

  for (const dir of dirs) {
    const detailsPath = path.join(dir, "details.json");
    const videoPath = path.join(dir, "video.webm");
    const hasDetails = await exists(detailsPath);
    const hasVideo = await exists(videoPath);
    if (!hasDetails && !hasVideo) continue;
    const details = hasDetails ? await readJSON(detailsPath) : null;
    const title = details?.title || path.basename(dir).replace(/-chromium$/, "");
    const ok = !details ? true : details.steps?.every((s) => s.ok !== false) ?? true;
    if (!ok) allPass = false;
    let duration = 0;
    if (details?.artifacts?.movement?.elapsed_ms) {
      duration = details.artifacts.movement.elapsed_ms;
    }
    totalDuration += duration;

    tests.push({
      title,
      ok,
      duration,
      spec: details?.spec,
      summary: details?.summary,
      steps: details?.steps,
      artifacts: details?.artifacts,
      videoFilename: hasVideo ? `${safe(title)}.webm` : undefined,
      _videoSrc: hasVideo ? videoPath : null,
    });
  }

  if (tests.length === 0) {
    console.error("No tests with details.json or video.webm found.");
    process.exit(1);
  }

  const now = new Date();
  const sessionName =
    `${now.toISOString().slice(0, 10)}-` +
    `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const sessionDir = path.join(SESSIONS_DIR, sessionName);
  await fs.mkdir(sessionDir, { recursive: true });

  // Copy videos into the session dir.
  for (const t of tests) {
    if (t._videoSrc && t.videoFilename) {
      await fs.copyFile(t._videoSrc, path.join(sessionDir, t.videoFilename));
    }
    delete t._videoSrc;
  }

  const sessionData = {
    name: sessionName,
    date: now.toISOString(),
    pass: allPass,
    duration: totalDuration,
    tests,
  };
  await fs.writeFile(
    path.join(sessionDir, "session.json"),
    JSON.stringify(sessionData, null, 2),
  );

  // Update manifest.
  const manifestPath = path.join(SESSIONS_DIR, "manifest.json");
  let manifest = (await readJSON(manifestPath)) || [];
  manifest = manifest.filter((s) => s.name !== sessionName);
  manifest.unshift({
    name: sessionName,
    date: now.toISOString(),
    pass: allPass,
    duration: totalDuration,
    testCount: tests.length,
    passCount: tests.filter((t) => t.ok).length,
  });
  manifest = manifest.slice(0, 50);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const url = `http://localhost:5174/#/testing/${sessionName}`;
  const videoCount = tests.filter((t) => t.videoFilename).length;
  console.log(
    `\nsession: ${path.relative(ROOT, sessionDir)}` +
    ` — ${tests.length} test${tests.length === 1 ? "" : "s"}` +
    `, ${videoCount} video${videoCount === 1 ? "" : "s"}`,
  );
  console.log(`open:    ${url}\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
