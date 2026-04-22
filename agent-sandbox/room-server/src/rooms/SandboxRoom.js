const { Room } = require("colyseus");
const { SandboxState, AgentPresence, Message } = require("../schema/SandboxState.js");

const MAX_MESSAGES = 50;

function clamp(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

class SandboxRoom extends Room {
  onCreate(options) {
    this.setState(new SandboxState());
    this.maxClients = 20;
    this.autoDispose = true;
    this.state.roomName = options.roomName || "sandbox";
    this.state.createdAt = Date.now();
    if (options?.width)  this.state.width  = clamp(options.width,  2, 64);
    if (options?.height) this.state.height = clamp(options.height, 2, 64);

    this.onMessage("say", (client, data) => {
      const presence = this.state.agents.get(client.sessionId);
      if (!presence || !data?.text) return;
      const msg = new Message();
      msg.ts = Date.now();
      msg.from = presence.name;
      msg.fromNpub = presence.npub;
      msg.text = String(data.text).slice(0, 1000);
      this.state.messages.push(msg);
      while (this.state.messages.length > MAX_MESSAGES) {
        this.state.messages.shift();
      }
    });

    // Tile-level movement. Client supplies target coordinates; we clamp
    // them into the grid and update the presence. No A* / pathing — the
    // client is trusted to send a sensible destination.
    this.onMessage("move", (client, data) => {
      const presence = this.state.agents.get(client.sessionId);
      if (!presence) return;
      presence.x = clamp(data?.x, 0, this.state.width - 1);
      presence.y = clamp(data?.y, 0, this.state.height - 1);
    });

    console.log(`[room] Created ${this.state.roomName} (${this.roomId}) [${this.state.width}x${this.state.height}]`);
  }

  onJoin(client, options) {
    // Observers (e.g. the UI reading state) don't take a presence slot.
    // They still receive state sync as any Colyseus client does.
    // Note: `isAgent` is client-supplied and unsigned — see docs/agent-sandbox.md
    // security caveats. Localhost-only MVP; gate this with a real check before
    // exposing the stack.
    if (!options?.isAgent) {
      console.log(`[room] observer ${options?.name || client.sessionId.slice(0, 6)} attached (no presence)`);
      return;
    }
    const presence = new AgentPresence();
    presence.sessionId = client.sessionId;
    presence.name = options?.name || client.sessionId.slice(0, 6);
    presence.npub = options?.npub || "";
    presence.isAgent = true;
    presence.joinedAt = Date.now();
    // Position — clamp if supplied, else pick a free-ish random tile.
    if (options?.x !== undefined || options?.y !== undefined) {
      presence.x = clamp(options?.x, 0, this.state.width - 1);
      presence.y = clamp(options?.y, 0, this.state.height - 1);
    } else {
      presence.x = Math.floor(Math.random() * this.state.width);
      presence.y = Math.floor(Math.random() * this.state.height);
    }
    this.state.agents.set(client.sessionId, presence);
    console.log(`[room] ${presence.name} joined ${this.state.roomName} at (${presence.x},${presence.y})`);
  }

  onLeave(client) {
    const presence = this.state.agents.get(client.sessionId);
    if (!presence) return; // observer left, nothing to clean up
    console.log(`[room] ${presence.name} left ${this.state.roomName}`);
    this.state.agents.delete(client.sessionId);
  }

  onDispose() {
    console.log(`[room] ${this.state.roomName} (${this.roomId}) disposed`);
  }
}

module.exports = { SandboxRoom };
