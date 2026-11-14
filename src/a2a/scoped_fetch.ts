/**
 * The fetch that `a2a_step` hands the A2A client, which adds the config's
 * headers only to requests bound for the origin of the configured URL.
 */

type Headers_source =
  | Readonly<Record<string, string>>
  | (() => Promise<Readonly<Record<string, string>>>)
  | undefined

/**
 * Wrap `inner` so the headers go with a request only when it is bound for the
 * origin of `base_url`.
 *
 * The headers are usually credentials, and the agent's card chooses the URL
 * that messages are sent to. A card that names another origin would otherwise
 * be handed the caller's token, so a request to any other origin goes out
 * without them, and the headers function isn't run for it.
 */
export function scoped_fetch(base_url: string, source: Headers_source, inner: typeof fetch = fetch): typeof fetch {
  const home = new URL(base_url).origin
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (source === undefined || new URL(target, base_url).origin !== home) return inner(input, init)
    const extra = typeof source === 'function' ? await source() : source
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(extra)) headers.set(name, value)
    return inner(input, { ...init, headers })
  }
}
