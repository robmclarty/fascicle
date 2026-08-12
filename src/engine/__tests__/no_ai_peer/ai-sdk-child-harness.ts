/**
 * Missing-`ai`-peer child harness, `ai_sdk` transport variant.
 *
 * Runs a full `engine.generate` against a custom `kind: 'ai_sdk'` provider in
 * a process where the `ai` specifier does not resolve at all (see
 * ts-resolver.mjs). Unlike child-harness.ts (which proves the native
 * transport never touches the seam), this drives the ai_sdk branch on
 * purpose: generate.ts reaches providers/ai_sdk/invoke.ts through
 * load_optional_peer, and that module's own static `from 'ai'` import fails
 * to resolve, which must surface as the standard missing-peer message naming
 * `ai`, not a raw module-resolution error naming the local invoke.ts path.
 *
 * Writes the rejection's error message to stdout and exits 0 when generate
 * rejects as expected; writes a diagnostic to stderr and exits 1 otherwise
 * (including if generate unexpectedly resolves).
 */

import { create_engine } from '../../create_engine.js'
import { default_normalize_usage, type ProviderFactory } from '../../providers/types.js'

const ai_sdk_factory: ProviderFactory = () => ({
  kind: 'ai_sdk',
  name: 'no_ai',
  build_model: async (model_id: string) => ({ model_id }),
  translate_effort: () => ({ provider_options: {}, effort_ignored: false }),
  normalize_usage: default_normalize_usage,
  supports: () => true,
})

async function main(): Promise<string> {
  const engine = create_engine({
    providers: { no_ai: { api_key: 'test-key' } },
    custom_providers: { no_ai: ai_sdk_factory },
  })
  try {
    await engine.generate({ model: 'no-ai-model', prompt: 'hi' })
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected engine.generate to reject with a missing-peer error')
}

try {
  const message = await main()
  process.stdout.write(message)
  process.exit(0)
} catch (error: unknown) {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
