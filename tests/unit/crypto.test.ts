import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Token-at-rest encryption. What matters here is that ciphertext is not
 * reusable, not malleable, and not decryptable with the wrong key — the
 * properties the privacy policy's "encrypted refresh tokens" claim rests on.
 */

const KEY = randomBytes(32).toString('base64');
let encryptSecret: typeof import('@/lib/crypto').encryptSecret;
let decryptSecret: typeof import('@/lib/crypto').decryptSecret;
let safeEqual: typeof import('@/lib/crypto').safeEqual;
let hashIdentifier: typeof import('@/lib/crypto').hashIdentifier;

beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  const mod = await import('@/lib/crypto');
  ({ encryptSecret, decryptSecret, safeEqual, hashIdentifier } = mod);
});

afterAll(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a token', () => {
    const token = '1//0gL_refresh_token_example_value';
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it('round-trips unicode and empty strings', () => {
    for (const value of ['', 'ünïcodé — ✓', 'x'.repeat(4096)]) {
      expect(decryptSecret(encryptSecret(value))).toBe(value);
    }
  });

  it('produces different ciphertext each time for the same plaintext', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('never leaks the plaintext into the ciphertext', () => {
    const secret = 'super-secret-refresh-token';
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it('is versioned so the format can be rotated later', () => {
    expect(encryptSecret('x').startsWith('v1.')).toBe(true);
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const payload = encryptSecret('genuine');
    const parts = payload.split('.');
    // Flip a character in the ciphertext segment.
    const body = parts[3]!;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects a tampered authentication tag', () => {
    const parts = encryptSecret('genuine').split('.');
    const tag = parts[2]!;
    const tampered = `${parts[0]}.${parts[1]}.${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}.${parts[3]}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects a malformed payload', () => {
    for (const bad of ['', 'nonsense', 'v1.a.b', 'v2.a.b.c', 'v1....']) {
      expect(() => decryptSecret(bad), bad).toThrow();
    }
  });

  it('cannot be decrypted with a different key', async () => {
    const payload = encryptSecret('secret');
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    // The module caches nothing, so the new key takes effect immediately.
    expect(() => decryptSecret(payload)).toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });

  it('refuses a key that is not 32 bytes', () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    expect(() => encryptSecret('x')).toThrow(/32 bytes/);
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });

  it('refuses to run with no key configured', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects everything else', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('hashIdentifier', () => {
  it('is stable, fixed-length, and not the input', () => {
    const ip = '203.0.113.7';
    const hash = hashIdentifier(ip);
    expect(hash).toBe(hashIdentifier(ip));
    expect(hash).toHaveLength(32);
    expect(hash).not.toContain(ip);
    expect(hashIdentifier('203.0.113.8')).not.toBe(hash);
  });
});
