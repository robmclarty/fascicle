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
 *
 * A custom double MUST implement only `generate`: accept `GenerateOptions`
 * and resolve a complete `GenerateResult` (content, tool_calls, steps,
 * usage, finish_reason, model_resolved). Honoring `opts.abort`,
 * `opts.on_chunk`, and `opts.schema` is optional; honor whichever the code
 * under test exercises. It need NOT implement pricing, `with_providers`, or
 * `dispose`: this shell supplies the inert versions.
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
