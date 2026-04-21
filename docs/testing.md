# Testing

Woid ships with an opinionated Playwright harness for end-to-end tests. It's lightweight — three files plus a `testing/` folder — and designed to give you **video evidence of every run** without wiring up a CI dashboard. Past runs are browsable inside the woid UI itself at `#/testing`.

## Quick start

```bash
# 1. install Playwright (one-time)
npm install -D @playwright/test typescript
npx playwright install chromium

# 2. start the dev server in one terminal
npm run dev

# 3. in another terminal: smoke + e2e
npm run smoke
npm run test:e2e

# 4. browse past runs — in the woid sidebar under "Testing",
#    or at http://localhost:5173/#/testing
```

## What's in the box

### `playwright.config.ts`
Points at `http://localhost:5173` by default (override with `E2E_BASE_URL`). Records video on every test, wires in the custom reporter, and keeps runs serial (`workers: 1`) so video files don't interleave.

### `testing/MarkdownReporter.ts`
Custom Playwright reporter. After each run it:

1. Creates `testing/sessions/<YYYY-MM-DD-HHMM>/` for the session.
2. Copies each test's `.webm` video into that directory with a safe filename.
3. Writes `session.md` (human-readable table) and `session.json` (machine-readable data).
4. Updates `testing/sessions/manifest.json` — a rolling list of the last 50 sessions.

### In-app Testing view (`#/testing`)
Served by `server/testing.js` — a Vite middleware plugin that exposes `/api/testing/sessions` (the manifest) and `/api/testing/sessions/<name>/<file>` (session.json + the `.webm` videos, with proper `Accept-Ranges` headers so the `<video>` element can seek).

The `Testing` React view lists every session in the left rail, highlights pass/fail, and plays each test's video inline when you click through. URL-syncs: `#/testing/<session-name>` deep-links to a specific run.

### `testing/viewer.html` (legacy)
The old standalone viewer is still present and works if you run `npx serve testing -l 3333`, but the in-app view is the preferred path — no extra server to start.

### `scripts/smoke.mjs`
Pre-flight health check. Hits a handful of dev-server URLs and validates the responses are well-formed (valid JSON, HTML contains `#root`, JS doesn't have embedded `SyntaxError` messages from a broken Vite pre-bundle). Fails fast so you don't waste ten minutes watching Playwright time out when the real problem is that your bundler crashed.

Extend the `checks` array in `scripts/smoke.mjs` as you add API routes worth guarding.

### `e2e/` folder
Your specs. A baseline `home.spec.ts` asserts the app boots and that the console is clean — use it as a template.

## Recommended flow

1. **Write the spec first**, stubbing out the behavior you want to prove.
2. **Run smoke** while iterating — catches boot-time regressions in under a second.
3. **Run e2e** locally before you commit; the reporter captures proof you can hand to reviewers.
4. **Keep sessions out of git** (they're already gitignored). The manifest is local-only history.

## Why not just Playwright's built-in HTML reporter?

Playwright's report is great for a single run but forgets the moment you run again. The Markdown reporter is append-only: every run becomes a dated directory you can scroll back through, which turns the harness into a lightweight regression log.

## Adapting to your project

- **Different dev-server port?** Edit `baseURL` in `playwright.config.ts`, or set `E2E_BASE_URL`.
- **No API routes?** Remove the `/api/*` checks from `scripts/smoke.mjs` — it'll still guard the web bundle.
- **Want CI?** The reporter writes plain files. Upload `testing/sessions/` as a build artifact and you've got a browsable archive with no additional tooling.
- **Agent-sandbox tests** are in `e2e/agent-sandbox.spec.ts` and skip cleanly when the sandbox stack isn't up (see `beforeAll` probe). Run `npm run agent-sandbox:up` first if you want full coverage.
