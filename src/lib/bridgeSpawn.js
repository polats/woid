/**
 * Sims-flavored bridge driver — the one place that knows how to ask
 * the pi-bridge to either spawn an agent at a tile or move an
 * existing runtime to one. Used by both the agent sandbox page and
 * the Sims game phone view.
 *
 *   const { moved, agentId, x, y } = await spawnOrMoveBridgeAgent({
 *     bridgeUrl, character, target: { x, y }, models, roomName,
 *   })
 *
 * Throws on non-2xx — the caller's toast envelope catches it.
 */
export async function spawnOrMoveBridgeAgent({
  bridgeUrl,
  character,
  target,
  models = [],
  roomName = 'sandbox',
}) {
  const { x, y } = target;
  if (character.runtime?.running) {
    const r = await fetch(`${bridgeUrl}/agents/${character.runtime.agentId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    });
    if (!r.ok) throw new Error(await r.text());
    return { moved: true, agentId: character.runtime.agentId, x, y };
  }
  const provider = character.model
    ? models.find((m) => m.id === character.model)?.provider
    : undefined;
  const body = {
    pubkey: character.pubkey,
    roomName,
    x, y,
    ...(character.model ? { model: character.model } : {}),
    ...(provider ? { provider } : {}),
    ...(character.harness ? { harness: character.harness } : {}),
    ...(character.promptStyle ? { promptStyle: character.promptStyle } : {}),
  };
  const r = await fetch(`${bridgeUrl}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  const result = await r.json();
  return { moved: false, agentId: result.agentId, x, y };
}

/**
 * Stop a running bridge runtime by deleting its agent record.
 * No-op if the character has no live runtime.
 */
export async function stopBridgeAgent({ bridgeUrl, character }) {
  const agentId = character.runtime?.agentId;
  if (!agentId) return;
  const r = await fetch(`${bridgeUrl}/agents/${agentId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
}
