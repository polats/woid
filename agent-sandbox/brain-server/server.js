import express from 'express';
import cors from 'cors';
import { statusRouter } from './routes/status.js';
import { verbsRouter } from './routes/verbs.js';
import { characterRouter } from './routes/character.js';
import { brainRouter } from './routes/brain.js';
import { personaRouter } from './routes/persona.js';

// 8080 because s&box's HTTP whitelist (engine source: SboxHttpHandler.IsAllowedLoopbackPort)
// only permits loopback ports 80/443/8080/8443 from game code unless launched with
// -allowlocalhttp. 7777 is strfry, 2567 is colyseus; 8080 is canonical alt-HTTP.
const PORT = Number(process.env.BRAIN_SERVER_PORT ?? 8080);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '4mb' }));

// Tiny access log; brain-server is meant to be observable.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use(statusRouter);
app.use(verbsRouter);
app.use(characterRouter);
app.use(brainRouter);
app.use(personaRouter);

// Bind to 0.0.0.0 so the user can test from their browser or another machine
// on LAN. sbox itself still connects via 127.0.0.1 (loopback-allowlist).
const HOST = process.env.BRAIN_SERVER_HOST ?? '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`brain-server listening on http://${HOST}:${PORT}`);
  console.log('endpoints: /status /verbs /character /brain/step /brain/trace /persona/generate');
});
