import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

/**
 * `request.ip` is not cosmetic. It is what @fastify/rate-limit counts against,
 * and it is the `remoteAddress` written to every audit row and every session —
 * so an address the caller can choose is both a rate-limit bypass and an audit
 * trail that names whoever the attacker felt like naming.
 *
 * Fastify's `trustProxy: true` means "trust the entire X-Forwarded-For chain",
 * and the leftmost entry of that chain is the one the *client* wrote. Nothing in
 * the shipped Compose file put a proxy in front, so this was inert; every route
 * in docs/deployment.md puts one there, which is what these tests are guarding.
 *
 * The behaviour is a function of the Fastify option alone, so this configures a
 * bare instance the way createApp() does rather than standing up the API.
 */

/** The `trustProxy` expression from src/api/app.ts, kept in one place. */
function trustProxyFor(hops: number): boolean | number {
  return hops === 0 ? false : hops;
}

async function ipReportedBy(hops: number, headers: Record<string, string>) {
  const app = Fastify({ trustProxy: trustProxyFor(hops) });
  app.get('/whoami', async (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({ method: 'GET', url: '/whoami', headers });
    return response.json().ip as string;
  } finally {
    await app.close();
  }
}

describe('client IP attribution', () => {
  it('ignores X-Forwarded-For when no proxy is declared', async () => {
    // The default, and the only setting a caller cannot influence at all.
    const ip = await ipReportedBy(0, { 'x-forwarded-for': '1.2.3.4' });
    expect(ip).not.toBe('1.2.3.4');
  });

  it('takes the address the nearest proxy added, not the one the client sent', async () => {
    // What a spoofing attempt looks like on the wire: the caller sends a header,
    // the proxy appends the address it actually saw. Believing the caller's
    // entry is the bug; the proxy's entry is the rightmost one.
    const ip = await ipReportedBy(1, { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(ip).toBe('203.0.113.9');
  });

  it('does not let a longer forged chain push the real address out of reach', async () => {
    // Padding the header with extra hops is the obvious way to attack a counted
    // trust setting: if the count were applied from the left, or if the whole
    // chain were trusted, one of these entries would win.
    const ip = await ipReportedBy(1, {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12, 203.0.113.9',
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('reads one entry further back for each additional declared hop', async () => {
    // Two proxies in series: the last entry is the one our own edge added, and
    // the one before it is what that edge was told by the proxy in front of it.
    const ip = await ipReportedBy(2, { 'x-forwarded-for': '1.2.3.4, 198.51.100.7, 203.0.113.9' });
    expect(ip).toBe('198.51.100.7');
  });

  it('hands the caller control again if more hops are declared than exist', async () => {
    // Pinned because it is the failure mode, not because it is desirable: once
    // the declared count exceeds the real chain, the walk runs off the end and
    // returns the leftmost entry — which is the client's own. Setting the hop
    // count higher than the number of proxies actually in front of the control
    // plane is therefore equivalent to the `trustProxy: true` this replaced.
    //
    // Nothing can distinguish a padded header from a genuine chain, so the only
    // defence is configuring the true number; RSAGENT_TRUSTED_PROXY_HOPS
    // defaults to 0 so that a deployment which never sets it cannot be fooled.
    const ip = await ipReportedBy(4, { 'x-forwarded-for': '1.2.3.4' });
    expect(ip).toBe('1.2.3.4');
  });
});
