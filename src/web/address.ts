/**
 * The address and host checks of `web_fetch`: which URLs it will fetch, which
 * hosts the app allowed, and which addresses no fetch may reach.
 *
 * The first request and every redirect hop go through the same two calls,
 * `check_url` before anything resolves and `check_addresses` on what the
 * name resolved to.
 */

import { BlockList, isIP } from 'node:net'

import type { AddressPolicy, ResolvedAddress } from './types.js'

type Subnet = readonly [network: string, prefix: number]

/**
 * The IPv4 ranges no fetch reaches. The benchmarking range 198.18.0.0/15 is
 * left out on purpose: a proxy in fake-IP mode answers every public name from
 * it, and blocking it would refuse the whole web on such a machine.
 */
const BLOCKED_V4: ReadonlyArray<Subnet> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

/**
 * The IPv6 ranges no fetch reaches: unspecified, loopback, the local-use
 * NAT64 prefix, Teredo, unique local, link-local, site-local, and multicast.
 */
const BLOCKED_V6: ReadonlyArray<Subnet> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]

/**
 * The IPv6 forms that carry an IPv4 address: a prefix of 16-bit groups, and
 * the index of the first of the two groups that hold the IPv4 address. In
 * order: IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64, and 6to4.
 */
const EMBEDDINGS: ReadonlyArray<{ readonly prefix: ReadonlyArray<number>; readonly at: number }> = [
  { prefix: [0, 0, 0, 0, 0, 0xffff], at: 6 },
  { prefix: [0, 0, 0, 0, 0, 0], at: 6 },
  { prefix: [0, 0, 0, 0, 0xffff, 0], at: 6 },
  { prefix: [0x64, 0xff9b, 0, 0, 0, 0], at: 6 },
  { prefix: [0x2002], at: 1 },
]

/** The longest URL text a message quotes before it is cut. */
const MAX_SHOWN_CHARS = 200

/** Build a block list of one address family from a table of subnets. */
function block_list(subnets: ReadonlyArray<Subnet>, family: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList()
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family)
  return list
}

// Two lists, one per family, so that an IPv6 address is held only to the IPv6
// table here and its embedded IPv4 address is taken out and checked by this
// module, whatever the runtime does with a mapped address on a mixed list.
const blocked_v4 = block_list(BLOCKED_V4, 'ipv4')
const blocked_v6 = block_list(BLOCKED_V6, 'ipv6')

/** The two 16-bit groups a dotted IPv4 address fills at the end of an IPv6 one. */
function dotted_groups(dotted: string): ReadonlyArray<number> {
  const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number)
  return [a * 256 + b, c * 256 + d]
}

/** The 16-bit groups written on one side of the `::` of an IPv6 address. */
function groups_of(side: string): ReadonlyArray<number> {
  if (side === '') return []
  return side
    .split(':')
    .flatMap((part) => (part.includes('.') ? dotted_groups(part) : [Number.parseInt(part, 16)]))
}

/**
 * The eight 16-bit groups of an IPv6 address that `net.isIP` accepted.
 *
 * Working on the numbers is what makes `::ffff:127.0.0.1`, `::FFFF:7F00:1`,
 * and `0:0:0:0:0:ffff:7f00:1` the same address.
 */
function address_groups(address: string): ReadonlyArray<number> {
  const [head = '', tail] = address.split('::')
  const left = groups_of(head)
  if (tail === undefined) return left
  const right = groups_of(tail)
  const gap = Array.from({ length: 8 - left.length - right.length }, () => 0)
  return [...left, ...gap, ...right]
}

/** Every IPv4 address an IPv6 address carries, in dotted form. */
function embedded_v4(groups: ReadonlyArray<number>): ReadonlyArray<string> {
  return EMBEDDINGS.filter(({ prefix }) => prefix.every((group, index) => groups[index] === group)).map(
    ({ at }) => {
      const high = groups[at] ?? 0
      const low = groups[at + 1] ?? 0
      return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`
    },
  )
}

/**
 * Whether an IP address is one `web_fetch` refuses to reach: loopback,
 * private, link-local, carrier-grade NAT, multicast, unspecified, reserved,
 * and their IPv6 forms. An IPv6 address that carries an IPv4 one (mapped,
 * compatible, translated, NAT64, 6to4) is blocked when the IPv4 one is.
 *
 * A string that is not an IP address counts as blocked, and so does an IPv6
 * address with a zone id, which only names an interface of this machine.
 */
export function is_blocked_address(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked_v4.check(address, 'ipv4')
  if (family !== 6 || address.includes('%')) return true
  if (blocked_v6.check(address, 'ipv6')) return true
  return embedded_v4(address_groups(address)).some((dotted) => blocked_v4.check(dotted, 'ipv4'))
}

/** Drop the dots at both ends of a host name and the brackets of an IPv6 one. */
function strip_host(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && text[start] === '.') start += 1
  while (end > start && text[end - 1] === '.') end -= 1
  const bare = text.slice(start, end)
  return bare.startsWith('[') && bare.endsWith(']') ? bare.slice(1, -1) : bare
}

/**
 * The form of a host that two spellings of it share: lower case, no brackets,
 * no leading or trailing dot, and whatever the URL parser makes of it.
 *
 * The parser is what turns `0:0:0:0:0:0:0:1` into `::1`, `2130706433` into
 * `127.0.0.1`, and a Unicode name into its `xn--` form, so a name on
 * `deny_hosts` covers the host however the URL spelled it. A name the parser
 * rejects is kept as written.
 */
function canonical_host(text: string): string {
  const bare = strip_host(text.trim().toLowerCase())
  try {
    return strip_host(new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}`).hostname)
  } catch {
    return bare
  }
}

/**
 * Whether a host is covered by a list of host names, exactly or as a suffix
 * on a dot.
 *
 * An IP address is covered only by itself, because `0.0.1` is not a parent
 * of `127.0.0.1`. An empty name covers nothing.
 */
export function host_matches(host: string, names: ReadonlyArray<string>): boolean {
  const wanted = canonical_host(host)
  const is_name = isIP(wanted) === 0
  return names.some((name) => {
    const covering = canonical_host(name)
    if (covering === '') return false
    return wanted === covering || (is_name && wanted.endsWith(`.${covering}`))
  })
}

/**
 * The IP address a URL names in place of a host name, or undefined when its
 * host is a name that has to be resolved.
 */
export function literal_address(url: URL): ResolvedAddress | undefined {
  const address = strip_host(url.hostname)
  const family = isIP(address)
  return family === 4 || family === 6 ? { address, family } : undefined
}

/** Cut a quoted URL to a length a message can carry. */
function clip(text: string): string {
  return text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}...` : text
}

/** A URL's text for a message, without the username and password it carries. */
function shown(url: URL): string {
  const copy = new URL(url.href)
  copy.username = ''
  copy.password = ''
  return clip(copy.href)
}

/**
 * Parse a URL and check everything about it that needs no resolution: the
 * scheme, the absence of a username and password, and the host lists.
 *
 * `base` is the URL a redirect's `Location` is relative to.
 */
export function check_url(text: string, policy: AddressPolicy, base?: string): URL {
  let url: URL
  try {
    url = new URL(text, base)
  } catch {
    // The text between `//` and the last `@` of the authority is where a
    // password sits, and a message never repeats one.
    const quoted = clip(text).replace(/\/\/[^/?#]*@/, '//')
    throw new Error(`web_fetch can't read "${quoted}" as a URL; pass a full http or https URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `web_fetch only fetches http and https URLs, and ${shown(url)} is ${url.protocol.slice(0, -1)}`,
    )
  }
  const host = url.hostname
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `web_fetch won't fetch a URL that carries a username or a password; remove them from the URL for ${host}`,
    )
  }
  if (host_matches(host, policy.deny_hosts)) {
    throw new Error(`${host} is on deny_hosts, so web_fetch won't fetch ${shown(url)}`)
  }
  if (policy.allow_hosts !== undefined && !host_matches(host, policy.allow_hosts)) {
    throw new Error(
      `${host} is not on allow_hosts (${policy.allow_hosts.join(', ')}), so web_fetch won't fetch ${shown(url)}`,
    )
  }
  return url
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
  const [first] = addresses
  if (first === undefined) throw new Error(`${url.hostname} did not resolve to any address`)
  if (policy.allow_private) return first
  const blocked = addresses.find(({ address }) => is_blocked_address(address))
  if (blocked !== undefined) {
    throw new Error(
      `${url.hostname} resolves to ${blocked.address}, a loopback, private, or link-local address, so web_fetch won't reach it; set allow_private to read a server on your own network`,
    )
  }
  return first
}
