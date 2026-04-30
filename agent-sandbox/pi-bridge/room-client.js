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
      agents.push({
        name: a.name,
        npub: a.npub,
        isAgent: !!a.isAgent,
        x: a.x ?? 0,
        y: a.y ?? 0,
      });
    });
  }
  return {
    messages,
    agents,
    roomName: room?.state?.roomName ?? null,
    width: room?.state?.width ?? 12,
    height: room?.state?.height ?? 16,
  };
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

export async function joinRoom(agentId, { name, npub, roomName, x, y }) {
  await leaveRoom(agentId);
  const client = await getClient();
  const room = await client.joinOrCreate("sandbox", {
    roomName: roomName || "sandbox",
    name,
    npub,
    isAgent: true,
    x, y,
  });
  connections.set(agentId, { room, client });
  await waitForState(room);
  console.log(`[room-client] ${name} joined ${roomName}`);
  return { roomId: room.id, snapshot: snapshotState(room) };
}

// Subscribe to new messages in an already-joined room. Returns an unsubscribe
// fn. Uses state-change diffing instead of onAdd callbacks so it works
// regardless of the exact colyseus.js schema-callback API version.
export function onNewMessage(agentId, handler) {
  const conn = connections.get(agentId);
  if (!conn) return () => {};
  let seen = 0;
  if (conn.room?.state?.messages) {
    seen = conn.room.state.messages.length;
  }
  const cb = () => {
    const arr = conn.room?.state?.messages;
    if (!arr) return;
    if (arr.length > seen) {
      for (let i = seen; i < arr.length; i++) {
        const m = arr[i] ?? (arr.at ? arr.at(i) : null);
        if (m) handler({ ts: m.ts, from: m.from, fromNpub: m.fromNpub, text: m.text });
      }
      seen = arr.length;
    }
  };
  try { conn.room.onStateChange(cb); } catch {}
  return () => {
    try { conn.room.onStateChange.remove?.(cb); } catch {}
  };
}

// Watch for agent position changes (moves) in the room. Calls `handler`
// with { fromNpub, fromName, x, y, wasAdjacent, isAdjacent } whenever a
// non-self agent's (x, y) changes. The caller decides what to do based
// on adjacency transition. Dedupes own-pubkey changes.
export function onPositionChange(agentId, selfPubkey, handler) {
  const conn = connections.get(agentId);
  if (!conn) return () => {};
  // Snapshot: npub -> {x,y}. Seed from current state to avoid a huge
  // burst of "arrival" events for everyone already in the room at join.
  const seen = new Map();
  if (conn.room?.state?.agents?.forEach) {
    conn.room.state.agents.forEach((a) => {
      if (a.npub) seen.set(a.npub, { x: a.x ?? 0, y: a.y ?? 0 });
    });
  }
  const selfFrom = () => {
    const agents = conn.room?.state?.agents;
    if (!agents?.forEach) return { x: 0, y: 0 };
    let me = null;
    agents.forEach((a) => { if (a.npub === selfPubkey) me = a; });
    return { x: me?.x ?? 0, y: me?.y ?? 0 };
  };
  const cb = () => {
    const agents = conn.room?.state?.agents;
    if (!agents?.forEach) return;
    const me = selfFrom();
    agents.forEach((a) => {
      const npub = a.npub;
      if (!npub || npub === selfPubkey) return;
      const prev = seen.get(npub);
      const cur = { x: a.x ?? 0, y: a.y ?? 0 };
      if (!prev) {
        // Presence is new — treat as arrival only if they're adjacent now.
        seen.set(npub, cur);
        const isAdjacent = Math.max(Math.abs(cur.x - me.x), Math.abs(cur.y - me.y)) <= 1;
        if (isAdjacent) {
          handler({ fromNpub: npub, fromName: a.name, x: cur.x, y: cur.y, wasAdjacent: false, isAdjacent: true });
        }
        return;
      }
      if (prev.x !== cur.x || prev.y !== cur.y) {
        const wasAdjacent = Math.max(Math.abs(prev.x - me.x), Math.abs(prev.y - me.y)) <= 1;
        const isAdjacent = Math.max(Math.abs(cur.x - me.x), Math.abs(cur.y - me.y)) <= 1;
        seen.set(npub, cur);
        if (!wasAdjacent && isAdjacent) {
          handler({ fromNpub: npub, fromName: a.name, x: cur.x, y: cur.y, wasAdjacent, isAdjacent });
        }
      }
    });
  };
  try { conn.room.onStateChange(cb); } catch {}
  return () => { try { conn.room.onStateChange.remove?.(cb); } catch {} };
}

// Read-only snapshot for an already-joined room (used by re-prompt builds).
export function roomSnapshot(agentId) {
  const conn = connections.get(agentId);
  if (!conn) return { messages: [], agents: [], roomName: null };
  return snapshotState(conn.room);
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

export function moveAgent(agentId, x, y) {
  const conn = connections.get(agentId);
  if (!conn) return false;
  conn.room.send("move", { x, y });
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
// identity" pattern. Initial position can be seeded via `{x, y}`.
export async function sayAs({ identityKey, roomName, name, npub, text, x, y }) {
  const key = `${identityKey}::${roomName || "sandbox"}`;
  const entry = await ensurePersistent(key, {
    roomName: roomName || "sandbox",
    name,
    npub,
    isAgent: true,
    x, y,
  });
  entry.room.send("say", { text });
  return { ok: true, roomId: entry.room.id };
}

// Move an identity's persistent room client to (x, y).
export async function moveAs({ identityKey, roomName, name, npub, x, y }) {
  const key = `${identityKey}::${roomName || "sandbox"}`;
  const entry = await ensurePersistent(key, {
    roomName: roomName || "sandbox",
    name,
    npub,
    isAgent: true,
    x, y,
  });
  entry.room.send("move", { x, y });
  return { ok: true };
}
