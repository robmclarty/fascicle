/**
 * Wrap a canned `generate` function in a complete `Engine`.
 *
 * The remaining members are inert: pricing calls are no-ops that resolve
 * nothing, `dispose` resolves immediately, and `with_providers` throws
 * because a canned engine has no provider registry to derive from. Both
 * testing factories share this shell so a test double differs from a real
 * engine only in how `generate` answers.
 */

import type { Engine } from '#engine'

/**
 * Build an `Engine` whose only live member is the supplied `generate`.
 */
export function engine_from_generate(generate: Engine['generate']): Engine {
  return {
    generate,
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    with_providers: () => {
      throw new Error('testing engines do not support with_providers')
    },
    dispose: async () => {},
  }
}
