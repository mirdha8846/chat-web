# Ephemeral Private Chat

Privacy-first, two-person, ephemeral chat. E2EE via WebCrypto (ECDH P-256 → AES-256-GCM), stateless ciphertext relay over WebSocket, 60s expiry after seen.

```
User A → encrypt locally → WSS → server (ciphertext only, ≤30s pending) → WSS → User B → decrypt
```

## Quickstart

```bash
cp .env.example .env
cd backend && npm install && npm run dev   # :8080
cd ../frontend && npm install && npm run dev # :5173
```

Open two browsers → Create → share ONE invite link with peer.

## Production

```bash
docker compose up --build
```

Serve frontend over HTTPS, backend over WSS. Set `ALLOWED_ORIGINS` to exact origins. Disable proxy access logs for `/ws` and `/v1/*` bodies; `access_log off` for these paths (see SECURITY.md).

## Architecture

- `shared/` — protocol constants, frame types, limits.
- `backend/` — Express + `ws`. In-memory `Store` (convId → 2 token hashes), rooms (max 2 authed sockets), pending ciphertext map with 30s TTL then `delete`. No DB, no Redis, no disk writes, no message logs.
- `frontend/` — React + Vite. Ephemeral ECDH keypair per page load (memory only, never sent: only public key relayed). `enc/dec` via AES-GCM with random 12-byte IV. Messages in React state only; countdown after `seen`; filtered out after 60s; `pagehide` clears state; no localStorage/IndexedDB/Cache usage for messages.

## Crypto design

| Layer | Mechanism |
|---|---|
| Identity | Random convId (128-bit) + 2 random 256-bit join tokens (hashed SHA-256 server-side) |
| Session | Ephemeral ECDH P-256 per page load; public keys relayed; private keys never leave device |
| Message | AES-256-GCM, random 96-bit IV per message, auth tag rejects tampering |
| Forward secrecy | Session keys are ephemeral and discarded on `pagehide`/close; compromise of long-term storage yields nothing since nothing is stored |

Threat model, limits, and honesty notes: see SECURITY.md.

## WebSocket protocol

`GET /ws` (WSS in prod). First frame ≤5s must be `{"t":"auth","c":"<convId>","tok":"<token>","v":1}` else close 4401. Then:

- C→S `msg {id, seq, iv, ct}` — opaque base64 ≤8KB, monotonic `seq` (replay guard), dedupe by `id`.
- S→C `msg {id, seq, iv, ct, from}` — relayed, also held ≤30s for reconnecting peer.
- C→S `seen {id}` → S deletes pending, relays `seen` to peer; recipient starts 60s countdown on receipt of its own echo/original send.
- `key {pub, salt}` relayed for ECDH; `ping/pong`, `peer {online, peers}`, `err {code}`.
- Close codes: 4401 auth, 4403 full/origin.

## Calls (WebRTC, peer-to-peer)

Signaling only goes over the WebSocket (`call_offer/call_answer {sdp, mode}`, `ice {cand}`, `call_end` — size-validated, rate-limited, relayed, never stored). Media flows directly browser-to-browser with WebRTC's built-in DTLS-SRTP encryption — the server cannot decrypt call audio/video. Honest limits: P2P inherently reveals your IP to your peer, and the public STUN server (`stun.l.google.com:19302`, NAT traversal only) sees your IP. No recording, no media storage anywhere.

REST: `POST /v1/conversations → {conversationId, tokens:[a,b]}`. `GET /healthz`.

## Privacy properties

- Server never sees plaintext; logs only `SERVER_STARTED, WEBSOCKET_CONNECTED/DISCONNECTED, AUTH_FAILED, RATE_LIMIT_TRIGGERED, CONVERSATION_CREATED` — no IDs, IPs, payloads, tokens, keys.
- Rate limit 20 frames/10s/conn; maxPayload 16KB; origin allowlist; heartbeat 25s; auth timeout 5s.
- Headers: CSP (no `unsafe-eval`), HSTS, nosniff, no-referrer, Permissions-Policy, no-store.
- Screenshot: context-menu/copy/drag disabled on bubbles, `getDisplayMedia` blocked with warning. **Best-effort only — cannot stop cameras, OS capture, or compromised devices.**

## Scripts

Backend: `npm run dev|build|start|test|typecheck`. Frontend: `npm run dev|build|test|typecheck`. `npm audit`, `tsc --noEmit` in CI.
