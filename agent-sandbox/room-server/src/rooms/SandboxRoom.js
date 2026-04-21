const { Room } = require("colyseus");
const { SandboxState, AgentPresence, Message } = require("../schema/SandboxState.js");

const MAX_MESSAGES = 50;

class SandboxRoom extends Room {
  onCreate(options) {
    this.setState(new SandboxState());
    this.maxClients = 20;
    this.autoDispose = true;
    this.state.roomName = options.roomName || "sandbox";
    this.state.createdAt = Date.now();

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

    console.log(`[room] Created ${this.state.roomName} (${this.roomId})`);
  }

  onJoin(client, options) {
    const presence = new AgentPresence();
    presence.sessionId = client.sessionId;
    presence.name = options?.name || client.sessionId.slice(0, 6);
    presence.npub = options?.npub || "";
    presence.isAgent = !!options?.isAgent;
    presence.joinedAt = Date.now();
    this.state.agents.set(client.sessionId, presence);
    console.log(`[room] ${presence.name} joined ${this.state.roomName}`);
  }

  onLeave(client) {
    const presence = this.state.agents.get(client.sessionId);
    if (presence) {
      console.log(`[room] ${presence.name} left ${this.state.roomName}`);
    }
    this.state.agents.delete(client.sessionId);
  }

  onDispose() {
    console.log(`[room] ${this.state.roomName} (${this.roomId}) disposed`);
  }
}

module.exports = { SandboxRoom };
