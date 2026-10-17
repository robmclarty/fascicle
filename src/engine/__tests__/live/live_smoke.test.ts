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
 *   LIVE_TESTS=1 ANTHROPIC_API_KEY=... pnpm exec vitest run src/engine/__tests__/live
 *
 * The two Claude 5.5 cases need only OPENROUTER_API_KEY. They reach a current
 * Claude model on both Anthropic transports through OpenRouter's
 * Anthropic-compatible Messages endpoint, which takes the `x-api-key` header
 * both transports send, so the effort shape current models take runs without
 * an Anthropic key. See CONTRIBUTING.md for the full set of env vars.
 */

import { describe, expect, it } from 'vitest'
import { create_engine } from '../../create_engine.js'

const live = process.env['LIVE_TESTS'] === '1'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

type LiveCase = {
  readonly id: string
  readonly provider: 'anthropic' | 'google' | 'openai'
  readonly env: string
  readonly model: string
  readonly transport?: 'native' | 'ai_sdk'
  readonly base_url?: string
}

const CASES: ReadonlyArray<LiveCase> = [
  // Claude 4.5 takes a thinking budget, which the SDK still sends for it.
  // Native sends adaptive thinking, so 4.5 there needs a passthrough budget.
  { id: 'anthropic', provider: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5', transport: 'ai_sdk' },
  { id: 'google', provider: 'google', env: 'GOOGLE_GENERATIVE_AI_API_KEY', model: 'gemini-2.5-flash' },
  { id: 'openai', provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  {
    id: 'anthropic native via openrouter',
    provider: 'anthropic',
    env: 'OPENROUTER_API_KEY',
    model: 'anthropic/claude-sonnet-5.5',
    transport: 'native',
    base_url: OPENROUTER_BASE_URL,
  },
  {
    id: 'anthropic ai_sdk via openrouter',
    provider: 'anthropic',
    env: 'OPENROUTER_API_KEY',
    model: 'anthropic/claude-sonnet-5.5',
    transport: 'ai_sdk',
    base_url: OPENROUTER_BASE_URL,
  },
]

const TIMEOUT_MS = 30_000

for (const c of CASES) {
  const enabled = live && (process.env[c.env]?.length ?? 0) > 0

  describe.skipIf(!enabled)(`live: ${c.id}, ${c.model}`, () => {
    function make_engine() {
      const api_key = process.env[c.env] ?? ''
      return create_engine({
        providers: {
          [c.provider]: {
            api_key,
            ...(c.transport === undefined ? {} : { transport: c.transport }),
            ...(c.base_url === undefined ? {} : { base_url: c.base_url }),
          },
        },
      })
    }

    it(
      'completes a tiny generate at effort low without throwing',
      async () => {
        const result = await make_engine().generate({
          provider: c.provider,
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
          provider: c.provider,
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
