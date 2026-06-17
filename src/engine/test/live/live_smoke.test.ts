/**
 * Opt-in live-provider smoke tests.
 *
 * These hit real provider APIs and are skipped unless LIVE_TESTS=1 and the
 * relevant key is set, so the default `pnpm check` run never makes a network
 * call. They exist because the mocked suite cannot see a wrong wire format: a
 * snake_case thinking budget or a string thinkingBudget passes every mock yet
 * silently no-ops (anthropic) or throws (google) against the pinned SDKs. A
 * single live generate at a non-none effort is enough to catch both. Run with:
 *
 *   LIVE_TESTS=1 ANTHROPIC_API_KEY=... pnpm exec vitest run packages/engine/test/live
 *
 * See CONTRIBUTING.md for the full set of env vars.
 */

import { describe, expect, it } from 'vitest'
import { create_engine } from '../../create_engine.js'

const live = process.env['LIVE_TESTS'] === '1'

type LiveCase = {
  readonly provider: 'anthropic' | 'google' | 'openai'
  readonly env: string
  readonly model: string
}

const CASES: ReadonlyArray<LiveCase> = [
  { provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'anthropic:claude-haiku-4-5' },
  { provider: 'google', env: 'GOOGLE_GENERATIVE_AI_API_KEY', model: 'google:gemini-2.5-flash' },
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'openai:gpt-4o-mini' },
]

const TIMEOUT_MS = 30_000

for (const c of CASES) {
  const enabled = live && (process.env[c.env]?.length ?? 0) > 0

  describe.skipIf(!enabled)(`live: ${c.provider}`, () => {
    function make_engine() {
      const api_key = process.env[c.env] ?? ''
      return create_engine({ providers: { [c.provider]: { api_key } } })
    }

    it(
      'completes a tiny generate at effort low without throwing',
      async () => {
        const result = await make_engine().generate({
          model: c.model,
          prompt: 'What is 17 * 23? Answer with only the number.',
          effort: 'low',
          max_tokens: 256,
        })
        expect(typeof result.content).toBe('string')
        expect(result.content.length).toBeGreaterThan(0)
        const reasoning = result.usage.reasoning_tokens
        if (reasoning !== undefined) expect(reasoning).toBeGreaterThanOrEqual(0)
      },
      TIMEOUT_MS,
    )

    it(
      'accepts a provider_options passthrough without throwing',
      async () => {
        const result = await make_engine().generate({
          model: c.model,
          prompt: 'Reply with the single word: ok',
          effort: 'none',
          max_tokens: 64,
          provider_options: { [c.provider]: {} },
        })
        expect(typeof result.content).toBe('string')
      },
      TIMEOUT_MS,
    )
  })
}
