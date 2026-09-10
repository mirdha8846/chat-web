import { createHash, randomBytes } from 'node:crypto';
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
export const rid = (n = 16): string => randomBytes(n).toString('base64url');
export interface Conv {
  id: string;
  tokenHashes: string[];
  createdAt: number;
  expiresAt: number;
}
export class Store {
  convs = new Map<string, Conv>();
  create(): { id: string; tokens: [string, string] } {
    const id = rid(16);
    const a = rid(32);
    const b = rid(32);
    const now = Date.now();
    this.convs.set(id, {
      id,
      tokenHashes: [hashToken(a), hashToken(b)],
      createdAt: now,
      expiresAt: now + 24 * 3600_000,
    });
    return { id, tokens: [a, b] };
  }
  verify(convId: string, tok: string): number {
    const c = this.convs.get(convId);
    if (!c || Date.now() > c.expiresAt) return -1;
    const h = hashToken(tok);
    return c.tokenHashes.indexOf(h);
  }
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.convs) if (now > v.expiresAt) this.convs.delete(k);
  }
}
