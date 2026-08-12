/**
 * Missing-`ai`-peer child harness.
 *
 * Runs a full `engine.generate` against a custom native-kind provider in a
 * process where the `ai` specifier does not resolve at all (see
 * ts-resolver.mjs). Loading the engine at all is the first assertion: a static
 * edge from generate.ts to the ai_sdk seam would fail module linking here,
 * before any of this runs. Completing the call is the second: the native
 * transport must reach a result without the lazy seam ever being touched.
 *
 * Writes the generated content to stdout and exits 0 on success; on any
 * failure it writes the error to stderr and exits 1.
 */

import { create_engine } from '../../create_engine.js'
import type { ProviderFactory } from '../../providers/types.js'

const native_factory: ProviderFactory = () => ({
  kind: 'native',
  name: 'no_ai',
  invoke_turn: async () => ({
    text: 'native ok',
    tool_calls: [],
    finish_reason: 'stop' as const,
    usage: { input_tokens: 3, output_tokens: 2 },
  }),
  supports: () => true,
})

async function main(): Promise<void> {
  const engine = create_engine({
    providers: { no_ai: { api_key: 'test-key' } },
    custom_providers: { no_ai: native_factory },
  })
  const result = await engine.generate({ model: 'no-ai-model', prompt: 'hi' })
  process.stdout.write(result.content)
}

try {
  await main()
  process.exit(0)
} catch (error: unknown) {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
