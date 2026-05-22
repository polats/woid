// Test scenarios — hits brain-server with several realistic flows.
// Usage:  npm run scenarios            (starts no server; you run brain-server in another terminal)
// Assumes brain-server on http://127.0.0.1:8080. Override with BRAIN_SERVER_URL.

const BASE = process.env.BRAIN_SERVER_URL ?? 'http://127.0.0.1:8080';
const FAIL = (msg) => { console.error('✗ ' + msg); process.exit(1); };

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({ ok: false, error: { code: 'parse', message: `non-json ${res.status}` } }));
  return { status: res.status, body: j };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry an LLM-hitting call on 429 with simple backoff. The endpoint we use has
// tight rate limits; sequential serialization + backoff is sufficient at this scale.
async function callWithRetry(method, path, body, { retries = 4, baseDelay = 4000 } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    const r = await call(method, path, body);
    last = r;
    if (r.body.ok) return r;
    const msg = r.body.error?.message ?? '';
    const transient = msg.includes('429') || msg.includes('aborted') || msg.includes('rate') || msg.includes('Rate');
    if (!transient) return r;
    const wait = baseDelay * (i + 1);
    console.log(`  ⏳ ${msg.slice(0, 80)} — retrying in ${wait}ms`);
    await sleep(wait);
  }
  return last;
}

function banner(s) { console.log('\n' + '═'.repeat(72) + '\n  ' + s + '\n' + '═'.repeat(72)); }
function sub(s)    { console.log('\n— ' + s + ' —'); }
function pp(o)     { console.log(JSON.stringify(o, null, 2)); }

// ── Scenario 1: status + LLM availability ───────────────────────────────
async function scenario1_status() {
  banner('1) /status — is the LLM provider configured?');
  const { body } = await call('GET', '/status');
  pp(body);
  if (!body.ok) FAIL('status not ok');
  if (!body.data.llm?.ready) {
    console.warn(`\n⚠ LLM provider not ready (provider="${body.data.llm?.provider}"). Persona+LLM-brain scenarios will fail.`);
    console.warn('  Set LLM_PROVIDER=openai-compat (or nim/local) in agent-sandbox/.env.');
  }
  return body.data.llm?.ready;
}

// ── Scenario 2: generate three personas with different seeds ──────────
async function scenario2_personas() {
  banner('2) /persona/generate — three personas with different seeds');
  const seeds = [
    'a botanist who works night shifts',
    'a retired stage magician',
    null, // no seed; fully invented
  ];
  const personas = [];
  for (const seed of seeds) {
    sub(`seed = ${seed ?? '(none)'}`);
    const { body } = await callWithRetry('POST', '/persona/generate', { seed });
    if (!body.ok) { console.error('  FAIL: ' + JSON.stringify(body.error)); continue; }
    const p = body.data.persona;
    console.log(`  name:        ${p.name}`);
    console.log(`  about:       ${p.about}`);
    console.log(`  avatar_hint: ${p.avatar_hint}`);
    console.log(`  vibe:        ${p.vibe}`);
    console.log(`  ⏱ ${body.data.ms}ms · ${JSON.stringify(body.data.usage)} · model=${body.data.model}`);
    personas.push(p);
    await sleep(2000); // throttle between calls to dodge tight rate limits
  }
  return personas;
}

// ── Scenario 3: drive Alice through multiple states ─────────────────────
async function scenario3_brainSteps(persona) {
  banner('3) /brain/step (LLM brain) — same character, changing scenarios');

  // Register Alice as an LLM-driven character
  sub('register Alice with LLM brain');
  let r = await call('POST', '/character', {
    id: 'alice',
    identity: persona ?? { name: 'Alice', about: 'curious introvert who loves overcast mornings', vibe: 'cozy' },
    brain_provider: 'llm',
  });
  if (!r.body.ok) FAIL('character: ' + JSON.stringify(r.body.error));
  console.log('  ✓ registered: ' + r.body.data.character.identity.name);

  const scenarios = [
    {
      label: 'tired (energy=15)',
      needs: { energy: 15, social: 60, hunger: 70 },
      trigger: { kind: 'heartbeat' },
      perception: [],
    },
    {
      label: 'hungry + tired (energy=30, hunger=15)',
      needs: { energy: 30, social: 60, hunger: 15 },
      trigger: { kind: 'heartbeat' },
      perception: [],
    },
    {
      label: 'social + content (high needs, friend nearby)',
      needs: { energy: 80, social: 30, hunger: 90 },
      trigger: { kind: 'event' },
      perception: [
        { kind: 'movement', who_id: 'bob', who_name: 'Bob', x: 2, y: 0, ts: Date.now() },
        { kind: 'speech', from_id: 'bob', text: 'morning!', ts: Date.now() },
      ],
    },
    {
      label: 'everything fine — should idle',
      needs: { energy: 90, social: 80, hunger: 85 },
      trigger: { kind: 'heartbeat' },
      perception: [],
    },
  ];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    sub(`tick ${i + 1}: ${s.label}`);
    const r2 = await callWithRetry('POST', '/brain/step', {
      selfId: 'alice', tick: i + 1,
      trigger: s.trigger, perception: s.perception,
      needs: s.needs, moodlets: [], traits: [], game: {},
    });
    if (!r2.body.ok) { console.error('  FAIL: ' + JSON.stringify(r2.body.error)); continue; }
    const { actions, trace_id } = r2.body.data;
    console.log('  actions: ' + JSON.stringify(actions));
    console.log('  trace_id: ' + trace_id);

    const r3 = await call('GET', `/brain/trace/alice?limit=1`);
    if (r3.body.ok) {
      const e = r3.body.data.entries[0];
      console.log('  reasoning: ' + (e?.reasoning ?? '(none)'));
      const a = e?.turns?.find((t) => t.role === 'assistant');
      if (a) console.log('  ⏱ ' + a.ms + 'ms · ' + a.tokens + ' out tokens');
    }
    await sleep(2000);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`brain-server at ${BASE}`);
  const llmReady = await scenario1_status();
  if (!llmReady) {
    console.log('\nSkipping persona + LLM-brain scenarios (no provider).\n');
    process.exit(0);
  }
  const personas = await scenario2_personas();
  await scenario3_brainSteps(personas[0]);
  console.log('\n' + '═'.repeat(72) + '\n  all scenarios completed\n' + '═'.repeat(72));
}

main().catch((e) => FAIL(e.stack ?? e.message));
