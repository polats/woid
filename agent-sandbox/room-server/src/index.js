const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server, LobbyRoom } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { SandboxRoom } = require("./rooms/SandboxRoom.js");

const PORT = parseInt(process.env.PORT || "2567");

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "room-server" });
});

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("lobby", LobbyRoom);

gameServer.define("sandbox", SandboxRoom)
  .filterBy(["roomName"])
  .enableRealtimeListing();

gameServer.listen(PORT).then(() => {
  console.log(`[room-server] listening on :${PORT}`);
  console.log(`[room-server] rooms: sandbox (filtered by roomName), lobby`);
});
