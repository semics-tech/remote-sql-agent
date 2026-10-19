import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { parseTrustedProxies, trustProxyOption } from '../src/trusted-proxies.js';

/**
 * `request.ip` is not cosmetic. It is what @fastify/rate-limit counts against,
 * and it is the `remoteAddress` written to every audit row and every session —
 * so an address the caller can choose is both a rate-limit bypass and an audit
 * trail that names whoever the attacker felt like naming.
 *
 * Fastify's `trustProxy: true` means "trust the entire X-Forwarded-For chain",
 * and the leftmost entry of that chain is the one the *client* wrote. A hop
 * count was the next attempt, and it could not tell a request that came through
 * the proxy from one that did not; Fastify 5.12.2 stopped honouring it. What is
 * left is an allowlist of proxy addresses, which these tests pin.
 *
 * The behaviour is a function of the Fastify option alone, so this configures a
 * bare instance the way createApp() does rather than standing up the API.
 * `inject` connects from 127.0.0.1 unless told otherwise.
 */

async function ipReportedBy(
  trusted: string[],
  headers: Record<string, string>,
  remoteAddress = '127.0.0.1',
) {
  const app = Fastify({ trustProxy: trustProxyOption(trusted) });
  app.get('/whoami', async (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({ method: 'GET', url: '/whoami', headers, remoteAddress });
    return response.json().ip as string;
  } finally {
    await app.close();
  }
}

describe('client IP attribution', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    // The default, and the only setting a caller cannot influence at all.
    const ip = await ipReportedBy([], { 'x-forwarded-for': '1.2.3.4' });
    expect(ip).toBe('127.0.0.1');
  });

  it('takes the address the trusted proxy added, not the one the client sent', async () => {
    // What a spoofing attempt looks like on the wire: the caller sends a header,
    // the proxy appends the address it actually saw. Believing the caller's
    // entry is the bug; the proxy's entry is the rightmost one.
    const ip = await ipReportedBy(['127.0.0.1'], { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(ip).toBe('203.0.113.9');
  });

  it('does not let a longer forged chain push the real address out of reach', async () => {
    // Padding the header is the obvious attack: only entries that arrived from a
    // trusted address are walked past, so the padding is never reached.
    const ip = await ipReportedBy(['127.0.0.1'], {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12, 203.0.113.9',
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('walks past each proxy in a chain that is on the list', async () => {
    // A CDN in front of our own edge: the edge (127.0.0.1) appended the CDN's
    // address, the CDN appended the client's. Both proxies are trusted, so the
    // client is the first entry that is not.
    const ip = await ipReportedBy(['127.0.0.1', '198.51.100.0/24'], {
      'x-forwarded-for': '1.2.3.4, 203.0.113.9, 198.51.100.7',
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores the header from a caller that is not a trusted proxy', async () => {
    // The property a hop count never had. A caller who reaches the server
    // directly, bypassing the proxy, gets their own socket address however
    // much header they send.
    const ip = await ipReportedBy(['10.0.0.5'], { 'x-forwarded-for': '1.2.3.4' }, '192.0.2.50');
    expect(ip).toBe('192.0.2.50');
  });
});

describe('RSAGENT_TRUSTED_PROXIES parsing', () => {
  it('is empty when unset or blank', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies(' , ')).toEqual([]);
  });

  it('accepts addresses, CIDR ranges and the named ranges', () => {
    expect(parseTrustedProxies('172.30.47.10, 10.0.0.0/8, fd00::/8, ::1, loopback')).toEqual([
      '172.30.47.10',
      '10.0.0.0/8',
      'fd00::/8',
      '::1',
      'loopback',
    ]);
  });

  it('refuses anything else rather than trusting less than intended', () => {
    expect(() => parseTrustedProxies('1')).toThrow(/RSAGENT_TRUSTED_PROXIES/u);
    expect(() => parseTrustedProxies('caddy')).toThrow(/caddy/u);
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/10\.0\.0\.0\/33/u);
  });
});

/**
 * The other half of the same claim.
 *
 * Everything above establishes which address `request.ip` resolves to. None of
 * it means anything unless the rate limiter is counting against that address,
 * which is an assumption about @fastify/rate-limit rather than about our own
 * code — so it is worth holding the plugin to it across a major bump rather
 * than reading a changelog and hoping.
 */
describe('rate limiting keys on the attributed address', () => {
  async function limited(max: number) {
    const app = Fastify({ trustProxy: trustProxyOption(['127.0.0.1']) });
    await app.register(rateLimit, { max, timeWindow: '1 minute' });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();
    return {
      hit: (forwardedFor: string) =>
        app.inject({ method: 'GET', url: '/x', headers: { 'x-forwarded-for': forwardedFor } }),
      close: () => app.close(),
    };
  }

  it('refuses a caller past the limit', async () => {
    const app = await limited(3);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await app.hit('9.9.9.9, 10.0.0.1')).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await app.close();
    }
  });

  it('counts per attributed address, not per connection', async () => {
    // The reason the header walk above matters: exhausting one caller's budget
    // must not spend anyone else's, and a caller must not be able to reset
    // their own by writing a different X-Forwarded-For. Only the entry the
    // trusted proxy appended distinguishes them here.
    const app = await limited(2);
    try {
      await app.hit('9.9.9.9, 10.0.0.1');
      await app.hit('9.9.9.9, 10.0.0.1');
      expect((await app.hit('9.9.9.9, 10.0.0.1')).statusCode).toBe(429);

      // Same forged leftmost entry, different proxy-added address.
      expect((await app.hit('9.9.9.9, 10.0.0.2')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('loadConfig', () => {
  it('refuses to start with the retired hop count rather than silently ignoring it', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ RSAGENT_TRUSTED_PROXY_HOPS: '1' })).toThrow(
      /RSAGENT_TRUSTED_PROXIES/u,
    );
  });

  it('carries the parsed allowlist through', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ RSAGENT_TRUSTED_PROXIES: '172.30.47.10' }).trustedProxies).toEqual([
      '172.30.47.10',
    ]);
  });
});
