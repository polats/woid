import { test, expect } from '@playwright/test'

// End-to-end smoke of the agent-sandbox feature. Assumes:
//   1. `npm run agent-sandbox:up` is running (relay + room-server + pi-bridge).
//   2. `npm run dev` is running the woid frontend (or E2E_BASE_URL points at it).
//
// Skips automatically if the three services are not reachable.

const BRIDGE = 'http://localhost:13457'
const ROOMS  = 'http://localhost:12567'
const RELAY  = 'http://localhost:17777'

async function reachable(url: string, opts?: RequestInit) {
  try {
    const r = await fetch(url, opts)
    return r.ok || r.status === 400
  } catch {
    return false
  }
}

test.describe('agent-sandbox', () => {
  test.beforeAll(async () => {
    const [rs, pb, rl] = await Promise.all([
      reachable(`${ROOMS}/health`),
      reachable(`${BRIDGE}/health`),
      reachable(RELAY),
    ])
    test.skip(
      !(rs && pb && rl),
      `agent-sandbox services not up (room-server=${rs} pi-bridge=${pb} relay=${rl}). Run 'npm run agent-sandbox:up'.`,
    )
  })

  test('all three services respond to /health', async () => {
    const rsBody = await (await fetch(`${ROOMS}/health`)).json()
    expect(rsBody.ok).toBe(true)

    const pbBody = await (await fetch(`${BRIDGE}/health`)).json()
    expect(pbBody.ok).toBe(true)
    expect(pbBody.service).toBe('pi-bridge')
  })

  test('admin endpoint returns a persistent identity', async () => {
    const a = await (await fetch(`${BRIDGE}/admin`)).json()
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.npub).toMatch(/^npub1/)
    expect(a.profile?.name).toBe('Administrator')
  })

  test('/models returns tool-capable catalog with a default', async () => {
    const m = await (await fetch(`${BRIDGE}/models`)).json()
    expect(m.default).toMatch(/\//) // provider/id form
    expect(Array.isArray(m.models)).toBe(true)
    expect(m.models.length).toBeGreaterThan(5)
    const hasDefault = m.models.some((x: { id: string }) => x.id === m.default)
    expect(hasDefault).toBe(true)
  })

  test('spawning with an explicit model is reflected in the agent record and UI badge', async ({ page }) => {
    const m = await (await fetch(`${BRIDGE}/models`)).json()
    // Pick the smallest (non-default) model so the badge is distinguishable.
    const picked = m.models.find((x: { id: string }) => x.id !== m.default) || m.models[0]
    expect(picked).toBeTruthy()

    const name = `mdl-${Date.now().toString().slice(-6)}`
    const spawn = await (await fetch(`${BRIDGE}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, model: picked.id }),
    })).json()
    expect(spawn.model).toBe(picked.id)

    const list = await (await fetch(`${BRIDGE}/agents`)).json()
    const rec = list.agents.find((a: { agentId: string }) => a.agentId === spawn.agentId)
    expect(rec?.model).toBe(picked.id)

    // UI — the badge renders the short name (last path segment)
    await page.goto('/#/agent-sandbox')
    const row = page.locator('.agent-sandbox-pane')
      .filter({ hasText: 'Active agents' })
      .locator('li', { hasText: name })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row.locator('.agent-model-badge')).toContainText(picked.id.split('/').pop())

    // Cleanup
    await fetch(`${BRIDGE}/agents/${spawn.agentId}`, { method: 'DELETE' })
  })

  test('admin announces new agents to the relay within a few seconds', async ({ page }) => {
    const admin = await (await fetch(`${BRIDGE}/admin`)).json()
    const spawnResp = await (await fetch(`${BRIDGE}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `announce-${Date.now().toString().slice(-6)}` }),
    })).json()
    expect(spawnResp.npub).toMatch(/^[0-9a-f]{64}$/)

    // Query the relay for admin kind:1 events mentioning this agent
    const relayWs = RELAY.replace(/^http/, 'ws')
    const event = await page.evaluate(
      async ({ url, admin, agentPubkey }) => {
        return await new Promise<{ content: string } | null>((resolve) => {
          const ws = new WebSocket(url)
          const subId = 'e2e-admin-' + Math.random().toString(36).slice(2)
          const timeout = setTimeout(() => { try { ws.close() } catch {}; resolve(null) }, 8000)
          ws.onopen = () => ws.send(JSON.stringify([
            'REQ', subId,
            { kinds: [1], authors: [admin], '#p': [agentPubkey], limit: 5 },
          ]))
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data as string)
            if (msg[0] === 'EVENT' && msg[1] === subId) {
              clearTimeout(timeout); try { ws.close() } catch {}
              resolve({ content: msg[2].content })
            }
            if (msg[0] === 'EOSE') {
              clearTimeout(timeout); try { ws.close() } catch {}
              resolve(null)
            }
          }
          ws.onerror = () => { clearTimeout(timeout); resolve(null) }
        })
      },
      { url: relayWs, admin: admin.pubkey, agentPubkey: spawnResp.npub },
    )
    expect(event, 'admin should publish a welcome kind:1 with p-tag for the new agent').not.toBeNull()
    expect(event!.content).toContain('new on the air')

    // Cleanup
    await fetch(`${BRIDGE}/agents/${spawnResp.agentId}`, { method: 'DELETE' })
  })

  test('sandbox UI surfaces admin + relay info and the feed populates', async ({ page }) => {
    await page.goto('/#/agent-sandbox')
    // Info strip visible
    await expect(page.locator('.agent-sandbox-info')).toBeVisible()
    await expect(page.getByText('Administrator')).toBeVisible({ timeout: 5_000 })

    // Relay feed status should reach 'connected' via native WS
    const feedStatus = page.locator('.agent-sandbox-pane').filter({ hasText: 'Relay feed' }).locator('.status-connected')
    await expect(feedStatus).toBeVisible({ timeout: 5_000 })
  })

  test('sandbox view loads and renders the three panes', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => consoleErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto('/#/agent-sandbox')
    await expect(page.getByRole('heading', { name: 'Create agent' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Room' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Relay feed' })).toBeVisible()

    // Room status should reach 'connected' (observer joins the Colyseus room)
    await expect(page.locator('.status-connected').first()).toBeVisible({ timeout: 10_000 })

    // Filter out the known-noisy one-shot fetch failures from /api/github/me (no token in CI).
    const real = consoleErrors.filter((e) => !e.includes('/api/github/me'))
    expect(real, `console errors:\n${real.join('\n')}`).toHaveLength(0)
  })

  test('spawning an agent registers it on pi-bridge and publishes kind:1 to relay', async ({ page }) => {
    await page.goto('/#/agent-sandbox')
    await expect(page.getByRole('heading', { name: 'Create agent' })).toBeVisible()

    const name = `scout-${Date.now().toString().slice(-6)}`

    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Seed message (optional)').fill(
      'Post exactly one short greeting to the room using post.sh, then stop.',
    )
    await page.getByRole('button', { name: /Spawn/ }).click()

    // Agent appears in the "Active agents" list in the left pane
    const agentRow = page
      .locator('.agent-sandbox-pane')
      .filter({ hasText: 'Active agents' })
      .locator('li', { hasText: name })
    await expect(agentRow).toBeVisible({ timeout: 15_000 })

    // Cross-check on the bridge's own /agents endpoint
    const bridgeList = await (await fetch(`${BRIDGE}/agents`)).json()
    const match = bridgeList.agents.find((a: { name: string }) => a.name === name)
    expect(match, 'agent should appear in GET /agents').toBeTruthy()
    expect(match.npub).toMatch(/^[0-9a-f]{64}$/)

    // Poll the relay for a kind:1 event authored by THIS agent's pubkey.
    // Agent spawn → pi inference → post.sh → /internal/post → relay publish.
    // Cold-start on NIM can take 20-60s.
    const relayWs = RELAY.replace(/^http/, 'ws')
    const deadline = Date.now() + 120_000
    let event: { pubkey: string; content: string } | null = null
    while (Date.now() < deadline && !event) {
      event = await page.evaluate(
        async ({ url, authorHex }) => {
          return await new Promise<{ pubkey: string; content: string } | null>((resolve) => {
            const ws = new WebSocket(url)
            const subId = 'e2e-' + Math.random().toString(36).slice(2)
            const timeout = setTimeout(() => { try { ws.close() } catch {}; resolve(null) }, 4000)
            ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [1], authors: [authorHex], limit: 5 }]))
            ws.onmessage = (ev) => {
              const msg = JSON.parse(ev.data as string)
              if (msg[0] === 'EVENT' && msg[1] === subId) {
                clearTimeout(timeout); try { ws.close() } catch {}
                resolve({ pubkey: msg[2].pubkey, content: msg[2].content })
              }
              if (msg[0] === 'EOSE') {
                clearTimeout(timeout); try { ws.close() } catch {}
                resolve(null)
              }
            }
            ws.onerror = () => { clearTimeout(timeout); resolve(null) }
          })
        },
        { url: relayWs, authorHex: match.npub },
      )
      if (!event) await page.waitForTimeout(2000)
    }

    expect(event, `expected a kind:1 event from agent ${match.npub} on the relay`).not.toBeNull()
    expect(event!.pubkey).toBe(match.npub)

    // Observability — clicking the agent row opens the inspector drawer,
    // which backfills pi events (at least a tool_execution_start or assistant message).
    await agentRow.click()
    const drawer = page.locator('.agent-inspector')
    await expect(drawer).toBeVisible()
    // Expect at least one assistant or tool-call row from the pi NDJSON stream
    await expect(
      drawer.locator('.ai-row-assistant, .ai-row-tool-call').first(),
    ).toBeVisible({ timeout: 10_000 })

    // Cleanup — stop the agent we spawned
    await page.getByRole('button', { name: 'stop' }).first().click()
  })
})
