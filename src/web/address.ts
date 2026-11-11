/**
 * The address and host checks of `web_fetch`: which URLs it will fetch, which
 * hosts the app allowed, and which addresses no fetch may reach.
 *
 * The first request and every redirect hop go through the same two calls,
 * `check_url` before anything resolves and `check_addresses` on what the
 * name resolved to.
 */

import type { AddressPolicy, ResolvedAddress } from './types.js'

/**
 * Whether an IP address is one `web_fetch` refuses to reach: loopback,
 * private, link-local, carrier-grade NAT, multicast, unspecified, and their
 * IPv6 forms, IPv4-mapped ones included.
 *
 * A string that is not an IP address counts as blocked.
 */
export function is_blocked_address(address: string): boolean {
  throw new Error(`not implemented: is_blocked_address(${address})`)
}

/**
 * Whether a host is covered by a list of host names, exactly or as a suffix
 * on a dot.
 */
export function host_matches(host: string, names: ReadonlyArray<string>): boolean {
  throw new Error(`not implemented: host_matches(${host}, ${String(names.length)})`)
}

/**
 * The IP address a URL names in place of a host name, or undefined when its
 * host is a name that has to be resolved.
 */
export function literal_address(url: URL): ResolvedAddress | undefined {
  throw new Error(`not implemented: literal_address(${url.href})`)
}

/**
 * Parse a URL and check everything about it that needs no resolution: the
 * scheme, the absence of a username and password, and the host lists.
 *
 * `base` is the URL a redirect's `Location` is relative to.
 */
export function check_url(text: string, policy: AddressPolicy, base?: string): URL {
  throw new Error(`not implemented: check_url(${text}, ${String(policy.allow_private)}, ${String(base)})`)
}

/**
 * Check every address a URL's host resolved to, and return the one to
 * connect to.
 *
 * One blocked address refuses the whole set, so a name with a public and a
 * private address is refused.
 */
export function check_addresses(
  url: URL,
  addresses: ReadonlyArray<ResolvedAddress>,
  policy: AddressPolicy,
): ResolvedAddress {
  throw new Error(`not implemented: check_addresses(${url.href}, ${String(addresses.length)}, ${String(policy.allow_private)})`)
}
