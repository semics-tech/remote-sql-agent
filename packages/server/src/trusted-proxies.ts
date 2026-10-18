import { isIP } from 'node:net';

/**
 * Which reverse proxies may tell us the client's address.
 *
 * `request.ip` is what @fastify/rate-limit counts against and what lands in
 * `remoteAddress` on every audit row and every session, so an address the
 * caller can choose is both a rate-limit bypass and a forged audit trail.
 *
 * X-Forwarded-For is walked from the right. An entry is believed only while the
 * address it came from is on this list; the first address that is not on it is
 * the client. A caller who reaches the server directly is not on the list, so
 * nothing they write in the header is read at all.
 *
 * This replaced a hop count (RSAGENT_TRUSTED_PROXY_HOPS). A count cannot tell a
 * request that came through the proxy from one that did not, and Fastify
 * 5.12.2 stopped honouring numeric `trustProxy` for exactly that reason.
 */

/** proxy-addr's named ranges. `uniquelocal` is all of RFC 1918 and fc00::/7. */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isValidEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/u.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parse RSAGENT_TRUSTED_PROXIES: a comma-separated list of addresses, CIDR
 * ranges, or `loopback` / `linklocal` / `uniquelocal`. Empty means trust no
 * proxy, which is correct when the control plane is published directly.
 */
export function parseTrustedProxies(raw: string | undefined): string[] {
  if (!raw) return [];
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid = entries.filter((e) => !isValidEntry(e));
  if (invalid.length > 0) {
    throw new Error(
      `RSAGENT_TRUSTED_PROXIES has entries that are not an IP address, a CIDR range, or loopback/linklocal/uniquelocal: ${invalid.join(', ')}`,
    );
  }
  return entries;
}

/** The value handed to Fastify's `trustProxy`. */
export function trustProxyOption(trustedProxies: readonly string[]): false | string[] {
  return trustedProxies.length === 0 ? false : [...trustedProxies];
}
