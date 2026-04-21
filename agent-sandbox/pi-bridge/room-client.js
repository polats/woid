// agentId -> { room, client }
const connections = new Map();
// roomName -> { client, room, opts }  — persistent peers like "human"
const persistentClients = new Map();

async function getClient() {
  const { Client } = await import("colyseus.js");
  return new Client(process.env.ROOM_SERVER_URL || "ws://localhost:2567");
}

function snapshotState(room) {
  const messages = [];
  const agents = [];
  if (room?.state?.messages?.forEach) {
    room.state.messages.forEach((m) => {
      messages.push({ ts: m.ts, from: m.from, fromNpub: m.fromNpub, text: m.text });
    });
  }
  if (room?.state?.agents?.forEach) {
    room.state.agents.forEach((a) => {
      agents.push({ name: a.name, npub: a.npub, isAgent: !!a.isAgent });
    });
  }
  return { messages, agents, roomName: room?.state?.roomName ?? null };
}

// Wait briefly for the initial state to arrive after join. Colyseus pushes
// full state right after onJoin; we race against a short fallback timer so
// empty rooms don't block spawn.
function waitForState(room, timeoutMs = 600) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve(); }
    }, timeoutMs);
    try {
      room.onStateChange.once(() => {
        if (!done) { done = true; clearTimeout(t); resolve(); }
      });
    } catch {
      clearTimeout(t); resolve();
    }
  });
}

export async function joinRoom(agentId, { name, npub, roomName }) {
  await leaveRoom(agentId);
  const client = await getClient();
  const room = await client.joinOrCreate("sandbox", {
    roomName: roomName || "sandbox",
    name,
    npub,
    isAgent: true,
  });
  connections.set(agentId, { room, client });
  await waitForState(room);
  console.log(`[room-client] ${name} joined ${roomName}`);
  return { roomId: room.id, snapshot: snapshotState(room) };
}

export async function leaveRoom(agentId) {
  const conn = connections.get(agentId);
  if (!conn) return;
  try { conn.room.leave(); } catch {}
  connections.delete(agentId);
}

export function sendSay(agentId, text) {
  const conn = connections.get(agentId);
  if (!conn) return false;
  conn.room.send("say", { text });
  return true;
}

// Keep a single persistent Colyseus client per (roomName + identity kind)
// so we don't bounce joins on every POST. Reuses on repeat calls; reconnects
// transparently if the previous room dropped.
async function ensurePersistent(key, opts) {
  const existing = persistentClients.get(key);
  if (existing && existing.room && !existing.room.connection?.isClosed) return existing;
  const client = await getClient();
  const room = await client.joinOrCreate("sandbox", { ...opts });
  await waitForState(room);
  const entry = { client, room, opts };
  persistentClients.set(key, entry);
  room.onLeave?.(() => {
    if (persistentClients.get(key) === entry) persistentClients.delete(key);
  });
  return entry;
}

// Posts a `say` in the named room on behalf of a named identity. Used for
// the human text box in the Room pane, but could drive any "observer
// identity" pattern.
export async function sayAs({ identityKey, roomName, name, npub, text }) {
  const key = `${identityKey}::${roomName || "sandbox"}`;
  const entry = await ensurePersistent(key, {
    roomName: roomName || "sandbox",
    name,
    npub,
    isAgent: true, // join as a presence so other clients see the roster
  });
  entry.room.send("say", { text });
  return { ok: true, roomId: entry.room.id };
}
