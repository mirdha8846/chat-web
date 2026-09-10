const te = new TextEncoder();
const td = new TextDecoder();
export const b64e = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
export const b64d = (s: string): Uint8Array => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
export async function genECDH(): Promise<{ kp: CryptoKeyPair; pubB64: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  return { kp, pubB64: b64e(raw) };
}
export async function importPeerPub(pubB64: string): Promise<CryptoKey> {
  const raw = b64d(pubB64);
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}
export async function deriveAES(ownPriv: CryptoKey, peerPub: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'ECDH', public: peerPub }, ownPriv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function enc(key: CryptoKey, plain: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(plain));
  return { iv: b64e(iv), ct: b64e(ct) };
}
export async function dec(key: CryptoKey, ivB64: string, ctB64: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) as BufferSource }, key, b64d(ctB64).buffer as ArrayBuffer);
  return td.decode(pt);
}
export const newId = (): string => crypto.getRandomValues(new Uint8Array(12)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '') + Date.now().toString(36);
