import { test, expect } from '@playwright/test'

// End-to-end smoke of the agent-sandbox feature. Assumes:
//   1. `npm run agent-sandbox:up` is running (relay + room-server + pi-bridge).
//   2. `npm run dev` is running the woid frontend (or E2E_BASE_URL points at it).
//
// Skips automatically if the three services are not reachable.

const BRIDGE = 'http://localhost:13457'
const ROOMS  = 'http://localhost:12567'
const RELAY  = 'http://localhost:17777'

async function reachable(url: string) {
  try {
    const r = await fetch(url)
    return r.ok || r.status === 400
  } catch { return false }
}

async function createCharacter(name: string) {
  const r = await fetch(`${BRIDGE}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return await r.json()
}

async function spawn(pubkey: string, extras: Record<string, unknown> = {}) {
  const r = await fetch(`${BRIDGE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, ...extras }),
  })
  return await r.json()
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
      `agent-sandbox services not up — run 'npm run agent-sandbox:up'.`,
    )
  })

  test('all three services respond to /health', async () => {
    const rs = await (await fetch(`${ROOMS}/health`)).json()
    expect(rs.ok).toBe(true)
    const pb = await (await fetch(`${BRIDGE}/health`)).json()
    expect(pb.ok).toBe(true)
    expect(pb.service).toBe('pi-bridge')
  })

  test('admin endpoint returns a persistent identity', async () => {
    const a = await (await fetch(`${BRIDGE}/admin`)).json()
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(a.npub).toMatch(/^npub1/)
    expect(a.profile?.name).toBe('Administrator')
  })

  test('/models returns tool-capable catalog with a default', async () => {
    const m = await (await fetch(`${BRIDGE}/models`)).json()
    expect(m.default).toMatch(/\//)
    expect(Array.isArray(m.models)).toBe(true)
    expect(m.models.length).toBeGreaterThan(5)
    expect(m.models.some((x: { id: string }) => x.id === m.default)).toBe(true)
  })

  test('POST /characters/:pubkey/generate-profile fills about via NIM', async () => {
    const c = await createCharacter(`gen-${Date.now().toString().slice(-6)}`)
    const r = await fetch(`${BRIDGE}/characters/${c.pubkey}/generate-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 'desert radio pirate' }),
    })
    if (r.status === 502) {
      test.info().annotations.push({ type: 'skip-reason', description: 'NIM upstream unavailable' })
      await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
      return
    }
    expect(r.ok).toBe(true)
    const persona = await r.json()
    expect((persona.about?.length ?? 0) > 10).toBe(true)
    expect(persona.profileSource).toBe('ai')
    expect(persona.profileModel).toMatch(/\//) // provider/id form
    expect(persona.name).toBe(c.name) // not overwritten
    await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
  })

  test('PATCH /characters updates about + publishes kind:0 to relay', async ({ page }) => {
    const c = await createCharacter(`patch-${Date.now().toString().slice(-6)}`)
    const r = await fetch(`${BRIDGE}/characters/${c.pubkey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ about: 'field scout', name: 'field-scout-1' }),
    })
    expect(r.ok).toBe(true)
    const updated = await r.json()
    expect(updated.about).toBe('field scout')
    expect(updated.name).toBe('field-scout-1')

    // Relay should now have a kind:0 authored by this character with the updated name.
    const relayWs = RELAY.replace(/^http/, 'ws')
    const kind0 = await page.evaluate(
      async ({ url, author }) => {
        return await new Promise<{ content: string } | null>((resolve) => {
          const ws = new WebSocket(url)
          const subId = 'e2e-k0-' + Math.random().toString(36).slice(2)
          const t = setTimeout(() => { try { ws.close() } catch {}; resolve(null) }, 5000)
          ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [author], limit: 1 }]))
          ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data as string)
            if (m[0] === 'EVENT' && m[1] === subId) { clearTimeout(t); try { ws.close() } catch {}; resolve({ content: m[2].content }) }
            if (m[0] === 'EOSE') { clearTimeout(t); try { ws.close() } catch {}; resolve(null) }
          }
          ws.onerror = () => { clearTimeout(t); resolve(null) }
        })
      },
      { url: relayWs, author: c.pubkey },
    )
    expect(kind0, 'PATCH should publish a kind:0 for the character').not.toBeNull()
    const profile = JSON.parse(kind0!.content)
    expect(profile.name).toBe('field-scout-1')
    expect(profile.about).toBe('field scout')

    await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
  })

  test('streaming generate emits model, delta, and either done or error', async () => {
    const c = await createCharacter(`stream-${Date.now().toString().slice(-6)}`)
    try {
      const r = await fetch(`${BRIDGE}/characters/${c.pubkey}/generate-profile/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: 'dusty librarian' }),
      })
      if (r.status === 502) {
        test.info().annotations.push({ type: 'skip-reason', description: 'NIM upstream unavailable' })
        return
      }
      expect(r.ok).toBe(true)
      expect(r.headers.get('content-type') || '').toContain('text/event-stream')

      const text = await r.text()
      expect(text).toMatch(/event: model/)
      expect(text).toMatch(/event: delta/)
      // Either a clean `done` or a parse-error `error` counts — both prove the
      // stream protocol worked end-to-end. Non-deterministic model output
      // occasionally yields unparseable JSON and the bridge reports that
      // explicitly via `event: error`, which is correct behaviour.
      expect(text).toMatch(/event: (done|error)/)
    } finally {
      // Always clean up, even if the assertion above fails.
      await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' }).catch(() => {})
    }
  })

  test('admin announces new agents to the relay within a few seconds', async ({ page }) => {
    const admin = await (await fetch(`${BRIDGE}/admin`)).json()
    const c = await createCharacter(`announce-${Date.now().toString().slice(-6)}`)
    const result = await spawn(c.pubkey)
    expect(result.agentId).toBeTruthy()

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
            if (msg[0] === 'EOSE') { clearTimeout(timeout); try { ws.close() } catch {}; resolve(null) }
          }
          ws.onerror = () => { clearTimeout(timeout); resolve(null) }
        })
      },
      { url: relayWs, admin: admin.pubkey, agentPubkey: c.pubkey },
    )
    expect(event).not.toBeNull()
    expect(event!.content).toContain('new on the air')

    await fetch(`${BRIDGE}/agents/${result.agentId}`, { method: 'DELETE' })
    await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
  })

  test('sandbox view: info strip + cards column + room pane', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => consoleErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })

    await page.goto('/#/agent-sandbox')
    await expect(page.locator('.sandbox2-info')).toBeVisible()
    await expect(page.locator('.sandbox2-info').getByText('Administrator')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Room' })).toBeVisible()
    // Colyseus connects — observer shows 'connected'
    await expect(page.locator('.status-connected').first()).toBeVisible({ timeout: 10_000 })

    const real = consoleErrors.filter((e) => !e.includes('/api/github/me'))
    expect(real, `console errors:\n${real.join('\n')}`).toHaveLength(0)
  })

  test('+ New mints a character, shows a card, opens the profile modal', async ({ page }) => {
    await page.goto('/#/agent-sandbox')
    const before = await (await fetch(`${BRIDGE}/characters`)).json()
    await page.locator('.sandbox2-cards header').getByRole('button', { name: '+ New' }).click()
    // A new card appears in the list.
    await expect.poll(async () => {
      const r = await fetch(`${BRIDGE}/characters`)
      return (await r.json()).characters.length
    }, { timeout: 5_000 }).toBeGreaterThan(before.characters.length)
    // Profile modal auto-opens for the new character.
    await expect(page.locator('.agent-profile-modal')).toBeVisible()
    await expect(page.locator('.agent-profile-modal header h2')).toHaveText(/^ag-/)
    // Save a profile edit.
    await page.getByLabel('About').fill('ui-test about')
    // Save + publish closes the modal on success.
    await page.getByRole('button', { name: /Save/ }).click()
    await expect(page.locator('.agent-profile-modal')).toHaveCount(0, { timeout: 5_000 })

    // Cleanup — delete everything we made so repeated runs stay clean.
    const after = await (await fetch(`${BRIDGE}/characters`)).json()
    const seed = new Set(before.characters.map((c: { pubkey: string }) => c.pubkey))
    for (const c of after.characters) {
      if (!seed.has(c.pubkey)) await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
    }
  })

  test('card spawn flow: card turns running, relay gets agent kind:1, inspector shows events', async ({ page }) => {
    const name = `flow-${Date.now().toString().slice(-6)}`
    const c = await createCharacter(name)
    try {
      await page.goto('/#/agent-sandbox')
      const card = page.locator('.sandbox2-card', { hasText: name })
      await expect(card).toBeVisible({ timeout: 10_000 })

      await card.getByRole('button', { name: 'spawn' }).click()
      await expect(card).toHaveClass(/running/, { timeout: 15_000 })

      const drawer = page.locator('.agent-inspector')
      await expect(drawer).toBeVisible({ timeout: 5_000 })

      // Poll the relay directly for a kind:1 authored by this character.
      // With continuous listening the driver's first turn runs the default
      // "introduce yourself" seed, which should post within ~30-60s of spawn.
      const relayWs = RELAY.replace(/^http/, 'ws')
      const deadline = Date.now() + 120_000
      let found: { content: string } | null = null
      while (Date.now() < deadline && !found) {
        found = await page.evaluate(
          async ({ url, author }) => {
            return await new Promise<{ content: string } | null>((resolve) => {
              const ws = new WebSocket(url)
              const subId = 'e2e-' + Math.random().toString(36).slice(2)
              const t = setTimeout(() => { try { ws.close() } catch {}; resolve(null) }, 4000)
              ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [1], authors: [author], limit: 5 }]))
              ws.onmessage = (ev) => {
                const m = JSON.parse(ev.data as string)
                if (m[0] === 'EVENT' && m[1] === subId) { clearTimeout(t); try { ws.close() } catch {}; resolve({ content: m[2].content }) }
                if (m[0] === 'EOSE')                  { clearTimeout(t); try { ws.close() } catch {}; resolve(null) }
              }
              ws.onerror = () => { clearTimeout(t); resolve(null) }
            })
          },
          { url: relayWs, author: c.pubkey },
        )
        if (!found) await page.waitForTimeout(2000)
      }
      expect(found, `expected a kind:1 event from ${c.pubkey} on the relay`).not.toBeNull()

      await expect(drawer.locator('.ai-row-assistant, .ai-row-tool-call').first()).toBeVisible({ timeout: 10_000 })

      await card.getByRole('button', { name: 'stop' }).click()
      await expect(card).not.toHaveClass(/running/, { timeout: 10_000 })
    } finally {
      await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' }).catch(() => {})
    }
  })

  test('explicit stop releases the Colyseus seat (no ghost presence)', async ({ page }) => {
    // With continuous listening, a driver intentionally keeps the seat
    // across pi exits so it can react to new messages. The invariant
    // we test here is that an *explicit* stop tears everything down:
    // runtime record drops, room presence clears, card goes idle.
    const c = await createCharacter(`ghost-${Date.now().toString().slice(-6)}`)
    try {
      const result = await spawn(c.pubkey, { seedMessage: 'Just reply with the word done.' })
      await page.goto('/#/agent-sandbox')

      // Wait until the driver is listening — it shows up as a presence row.
      await expect
        .poll(async () => {
          const rows = page.locator('.sandbox2-room-body .agent-sandbox-list li', { hasText: c.name })
          return await rows.count()
        }, { timeout: 30_000 })
        .toBeGreaterThan(0)

      // Stop the runtime explicitly.
      const stopRes = await fetch(`${BRIDGE}/agents/${result.agentId}`, { method: 'DELETE' })
      expect(stopRes.ok).toBe(true)

      // Presence clears within a few state-change cycles.
      await expect
        .poll(async () => {
          const rows = page.locator('.sandbox2-room-body .agent-sandbox-list li', { hasText: c.name })
          return await rows.count()
        }, { timeout: 10_000 })
        .toBe(0)

      // Card's portrait dot is gone (runtime null after the 2min reap, but
      // running class should drop immediately since `listening` went false).
      const card = page.locator('.sandbox2-card', { hasText: c.name })
      await expect(card).not.toHaveClass(/running/, { timeout: 10_000 })
    } finally {
      await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' }).catch(() => {})
    }
  })

  test('human identity + POST /human/say lands in room + relay', async ({ page }) => {
    const human = await (await fetch(`${BRIDGE}/human`)).json()
    expect(human.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(human.npub).toMatch(/^npub1/)

    const msg = `probe-${Date.now().toString().slice(-6)} checking in`
    const r = await fetch(`${BRIDGE}/human/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    })
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(body.eventId).toMatch(/^[0-9a-f]{64}$/)

    // Relay has it.
    const relayWs = RELAY.replace(/^http/, 'ws')
    const found = await page.evaluate(
      async ({ url, author }) => {
        return await new Promise<{ content: string } | null>((resolve) => {
          const ws = new WebSocket(url)
          const subId = 'e2e-h-' + Math.random().toString(36).slice(2)
          const t = setTimeout(() => { try { ws.close() } catch {}; resolve(null) }, 4000)
          ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [1], authors: [author], limit: 5 }]))
          ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data as string)
            if (m[0] === 'EVENT' && m[1] === subId) { clearTimeout(t); try { ws.close() } catch {}; resolve({ content: m[2].content }) }
            if (m[0] === 'EOSE') { clearTimeout(t); try { ws.close() } catch {}; resolve(null) }
          }
          ws.onerror = () => { clearTimeout(t); resolve(null) }
        })
      },
      { url: relayWs, author: human.pubkey },
    )
    expect(found).not.toBeNull()
    expect(found!.content).toContain(msg)
  })

  test('room chat input sends a human message visible in the Room pane', async ({ page }) => {
    const msg = `ui-${Date.now().toString().slice(-6)}`
    await page.goto('/#/agent-sandbox')
    await page.locator('.sandbox2-chat input').fill(msg)
    await page.locator('.sandbox2-chat button').click()
    // Message should appear in the Recent chat list within a couple of
    // Colyseus state-change cycles.
    await expect(
      page.locator('.sandbox2-room-body .agent-sandbox-messages li', { hasText: msg }),
    ).toBeVisible({ timeout: 8_000 })
  })

  test('relay-feed page renders and connects', async ({ page }) => {
    await page.goto('/#/relay-feed')
    // Heading is the h1 in the main pane; sidebar also has the section label.
    await expect(page.locator('.relay-feed-view h1')).toHaveText('Nostr Relay')
    await expect(page.locator('.relay-feed-view .status-connected')).toBeVisible({ timeout: 10_000 })
  })
})
