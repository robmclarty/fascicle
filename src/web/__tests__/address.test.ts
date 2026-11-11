import { describe, expect, it } from 'vitest'

import {
  check_addresses,
  check_url,
  host_matches,
  is_blocked_address,
  literal_address,
} from '../address.js'
import type { AddressPolicy, ResolvedAddress } from '../types.js'

const open_policy: AddressPolicy = { allow_hosts: undefined, deny_hosts: [], allow_private: false }
const private_policy: AddressPolicy = { ...open_policy, allow_private: true }

const BLOCKED_SUFFIX =
  ", a loopback, private, or link-local address, so web_fetch won't reach it; set allow_private to read a server on your own network"

/** The message of whatever a call throws, or a marker when it returns. */
function message_of(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error && error.constructor === Error ? error.message : 'not a plain Error'
  }
  return 'did not throw'
}

describe('is_blocked_address', () => {
  describe('IPv4 ranges', () => {
    it.each([
      ['0.0.0.0', 'unspecified'],
      ['0.255.255.255', 'end of 0/8'],
      ['10.0.0.0', 'start of 10/8'],
      ['10.0.0.1', 'private'],
      ['10.255.255.255', 'end of 10/8'],
      ['100.64.0.0', 'start of carrier-grade NAT'],
      ['100.127.255.255', 'end of carrier-grade NAT'],
      ['127.0.0.0', 'start of loopback'],
      ['127.0.0.1', 'loopback'],
      ['127.255.255.255', 'end of loopback'],
      ['169.254.0.0', 'start of link-local'],
      ['169.254.169.254', 'cloud metadata'],
      ['169.254.255.255', 'end of link-local'],
      ['172.16.0.0', 'start of 172.16/12'],
      ['172.31.255.255', 'end of 172.16/12'],
      ['192.0.0.0', 'start of 192.0.0.0/24'],
      ['192.0.0.255', 'end of 192.0.0.0/24'],
      ['192.168.0.0', 'start of 192.168/16'],
      ['192.168.255.255', 'end of 192.168/16'],
      ['224.0.0.0', 'start of multicast'],
      ['239.255.255.255', 'end of multicast'],
      ['240.0.0.0', 'start of reserved'],
      ['255.255.255.255', 'broadcast'],
    ])('blocks %s (%s)', (address) => {
      expect(is_blocked_address(address)).toBe(true)
    })

    it.each([
      ['1.0.0.0', 'after 0/8'],
      ['9.255.255.255', 'before 10/8'],
      ['11.0.0.0', 'after 10/8'],
      ['100.63.255.255', 'before carrier-grade NAT'],
      ['100.128.0.0', 'after carrier-grade NAT'],
      ['126.255.255.255', 'before loopback'],
      ['128.0.0.0', 'after loopback'],
      ['169.253.255.255', 'before link-local'],
      ['169.255.0.0', 'after link-local'],
      ['172.15.255.255', 'before 172.16/12'],
      ['172.32.0.0', 'after 172.16/12'],
      ['191.255.255.255', 'before 192.0.0.0/24'],
      ['192.0.1.0', 'after 192.0.0.0/24'],
      ['192.167.255.255', 'before 192.168/16'],
      ['192.169.0.0', 'after 192.168/16'],
      ['223.255.255.255', 'before multicast'],
      ['198.18.0.1', 'the range a fake-IP proxy answers from'],
      ['8.8.8.8', 'public'],
      ['93.184.216.34', 'public'],
    ])('allows %s (%s)', (address) => {
      expect(is_blocked_address(address)).toBe(false)
    })
  })

  describe('IPv6 ranges', () => {
    it.each([
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['0:0:0:0:0:0:0:1', 'loopback written out'],
      ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback with leading zeros'],
      ['fc00::', 'start of unique local'],
      ['fd12:3456:789a::1', 'unique local'],
      ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'end of unique local'],
      ['fe80::', 'start of link-local'],
      ['fe80::1', 'link-local'],
      ['FE80::1', 'link-local in upper case'],
      ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'end of link-local'],
      ['fec0::', 'start of site-local'],
      ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'end of site-local'],
      ['ff00::', 'start of multicast'],
      ['ff02::1', 'multicast'],
      ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'end of multicast'],
      ['2001::', 'start of Teredo'],
      ['2001:0:ffff:ffff:ffff:ffff:ffff:ffff', 'end of Teredo'],
      ['64:ff9b:1::', 'start of local-use NAT64'],
      ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', 'end of local-use NAT64'],
    ])('blocks %s (%s)', (address) => {
      expect(is_blocked_address(address)).toBe(true)
    })

    it.each([
      ['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'before unique local'],
      ['fe00::', 'after unique local'],
      ['fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'before link-local'],
      ['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'before Teredo'],
      ['2001:1::', 'after Teredo'],
      ['64:ff9b:0:ffff:ffff:ffff:ffff:ffff', 'before local-use NAT64'],
      ['64:ff9b:2::', 'after local-use NAT64'],
      ['2606:4700:4700::1111', 'public'],
      ['2001:4860:4860::8888', 'public'],
      ['2001:4860:4860:0:0:0:0:8888', 'public with no ::'],
      ['1:2:3:4:5:6:7::', 'public ending in ::'],
    ])('allows %s (%s)', (address) => {
      expect(is_blocked_address(address)).toBe(false)
    })
  })

  describe('IPv6 forms that carry an IPv4 address', () => {
    it.each([
      ['::ffff:127.0.0.1', 'mapped, dotted'],
      ['::ffff:7f00:1', 'mapped, hex'],
      ['::FFFF:7F00:1', 'mapped, upper case'],
      ['0:0:0:0:0:ffff:7f00:1', 'mapped, written out'],
      ['0000:0000:0000:0000:0000:ffff:127.0.0.1', 'mapped, written out and dotted'],
      ['::ffff:10.0.0.1', 'mapped private'],
      ['::ffff:a9fe:a9fe', 'mapped cloud metadata'],
      ['::ffff:169.254.169.254', 'mapped cloud metadata, dotted'],
      ['::ffff:172.16.0.0', 'mapped start of 172.16/12'],
      ['::ffff:100.64.0.0', 'mapped start of carrier-grade NAT'],
      ['::ffff:0.0.0.0', 'mapped unspecified'],
      ['::127.0.0.1', 'compatible, dotted'],
      ['::7f00:1', 'compatible, hex'],
      ['::10.0.0.1', 'compatible private'],
      ['::ffff:0:127.0.0.1', 'translated, dotted'],
      ['::ffff:0:7f00:1', 'translated, hex'],
      ['64:ff9b::127.0.0.1', 'NAT64, dotted'],
      ['64:ff9b::7f00:1', 'NAT64, hex'],
      ['64:ff9b::a9fe:a9fe', 'NAT64 cloud metadata'],
      ['64:FF9B::C0A8:101', 'NAT64 private, upper case'],
      ['2002:7f00:1::', '6to4 loopback'],
      ['2002:7f00:1::1', '6to4 loopback with a host part'],
      ['2002:a00:1::1', '6to4 private'],
      ['2002:a9fe:a9fe::1', '6to4 cloud metadata'],
      ['2002:c0a8:101:1:2:3:4:5', '6to4 private, written out'],
    ])('blocks %s (%s)', (address) => {
      expect(is_blocked_address(address)).toBe(true)
    })

    it.each([
      ['::ffff:8.8.8.8', 'mapped public, dotted'],
      ['::ffff:808:808', 'mapped public, hex'],
      ['::ffff:172.15.255.255', 'mapped, before 172.16/12'],
      ['::ffff:100.63.255.255', 'mapped, before carrier-grade NAT'],
      ['::ffff:1.0.0.0', 'mapped, after 0/8'],
      ['::8.8.8.8', 'compatible public'],
      ['::ffff:0:8.8.8.8', 'translated public'],
      ['64:ff9b::8.8.8.8', 'NAT64 public, as DNS64 writes it'],
      ['64:ff9b::808:808', 'NAT64 public, hex'],
      ['2002:808:808::1', '6to4 public'],
      ['2002:808:808:0:0:0:7f00:1', '6to4 public whose tail looks like loopback'],
      ['2003:7f00:1::1', 'not 6to4'],
      ['65:ff9b::7f00:1', 'not NAT64, first group'],
      ['64:ff9c::7f00:1', 'not NAT64, second group'],
      ['64:ff9b:0:1::7f00:1', 'not NAT64, a middle group set'],
      ['1::ffff:7f00:1', 'not mapped, first group set'],
      ['0:0:0:1:0:ffff:7f00:1', 'not mapped, a middle group set'],
      ['0:0:0:0:1:0:7f00:1', 'not compatible, fifth group set'],
      ['0:0:0:0:fffe:0:7f00:1', 'not translated'],
      ['2606:4700::7f00:1', 'public whose tail looks like loopback'],
    ])('allows %s (%s)', (address) => {
      expect(is_blocked_address(address)).toBe(false)
    })
  })

  describe('fails closed', () => {
    it.each([
      [''],
      ['example.com'],
      ['localhost'],
      [' 127.0.0.1'],
      ['8.8.8.8 '],
      ['[::1]'],
      ['[2606:4700:4700::1111]'],
      ['127.1'],
      ['2130706433'],
      ['0177.0.0.1'],
      ['0x7f.0.0.1'],
      ['8.8.8.08'],
      ['8.8.8.8.'],
      ['8.8.8.8:80'],
      ['8.8.8.8/32'],
      ['1.2.3.4.5'],
      ['256.1.1.1'],
      ['::ffff:8.8.8.256'],
      ['2606:4700:4700:::1111'],
      ['g::1'],
    ])('blocks %j, which is not an IP address', (address) => {
      expect(is_blocked_address(address)).toBe(true)
    })

    it.each([['fe80::1%eth0'], ['fe80::1%25eth0'], ['::1%lo0'], ['2606:4700:4700::1111%eth0'], ['2606:4700:4700::1111%']])(
      'blocks %s, which carries a zone id',
      (address) => {
        expect(is_blocked_address(address)).toBe(true)
      },
    )
  })
})

describe('host_matches', () => {
  it('matches a host exactly', () => {
    expect(host_matches('example.com', ['example.com'])).toBe(true)
  })

  it('matches a subdomain as a suffix on a dot', () => {
    expect(host_matches('docs.example.com', ['example.com'])).toBe(true)
    expect(host_matches('a.b.example.com', ['example.com'])).toBe(true)
  })

  it('does not match a host that only ends in the same letters', () => {
    expect(host_matches('notexample.com', ['example.com'])).toBe(false)
  })

  it('does not match a parent of the name, or the name as a prefix', () => {
    expect(host_matches('example.com', ['docs.example.com'])).toBe(false)
    expect(host_matches('example.com.evil.test', ['example.com'])).toBe(false)
    expect(host_matches('com', ['example.com'])).toBe(false)
  })

  it('matches any name on the list and none on an empty list', () => {
    expect(host_matches('b.test', ['a.test', 'b.test'])).toBe(true)
    expect(host_matches('c.test', ['a.test', 'b.test'])).toBe(false)
    expect(host_matches('example.com', [])).toBe(false)
  })

  it('ignores case on both sides', () => {
    expect(host_matches('DOCS.Example.COM', ['example.com'])).toBe(true)
    expect(host_matches('docs.example.com', ['EXAMPLE.Com'])).toBe(true)
  })

  it('ignores a trailing dot on either side', () => {
    expect(host_matches('example.com.', ['example.com'])).toBe(true)
    expect(host_matches('docs.example.com.', ['example.com'])).toBe(true)
    expect(host_matches('example.com', ['example.com.'])).toBe(true)
    expect(host_matches('docs.example.com..', ['example.com..'])).toBe(true)
  })

  it('ignores a leading dot and outer spaces on a name', () => {
    expect(host_matches('example.com', ['.example.com'])).toBe(true)
    expect(host_matches('docs.example.com', ['.example.com'])).toBe(true)
    expect(host_matches('notexample.com', ['.example.com'])).toBe(false)
    expect(host_matches('example.com', [' example.com '])).toBe(true)
  })

  it('lets an empty name cover nothing', () => {
    expect(host_matches('example.com', [''])).toBe(false)
    expect(host_matches('example.com', ['.'])).toBe(false)
    expect(host_matches('example.com.', ['', '.', '..'])).toBe(false)
    expect(host_matches('', [''])).toBe(false)
    expect(host_matches('.', ['.'])).toBe(false)
  })

  it('compares an IPv6 host without its brackets, in any spelling', () => {
    expect(host_matches('[::1]', ['::1'])).toBe(true)
    expect(host_matches('::1', ['[::1]'])).toBe(true)
    expect(host_matches('[::1]', ['0:0:0:0:0:0:0:1'])).toBe(true)
    expect(host_matches('[2606:4700:4700::1111]', ['2606:4700:4700:0:0:0:0:1111'])).toBe(true)
    expect(host_matches('[::ffff:7f00:1]', ['::FFFF:127.0.0.1'])).toBe(true)
    expect(host_matches('[::2]', ['::1'])).toBe(false)
  })

  it('reads a name the way the URL parser reads a host', () => {
    expect(host_matches('127.0.0.1', ['2130706433'])).toBe(true)
    expect(host_matches('127.0.0.1', ['0x7f.1'])).toBe(true)
    expect(host_matches('xn--bcher-kva.de', ['bücher.de'])).toBe(true)
    expect(host_matches('www.xn--bcher-kva.de', ['BÜCHER.de'])).toBe(true)
  })

  it('keeps a name the URL parser rejects as it was written', () => {
    expect(host_matches('exa mple', ['EXA MPLE'])).toBe(true)
    expect(host_matches('example.com', ['exa mple.com'])).toBe(false)
  })

  it('covers an IP address only by itself', () => {
    expect(host_matches('127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(host_matches('127.0.0.1', ['0.0.1'])).toBe(false)
    expect(host_matches('127.0.0.1', ['0.1'])).toBe(false)
    expect(host_matches('10.0.0.1', ['0.0.0.1'])).toBe(false)
    expect(host_matches('127.0.0.1.example.com', ['example.com'])).toBe(true)
  })
})

describe('what the URL parser does to a host before any check sees it', () => {
  it.each([
    ['http://2130706433/', '127.0.0.1'],
    ['http://017700000001/', '127.0.0.1'],
    ['http://0x7f000001/', '127.0.0.1'],
    ['http://0177.0.0.1/', '127.0.0.1'],
    ['http://0x7f.0.0.1/', '127.0.0.1'],
    ['http://127.0.0.0x1/', '127.0.0.1'],
    ['http://127.1/', '127.0.0.1'],
    ['http://127.0.0.1./', '127.0.0.1'],
    ['http://0/', '0.0.0.0'],
    ['http://１２７.0.0.1/', '127.0.0.1'],
    ['http://①②⑦.0.0.1/', '127.0.0.1'],
    ['http://2852039166/', '169.254.169.254'],
    ['http://0xa9fea9fe/', '169.254.169.254'],
    ['http://[::1]/', '::1'],
    ['http://[0:0:0:0:0:0:0:1]/', '::1'],
    ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['http://[::FFFF:7F00:1]/', '::ffff:7f00:1'],
    ['http://[::127.0.0.1]/', '::7f00:1'],
    ['http://[64:ff9b::127.0.0.1]/', '64:ff9b::7f00:1'],
    ['http://[2002:7F00:1::]/', '2002:7f00:1::'],
    ['http://[FE80::1]/', 'fe80::1'],
  ])('%s names the blocked address %s', (text, address) => {
    const url = check_url(text, open_policy)
    const literal = literal_address(url)
    expect(literal).toEqual({ address, family: address.includes(':') ? 6 : 4 })
    expect(is_blocked_address(address)).toBe(true)
    expect(message_of(() => check_addresses(url, literal === undefined ? [] : [literal], open_policy))).toBe(
      `${url.hostname} resolves to ${address}${BLOCKED_SUFFIX}`,
    )
  })

  it.each([['http://[fe80::1%25eth0]/'], ['http://[fe80::1%eth0]/'], ['http://1.2.3.4.5/'], ['http://256.1.1.1/']])(
    'refuses %s as unreadable',
    (text) => {
      expect(message_of(() => check_url(text, open_policy))).toBe(
        `web_fetch can't read "${text}" as a URL; pass a full http or https URL`,
      )
    },
  )
})

describe('literal_address', () => {
  it('returns an IPv4 literal with family 4', () => {
    expect(literal_address(new URL('http://93.184.216.34:8080/x'))).toEqual({
      address: '93.184.216.34',
      family: 4,
    })
  })

  it('returns an IPv6 literal with family 6 and no brackets', () => {
    expect(literal_address(new URL('https://[2606:4700:4700::1111]:8443/x'))).toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    })
  })

  it('returns undefined for a host name', () => {
    expect(literal_address(new URL('http://example.com/'))).toBeUndefined()
    expect(literal_address(new URL('http://localhost/'))).toBeUndefined()
    expect(literal_address(new URL('http://127.0.0.1.example.com/'))).toBeUndefined()
    expect(literal_address(new URL('http://example.com./'))).toBeUndefined()
  })
})

describe('check_url', () => {
  it('returns the parsed URL of an http or https address', () => {
    const url = check_url('https://Example.com:8443/a?b=1#c', open_policy)
    expect(url).toBeInstanceOf(URL)
    expect(url.href).toBe('https://example.com:8443/a?b=1#c')
    expect(check_url('http://example.com', open_policy).href).toBe('http://example.com/')
    expect(check_url('HTTP://example.com/', open_policy).protocol).toBe('http:')
  })

  it('resolves a redirect location against the base', () => {
    expect(check_url('/next?x=1', open_policy, 'https://example.com/a/b').href).toBe(
      'https://example.com/next?x=1',
    )
    expect(check_url('//other.test/x', open_policy, 'https://example.com/a').href).toBe('https://other.test/x')
    expect(check_url('http://other.test/', open_policy, 'https://example.com/a').href).toBe('http://other.test/')
  })

  it('does no address check, whatever allow_private says', () => {
    expect(check_url('http://127.0.0.1/', open_policy).hostname).toBe('127.0.0.1')
    expect(check_url('http://localhost/', open_policy).hostname).toBe('localhost')
    expect(check_url('http://[::1]/', private_policy).hostname).toBe('[::1]')
  })

  it.each([[''], ['not a url'], ['/relative/path'], ['example.com/page'], ['http://'], ['http://exa mple.com/']])(
    'refuses %j as unreadable',
    (text) => {
      expect(message_of(() => check_url(text, open_policy))).toBe(
        `web_fetch can't read "${text}" as a URL; pass a full http or https URL`,
      )
    },
  )

  it('refuses a location that is unreadable against its base', () => {
    expect(message_of(() => check_url('http://exa mple.com/', open_policy, 'https://example.com/'))).toBe(
      'web_fetch can\'t read "http://exa mple.com/" as a URL; pass a full http or https URL',
    )
  })

  it('does not repeat a password from text it cannot read', () => {
    expect(message_of(() => check_url('http://user:hunter2@exa mple.com/p@th', open_policy))).toBe(
      'web_fetch can\'t read "http://exa mple.com/p@th" as a URL; pass a full http or https URL',
    )
    expect(message_of(() => check_url('http://user:p@ss@/', open_policy))).toBe(
      'web_fetch can\'t read "http:///" as a URL; pass a full http or https URL',
    )
  })

  it('cuts unreadable text at 200 characters', () => {
    const exact = 'x'.repeat(200)
    expect(message_of(() => check_url(exact, open_policy))).toBe(
      `web_fetch can't read "${exact}" as a URL; pass a full http or https URL`,
    )
    expect(message_of(() => check_url(`${exact}y`, open_policy))).toBe(
      `web_fetch can't read "${exact}..." as a URL; pass a full http or https URL`,
    )
  })

  it.each([
    ['file:///etc/passwd', 'file:///etc/passwd', 'file'],
    ['ftp://example.com/a', 'ftp://example.com/a', 'ftp'],
    ['FTP://example.com/a', 'ftp://example.com/a', 'ftp'],
    ['gopher://example.com/', 'gopher://example.com/', 'gopher'],
    ['javascript:alert(1)', 'javascript:alert(1)', 'javascript'],
    ['data:text/plain,hi', 'data:text/plain,hi', 'data'],
    ['ws://example.com/', 'ws://example.com/', 'ws'],
    ['httpx://example.com/', 'httpx://example.com/', 'httpx'],
    ['localhost:8080/x', 'localhost:8080/x', 'localhost'],
  ])('refuses %s by its scheme', (text, href, scheme) => {
    expect(message_of(() => check_url(text, open_policy))).toBe(
      `web_fetch only fetches http and https URLs, and ${href} is ${scheme}`,
    )
  })

  it('refuses a redirect to another scheme', () => {
    expect(message_of(() => check_url('file:///etc/passwd', open_policy, 'https://example.com/'))).toBe(
      'web_fetch only fetches http and https URLs, and file:///etc/passwd is file',
    )
  })

  it('names the scheme before the password, and leaves the password out', () => {
    expect(message_of(() => check_url('ftp://user:hunter2@example.com/a', open_policy))).toBe(
      'web_fetch only fetches http and https URLs, and ftp://example.com/a is ftp',
    )
  })

  it('cuts a long URL of another scheme at 200 characters', () => {
    const text = `data:text/plain,${'x'.repeat(300)}`
    expect(message_of(() => check_url(text, open_policy))).toBe(
      `web_fetch only fetches http and https URLs, and ${text.slice(0, 200)}... is data`,
    )
  })

  it.each([
    ['http://user:hunter2@example.com/'],
    ['http://user@example.com/'],
    ['http://:hunter2@example.com/'],
    ['https://user:hunter2@Example.com:8443/a'],
    ['http://example.org%2F@example.com/'],
  ])('refuses %s for its username or password', (text) => {
    const message = message_of(() => check_url(text, open_policy))
    expect(message).toBe(
      "web_fetch won't fetch a URL that carries a username or a password; remove them from the URL for example.com",
    )
    expect(message).not.toContain('hunter2')
  })

  it('refuses a username or password with allow_private set and the host allowed', () => {
    const policy: AddressPolicy = { allow_hosts: ['example.com'], deny_hosts: [], allow_private: true }
    expect(message_of(() => check_url('http://user:hunter2@example.com/', policy))).toBe(
      "web_fetch won't fetch a URL that carries a username or a password; remove them from the URL for example.com",
    )
  })

  it('refuses a username or password before it reads the host lists', () => {
    const policy: AddressPolicy = { allow_hosts: [], deny_hosts: ['example.com'], allow_private: false }
    expect(message_of(() => check_url('http://user@example.com/', policy))).toBe(
      "web_fetch won't fetch a URL that carries a username or a password; remove them from the URL for example.com",
    )
  })

  it('refuses a redirect that adds a username', () => {
    expect(message_of(() => check_url('//user@other.test/', open_policy, 'https://example.com/'))).toBe(
      "web_fetch won't fetch a URL that carries a username or a password; remove them from the URL for other.test",
    )
  })

  it('accepts an empty username and password', () => {
    expect(check_url('http://@example.com/', open_policy).href).toBe('http://example.com/')
    expect(check_url('http://:@example.com/', open_policy).href).toBe('http://example.com/')
  })

  it('refuses a host on deny_hosts, and its subdomains', () => {
    const policy: AddressPolicy = { ...open_policy, deny_hosts: ['internal.test'] }
    expect(message_of(() => check_url('http://internal.test/a?b=1', policy))).toBe(
      "internal.test is on deny_hosts, so web_fetch won't fetch http://internal.test/a?b=1",
    )
    expect(message_of(() => check_url('https://API.Internal.Test./x', policy))).toBe(
      "api.internal.test. is on deny_hosts, so web_fetch won't fetch https://api.internal.test./x",
    )
    expect(check_url('http://notinternal.test/', policy).hostname).toBe('notinternal.test')
  })

  it('refuses a denied IP host however the URL spells it', () => {
    const policy: AddressPolicy = { ...private_policy, deny_hosts: ['127.0.0.1', '::1'] }
    expect(message_of(() => check_url('http://2130706433:8080/', policy))).toBe(
      "127.0.0.1 is on deny_hosts, so web_fetch won't fetch http://127.0.0.1:8080/",
    )
    expect(message_of(() => check_url('http://[0:0:0:0:0:0:0:1]/', policy))).toBe(
      "[::1] is on deny_hosts, so web_fetch won't fetch http://[::1]/",
    )
  })

  it('lets deny_hosts win over allow_hosts', () => {
    const policy: AddressPolicy = {
      allow_hosts: ['example.com'],
      deny_hosts: ['private.example.com'],
      allow_private: true,
    }
    expect(message_of(() => check_url('https://private.example.com/', policy))).toBe(
      "private.example.com is on deny_hosts, so web_fetch won't fetch https://private.example.com/",
    )
    expect(check_url('https://docs.example.com/', policy).hostname).toBe('docs.example.com')
  })

  it('refuses a host that allow_hosts does not cover', () => {
    const policy: AddressPolicy = { ...open_policy, allow_hosts: ['example.com', 'docs.test'] }
    expect(message_of(() => check_url('https://other.test/a', policy))).toBe(
      "other.test is not on allow_hosts (example.com, docs.test), so web_fetch won't fetch https://other.test/a",
    )
    expect(message_of(() => check_url('https://example.com.evil.test/', policy))).toBe(
      "example.com.evil.test is not on allow_hosts (example.com, docs.test), so web_fetch won't fetch https://example.com.evil.test/",
    )
    expect(check_url('https://example.com/', policy).hostname).toBe('example.com')
    expect(check_url('https://www.docs.test/', policy).hostname).toBe('www.docs.test')
  })

  it('refuses every host on an empty allow_hosts', () => {
    const policy: AddressPolicy = { ...private_policy, allow_hosts: [] }
    expect(message_of(() => check_url('https://example.com/', policy))).toBe(
      "example.com is not on allow_hosts (), so web_fetch won't fetch https://example.com/",
    )
  })

  it('holds a redirect to the host lists', () => {
    const policy: AddressPolicy = { ...open_policy, allow_hosts: ['example.com'] }
    expect(message_of(() => check_url('https://other.test/x', policy, 'https://example.com/a'))).toBe(
      "other.test is not on allow_hosts (example.com), so web_fetch won't fetch https://other.test/x",
    )
    expect(check_url('/x', policy, 'https://example.com/a').href).toBe('https://example.com/x')
  })

  it('cuts a long URL in a host-list message at 200 characters', () => {
    const text = `https://example.com/${'x'.repeat(300)}`
    const shown = `${text.slice(0, 200)}...`
    expect(message_of(() => check_url(text, { ...open_policy, deny_hosts: ['example.com'] }))).toBe(
      `example.com is on deny_hosts, so web_fetch won't fetch ${shown}`,
    )
    expect(message_of(() => check_url(text, { ...open_policy, allow_hosts: ['a.test'] }))).toBe(
      `example.com is not on allow_hosts (a.test), so web_fetch won't fetch ${shown}`,
    )
  })
})

describe('check_addresses', () => {
  const url = new URL('https://example.com/a')
  const public_v4: ResolvedAddress = { address: '93.184.216.34', family: 4 }
  const public_v6: ResolvedAddress = { address: '2606:4700:4700::1111', family: 6 }

  it('returns the first address when every one is public', () => {
    expect(check_addresses(url, [public_v4, public_v6], open_policy)).toBe(public_v4)
    expect(check_addresses(url, [public_v6, public_v4], open_policy)).toBe(public_v6)
    expect(check_addresses(url, [public_v6], open_policy)).toBe(public_v6)
  })

  it('refuses a host with no address, whatever allow_private says', () => {
    expect(message_of(() => check_addresses(url, [], open_policy))).toBe(
      'example.com did not resolve to any address',
    )
    expect(message_of(() => check_addresses(url, [], private_policy))).toBe(
      'example.com did not resolve to any address',
    )
  })

  it.each([
    ['127.0.0.1', 4],
    ['10.0.0.1', 4],
    ['169.254.169.254', 4],
    ['100.64.0.0', 4],
    ['172.16.0.0', 4],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['::ffff:7f00:1', 6],
    ['fe80::1%eth0', 6],
    ['not an address', 4],
  ] as const)('refuses a host that resolves to %s', (address, family) => {
    expect(message_of(() => check_addresses(url, [{ address, family }], open_policy))).toBe(
      `example.com resolves to ${address}${BLOCKED_SUFFIX}`,
    )
  })

  it('refuses a public address beside a private one, in either order', () => {
    const private_v4: ResolvedAddress = { address: '10.0.0.1', family: 4 }
    expect(message_of(() => check_addresses(url, [public_v4, private_v4], open_policy))).toBe(
      `example.com resolves to 10.0.0.1${BLOCKED_SUFFIX}`,
    )
    expect(message_of(() => check_addresses(url, [private_v4, public_v4], open_policy))).toBe(
      `example.com resolves to 10.0.0.1${BLOCKED_SUFFIX}`,
    )
    expect(message_of(() => check_addresses(url, [public_v4, public_v6, { address: '::1', family: 6 }], open_policy))).toBe(
      `example.com resolves to ::1${BLOCKED_SUFFIX}`,
    )
  })

  it('names the first blocked address when several are blocked', () => {
    const addresses: ReadonlyArray<ResolvedAddress> = [
      public_v4,
      { address: '192.168.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]
    expect(message_of(() => check_addresses(url, addresses, open_policy))).toBe(
      `example.com resolves to 192.168.1.1${BLOCKED_SUFFIX}`,
    )
  })

  it('names an IPv6 literal host with its brackets', () => {
    expect(message_of(() => check_addresses(new URL('http://[::1]:8080/'), [{ address: '::1', family: 6 }], open_policy))).toBe(
      `[::1] resolves to ::1${BLOCKED_SUFFIX}`,
    )
  })

  it('returns the first address unchecked with allow_private set', () => {
    const loopback: ResolvedAddress = { address: '127.0.0.1', family: 4 }
    expect(check_addresses(url, [loopback, public_v4], private_policy)).toBe(loopback)
    expect(check_addresses(url, [public_v4, loopback], private_policy)).toBe(public_v4)
  })
})
