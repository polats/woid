const { Schema, defineTypes, MapSchema, ArraySchema } = require("@colyseus/schema");

class AgentPresence extends Schema {
  constructor() {
    super();
    this.sessionId = "";
    this.name = "";
    this.npub = "";
    this.isAgent = false;
    this.joinedAt = 0;
    this.x = 0;
    this.y = 0;
  }
}
defineTypes(AgentPresence, {
  sessionId: "string",
  name: "string",
  npub: "string",
  isAgent: "boolean",
  joinedAt: "number",
  x: "uint8",
  y: "uint8",
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
    this.width = 12;
    this.height = 16;
  }
}
defineTypes(SandboxState, {
  agents: { map: AgentPresence },
  messages: [Message],
  roomName: "string",
  createdAt: "number",
  width: "uint8",
  height: "uint8",
});

module.exports = { AgentPresence, Message, SandboxState };
