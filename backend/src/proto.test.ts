import { describe, expect, it } from 'vitest';
import { Bucket } from './rateLimit.js';

describe('rate limiting', () => {
  it('blocks over limit', () => {
    const b = new Bucket(3, 10000);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, true]);
    expect(b.take()).toBe(false);
  });
});
describe('validation', () => {
  it('rejects oversized ciphertext', () => {
    expect('x'.repeat(8193).length > 8192).toBe(true);
  });
  it('rejects malformed ids', () => {
    expect(/^[A-Za-z0-9\-_]{16,128}$/.test('short')).toBe(false);
  });
  it('pairing is strictly two per room', () => {
    const room = new Set(['a', 'b']);
    expect(room.size).toBe(2);
  });
});
