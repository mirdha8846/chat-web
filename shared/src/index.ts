export const PROTOCOL_VERSION = 1;
export const MAX_CIPHERTEXT_CHARS = 8192;
export const MAX_MESSAGE_BYTES = 8 * 1024;
export const SEEN_EXPIRY_MS = 60_000;
export const PENDING_TTL_MS = 30_000;
export const HEARTBEAT_MS = 25_000;
export const AUTH_TIMEOUT_MS = 5_000;

export type ClientFrame =
  | { t: 'auth'; c: string; tok: string; v: number }
  | { t: 'msg'; id: string; seq: number; iv: string; ct: string }
  | { t: 'seen'; id: string }
  | { t: 'key'; pub: string; salt: string }
  | { t: 'call_offer'; sdp: string; mode: 'video' | 'voice' }
  | { t: 'call_answer'; sdp: string; mode: 'video' | 'voice' }
  | { t: 'ice'; cand: string }
  | { t: 'call_end' }
  | { t: 'ping' };

export type ServerFrame =
  | { t: 'authed'; peers: number }
  | { t: 'msg'; id: string; seq: number; iv: string; ct: string; from: number }
  | { t: 'seen'; id: string }
  | { t: 'key'; pub: string; salt: string; from: number }
  | { t: 'peer'; online: boolean; peers: number }
  | { t: 'err'; code: string }
  | { t: 'pong' };

export const B64URL = /^[A-Za-z0-9\-_]{16,11000}$/;
export const ID_RE = /^[A-Za-z0-9\-_]{16,128}$/;
