const { Schema, defineTypes, MapSchema, ArraySchema } = require("@colyseus/schema");

class AgentPresence extends Schema {
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.npub = "";
    this.isAgent = false;
    this.joinedAt = 0;
  }
}
defineTypes(AgentPresence, {
  sessionId: "string",
  name: "string",
  npub: "string",
  isAgent: "boolean",
  joinedAt: "number",
});

class Message extends Schema {
  constructor() {
    super();
    this.ts = 0;
    this.from = "";
    this.fromNpub = "";
    this.text = "";
  }
}
defineTypes(Message, {
  ts: "number",
  from: "string",
  fromNpub: "string",
  text: "string",
});

class SandboxState extends Schema {
  constructor() {
    super();
    this.agents = new MapSchema();
    this.messages = new ArraySchema();
    this.roomName = "sandbox";
    this.createdAt = 0;
  }
}
defineTypes(SandboxState, {
  agents: { map: AgentPresence },
  messages: [Message],
  roomName: "string",
  createdAt: "number",
});

module.exports = { AgentPresence, Message, SandboxState };
