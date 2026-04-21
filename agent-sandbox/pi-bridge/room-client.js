const connections = new Map();

async function getClient() {
  const { Client } = await import("colyseus.js");
  return new Client(process.env.ROOM_SERVER_URL || "ws://localhost:2567");
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
  console.log(`[room-client] ${name} joined ${roomName}`);
  return { roomId: room.id };
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
