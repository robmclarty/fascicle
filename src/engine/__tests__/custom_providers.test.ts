/**
 * Unit tests for EngineConfig.custom_providers (spec S-P1).
 *
 * Mocks `ai` at the boundary but uses the real registry and create_engine so
 * custom-first resolution, built-in shadowing, and unknown-name fallthrough
 * are exercised against the real code paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  build_mock_ai_module,
  enqueue_generate_text,
  make_text_result,
  reset_mock_state,
} from './fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())

import { create_engine } from '../create_engine.js'
import {
  engine_config_error,
  provider_not_configured_error,
} from '../errors.js'
import {
  default_normalize_usage,
  type ProviderCapability,
  type ProviderFactory,
} from '../providers/types.js'
import type {
  GenerateOptions,
  GenerateResult,
  ProviderInit,
  ResolvedModel,
} from '../types.js'

const AI_SDK_CAPS: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
])

type FactoryLog = {
  inits: ProviderInit[]
  subprocess_calls: Array<{ prompt: unknown; resolved: ResolvedModel }>
  disposals: string[]
}

function make_log(): FactoryLog {
  return { inits: [], subprocess_calls: [], disposals: [] }
}

function make_ai_sdk_factory(name: string, log: FactoryLog): ProviderFactory {
  return (init) => {
    log.inits.push(init)
    return {
      kind: 'ai_sdk',
      name,
      build_model: async (model_id: string) => ({ _custom: name, model_id }),
      translate_effort: () => ({ provider_options: {}, effort_ignored: false }),
      normalize_usage: default_normalize_usage,
      supports: (capability) => AI_SDK_CAPS.has(capability),
    }
  }
}

function make_subprocess_factory(name: string, log: FactoryLog): ProviderFactory {
  return (init) => {
    log.inits.push(init)
    return {
      kind: 'subprocess',
      name,
      generate: async <t>(
        opts: GenerateOptions<t>,
        resolved: ResolvedModel,
      ): Promise<GenerateResult<t>> => {
        log.subprocess_calls.push({ prompt: opts.prompt, resolved })
        return {
          content: 'external says hi' as t,
          tool_calls: [],
          steps: [],
          usage: { input_tokens: 11, output_tokens: 7 },
          finish_reason: 'stop',
          model_resolved: { provider: resolved.provider, model_id: resolved.model_id },
        }
      },
      dispose: async () => {
        log.disposals.push(name)
      },
      supports: () => true,
    }
  }
}

beforeEach(() => reset_mock_state())
afterEach(() => reset_mock_state())

const bad_factory: ProviderFactory = () => {
  throw new engine_config_error('acme requires api_key', 'acme')
}

describe('custom_providers', () => {
  it('routes a custom ai_sdk-kind factory through generate', async () => {
    const log = make_log()
    const engine = create_engine({
      providers: { acme: { api_key: 'a-key' } },
      custom_providers: { acme: make_ai_sdk_factory('acme', log) },
    })
    enqueue_generate_text(
      make_text_result('custom hello', { input_tokens: 9, output_tokens: 4 }),
    )
    const result = await engine.generate({ model: 'acme-model-1', prompt: 'hi' })
    expect(result.content).toBe('custom hello')
    expect(result.model_resolved).toEqual({ provider: 'acme', model_id: 'acme-model-1' })
    expect(result.usage).toEqual({ input_tokens: 9, output_tokens: 4 })
    expect(result.finish_reason).toBe('stop')
  })

  it('routes a custom subprocess-kind factory through generate and dispose', async () => {
    const log = make_log()
    const engine = create_engine({
      providers: { acme_ext: { base_url: 'http://localhost:9999' } },
      custom_providers: { acme_ext: make_subprocess_factory('acme_ext', log) },
    })
    const result = await engine.generate({ model: 'ext-1', prompt: 'go' })
    expect(result.content).toBe('external says hi')
    expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 7 })
    expect(result.model_resolved).toEqual({ provider: 'acme_ext', model_id: 'ext-1' })
    expect(log.subprocess_calls).toEqual([
      { prompt: 'go', resolved: { provider: 'acme_ext', model_id: 'ext-1' } },
    ])
    await engine.dispose()
    expect(log.disposals).toEqual(['acme_ext'])
  })

  it('passes the same-named providers entry verbatim to the custom factory', () => {
    const log = make_log()
    const init = { api_key: 'a-key', region: 'moon-1' }
    create_engine({
      providers: { acme: init },
      custom_providers: { acme: make_ai_sdk_factory('acme', log) },
    })
    expect(log.inits).toEqual([init])
    expect(log.inits[0]).toBe(init)
  })

  it('throws engine_config_error when a custom key shadows a configured built-in', () => {
    const log = make_log()
    expect(() =>
      create_engine({
        providers: { anthropic: { api_key: 'k' } },
        custom_providers: { anthropic: make_ai_sdk_factory('anthropic', log) },
      }),
    ).toThrow(engine_config_error)
  })

  it('throws on a built-in shadow even when the name is absent from providers', () => {
    const log = make_log()
    let thrown: unknown
    try {
      create_engine({
        providers: { acme: { api_key: 'a-key' } },
        custom_providers: {
          acme: make_ai_sdk_factory('acme', log),
          openrouter: make_ai_sdk_factory('openrouter', log),
        },
      })
    } catch (err: unknown) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(engine_config_error)
    expect((thrown as engine_config_error).provider).toBe('openrouter')
  })

  it('still throws provider_not_configured_error for unknown names', () => {
    const log = make_log()
    expect(() =>
      create_engine({
        providers: { nobody: { api_key: 'k' } },
        custom_providers: { acme: make_ai_sdk_factory('acme', log) },
      }),
    ).toThrow(provider_not_configured_error)
  })

  it('propagates a custom factory throw at construction, like built-ins', () => {
    expect(() =>
      create_engine({
        providers: { acme: {} },
        custom_providers: { acme: bad_factory },
      }),
    ).toThrow(engine_config_error)
  })
})
