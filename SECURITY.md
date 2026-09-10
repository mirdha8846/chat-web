# SECURITY.md

## Calls

Media is DTLS-SRTP encrypted peer-to-peer; the server relays only signaling (SDP/ICE) and cannot decrypt call content. No recording or media persistence exists. Cannot hide: your IP from your peer (inherent to P2P ICE) and from the STUN server; use Tor/VPN at network layer if that matters to you.

## Guarantees (mechanism → claim)

1. **DB compromise → nothing to steal.** No database, no Redis, no files. `Store` holds only SHA-256(token) + expiry. Pending ciphertext is `Map` + 30s `setTimeout delete`.
2. **Backend compromise (passive) → ciphertext only.** Plaintext is encrypted with AES-256-GCM via WebCrypto before `ws.send`; decryption key derived via ECDH locally. Server validates opaque base64, never decrypts.
3. **Conv ID manipulation → rejected.** `verify(convId, token)` requires one of 2 stored hashes; seats capped at 2 authed sockets; changing ID fails auth (4401) or room-full (4403).
4. **Interception → WSS + auth encryption.** Prod requires TLS; without session key, AES-GCM tag fails.
5. **Replay → seq + id dedupe.** Monotonic per-sender `seq`, `seen:Set<id>` rejects duplicates; `seen` also deletes pending so re-delivery impossible.
6. **XSS → React escaping + slice(2000) + no `dangerouslySetInnerHTML` + strict CSP.**
7. **CSRF → WS has no cookies; REST is POST-only create with no credentials; Origin allowlist.**
8. **Token theft → 24h expiry, 256-bit entropy, single-seat binding (second use of same token rejected when seat taken).** Theft within window can join — inherent to bearer invites; mitigate by short out-of-band sharing.
9. **Unauthorized access → auth-before-anything, 5s timeout, close codes, no listing/search APIs.**
10. **Accidental logging → `logger.ts` emits only fixed event names; no args. Proxy/nginx `access_log off` for `/ws`, no body logging.**
11. **Browser caching → `Cache-Control: no-store`, no localStorage/IndexedDB/Cache for messages, `pagehide` clears state (opt out of bfcache).**
12. **Infra logging → documented `access_log off`, no APM/error payload capture; audit checklist in README.**

## Cannot protect against

Compromised endpoint, malware/keyloggers, screen photography, OS-level recording, browser/OS 0-days, malicious peer on their own device, active server serving backdoored JS (use pinning/reproducible builds), traffic-analysis/metadata (timing, size, online presence), RAM forensics on compromised device.

## Honesty notes

- We say "removed from app state; persistent browser storage not used for retention" — NOT "wiped from RAM" (JS cannot guarantee GC/physical wipe).
- Screenshot measures are best-effort deterrence, not prevention.
- ECDH P-256 + AES-GCM uses audited WebCrypto primitives; no custom crypto. P-256 chosen for universal WebCrypto support (X25519 not universally available); ECDH keys are ephemeral per page load for forward-secrecy-friendly sessions.
