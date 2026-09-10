import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Bucket } from './rateLimit.js';
import { log } from './logger.js';

const PORT = Number(process.env.PORT ?? 8080);
const ID_RE = /^[A-Za-z0-9\-_]{16,128}$/;
const B64 = /^[A-Za-z0-9\-_+/=]{8,12000}$/;

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true, waiting: waiting ? 1 : 0 }));

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, path: '/ws' });

interface Peer {
  ws: WebSocket; idx: number; seq: number; bucket: Bucket;
  seen: Set<string>; alive: boolean; partner: Peer | null; room: string;
}

let waiting: Peer | null = null;
const pending = new Map<string, Map<string, { iv: string; ct: string; seq: number; from: number; exp: number }>>();

const send = (p: Peer, o: object): void => {
  if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(o));
};
function pair(a: Peer, b: Peer): void {
  const room = randomBytes(16).toString('base64url');
  a.room = room; b.room = room;
  a.idx = 0; b.idx = 1;
  a.partner = b; b.partner = a;
  pending.set(room, new Map());
  send(a, { t: 'authed', peers: 2 });
  send(b, { t: 'authed', peers: 2 });
  send(a, { t: 'peer', online: true, peers: 2 });
  send(b, { t: 'peer', online: true, peers: 2 });
}
function relay(from: Peer, payload: object): void {
  const p = from.partner;
  if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws: WebSocket) => {
  log('WEBSOCKET_CONNECTED');
  const peer: Peer = { ws, idx: 0, seq: 0, bucket: new Bucket(), seen: new Set(), alive: true, partner: null, room: '' };
  if (waiting && waiting.ws.readyState === WebSocket.OPEN) {
    const other = waiting; waiting = null;
    pair(other, peer);
    log('PEER_PAIRED');
  } else {
    waiting = peer;
    send(peer, { t: 'authed', peers: 1 });
    send(peer, { t: 'peer', online: false, peers: 1 });
  }
  ws.on('pong', () => { peer.alive = true; });
  ws.on('message', (raw) => {
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw.toString()); } catch { send(peer, { t: 'err', code: 'BAD_FRAME' }); return; }
    if (m.t === 'ping') { send(peer, { t: 'pong' }); return; }
    if (m.t === 'auth') {
      send(peer, { t: 'authed', peers: peer.partner ? 2 : 1 });
      return;
    }
    if (!peer.bucket.take()) { log('RATE_LIMIT_TRIGGERED'); send(peer, { t: 'err', code: 'RATE' }); return; }
    if (m.t === 'msg') {
      const { id, seq, iv, ct } = m as { id: unknown; seq: unknown; iv: unknown; ct: unknown };
      if (typeof id !== 'string' || !ID_RE.test(id) || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 ||
          typeof iv !== 'string' || typeof ct !== 'string' || !B64.test(iv) || !B64.test(ct) || (ct as string).length > 8192) {
        send(peer, { t: 'err', code: 'INVALID_CIPHERTEXT' }); return;
      }
      if (peer.seen.has(id as string)) { send(peer, { t: 'err', code: 'DUPLICATE' }); return; }
      if ((seq as number) <= peer.seq && peer.seq !== 0) { send(peer, { t: 'err', code: 'REPLAY' }); return; }
      peer.seq = seq as number; peer.seen.add(id as string);
      const pm = pending.get(peer.room);
      if (pm && peer.room) {
        pm.set(id as string, { iv: iv as string, ct: ct as string, seq: seq as number, from: peer.idx, exp: Date.now() + 30_000 });
        const k = id as string;
        setTimeout(() => { pending.get(peer.room)?.delete(k); }, 30_000).unref();
      }
      relay(peer, { t: 'msg', id, seq, iv, ct, from: peer.idx });
      return;
    }
    if (m.t === 'seen') {
      if (typeof m.id !== 'string' || !ID_RE.test(m.id)) { send(peer, { t: 'err', code: 'BAD_ID' }); return; }
      pending.get(peer.room)?.delete(m.id);
      relay(peer, { t: 'seen', id: m.id });
      return;
    }
    if (m.t === 'key') {
      if (typeof m.pub !== 'string' || typeof m.salt !== 'string' || m.pub.length > 2048 || m.salt.length > 512) {
        send(peer, { t: 'err', code: 'BAD_KEY' }); return;
      }
      relay(peer, { t: 'key', pub: m.pub, salt: m.salt, from: peer.idx });
      return;
    }
    if (m.t === 'call_offer' || m.t === 'call_answer') {
      if (typeof m.sdp !== 'string' || m.sdp.length < 10 || m.sdp.length > 12000 ||
          (m.mode !== 'video' && m.mode !== 'voice')) {
        send(peer, { t: 'err', code: 'BAD_SDP' }); return;
      }
      relay(peer, { t: m.t, sdp: m.sdp, mode: m.mode, from: peer.idx });
      return;
    }
    if (m.t === 'ice') {
      if (typeof m.cand !== 'string' || m.cand.length < 2 || m.cand.length > 2048) {
        send(peer, { t: 'err', code: 'BAD_ICE' }); return;
      }
      relay(peer, { t: 'ice', cand: m.cand, from: peer.idx });
      return;
    }
    if (m.t === 'call_end') {
      relay(peer, { t: 'call_end', from: peer.idx });
      return;
    }
    send(peer, { t: 'err', code: 'UNKNOWN' });
  });
  const hb = setInterval(() => {
    if (!peer.alive) { ws.terminate(); return; }
    peer.alive = false;
    try { ws.ping(); } catch { /* noop */ }
  }, 25_000).unref();
  ws.on('close', () => {
    clearInterval(hb);
    if (waiting === peer) waiting = null;
    const p = peer.partner;
    if (peer.room) pending.delete(peer.room);
    peer.partner = null;
    if (p && p.ws.readyState === WebSocket.OPEN) {
      p.partner = null; p.room = ''; p.seq = 0;
      if (!waiting) {
        waiting = p;
        send(p, { t: 'peer', online: false, peers: 1 });
      } else {
        const other = waiting; waiting = null;
        pair(other, p);
      }
    }
    log('WEBSOCKET_DISCONNECTED');
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log('PORT_IN_USE');
    process.stderr.write(`Port ${PORT} is already in use. Stop the other process first.\n`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => log('SERVER_STARTED'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('SERVER_SHUTDOWN');
    wss.close(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
export { app };
