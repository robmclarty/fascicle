/**
 * Unit tests for engine.with_providers (D8, spec §5.8).
 *
 * Derivation is the value-semantic answer to runtime registration: a new engine
 * from merged config, the parent left untouched. Mocks `ai` at the boundary but
 * uses the real registry and create_engine so custom-first resolution, built-in
 * shadowing, fresh adapter construction, and independent disposal are exercised
 * against the real code paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { build_mock_ai_module, reset_mock_state } from './fixtures/mock_ai.js'

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
import type { ProviderInit, TurnRequest, TurnResult } from '../types.js'

const AI_SDK_CAPS: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
])

type FactoryLog = {
  inits: ProviderInit[]
  disposals: string[]
}

function make_log(): FactoryLog {
  return { inits: [], disposals: [] }
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

function make_native_factory(
  name: string,
  log: FactoryLog,
  turns: ReadonlyArray<(req: TurnRequest) => TurnResult>,
): ProviderFactory {
  return (init) => {
    log.inits.push(init)
    return {
      kind: 'native',
      name,
      invoke_turn: async (req) => {
        const turn = turns[req.step_index]
        if (turn === undefined) throw new Error(`no scripted turn for step ${req.step_index}`)
        return turn(req)
      },
      supports: () => true,
      dispose: async () => {
        log.disposals.push(name)
      },
    }
  }
}

function one_shot(text: string): (req: TurnRequest) => TurnResult {
  return () => ({
    text,
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

beforeEach(() => reset_mock_state())
afterEach(() => reset_mock_state())

describe('with_providers', () => {
  it('routes an added native provider through the derived engine', async () => {
    const log = make_log()
    const parent = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    const child = parent.with_providers(
      { acme_native: {} },
      { acme_native: make_native_factory('acme_native', log, [one_shot('child hello')]) },
    )
    const result = await child.generate({
      model: 'nat-1',
      provider: 'acme_native',
      prompt: 'hi',
    })
    expect(result.content).toBe('child hello')
    expect(result.model_resolved).toEqual({ provider: 'acme_native', model_id: 'nat-1' })
  })

  it('leaves the original engine untouched', async () => {
    const log = make_log()
    const parent = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    parent.with_providers(
      { acme_native: {} },
      { acme_native: make_native_factory('acme_native', log, [one_shot('child hello')]) },
    )
    // The added provider exists only on the derived engine; the parent's
    // adapter map never gained it.
    await expect(
      parent.generate({ model: 'nat-1', provider: 'acme_native', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(provider_not_configured_error)
  })

  it('carries construction defaults forward to the derived engine', async () => {
    const log = make_log()
    const parent = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      defaults: { model: 'nat-1', provider: 'acme_native' },
    })
    const child = parent.with_providers(
      { acme_native: {} },
      { acme_native: make_native_factory('acme_native', log, [one_shot('defaulted')]) },
    )
    // No model/provider on the call: reaching the added provider proves both the
    // defaults carried forward and the new provider resolved.
    const result = await child.generate({ prompt: 'hi' })
    expect(result.content).toBe('defaulted')
    expect(result.model_resolved).toEqual({ provider: 'acme_native', model_id: 'nat-1' })
  })

  it('throws engine_config_error naming the shadowed built-in', () => {
    const log = make_log()
    const parent = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    expect(() =>
      parent.with_providers({}, { openai: make_ai_sdk_factory('openai', log) }),
    ).toThrow(engine_config_error)
    expect(() =>
      parent.with_providers({}, { openai: make_ai_sdk_factory('openai', log) }),
    ).toThrow("custom_providers must not shadow built-in provider 'openai'")
  })

  it('constructs adapters fresh and disposes independently of the parent', async () => {
    const log = make_log()
    const parent = create_engine({
      providers: { p1: {} },
      custom_providers: { p1: make_native_factory('p1', log, []) },
    })
    const child = parent.with_providers(
      { p2: {} },
      { p2: make_native_factory('p2', log, []) },
    )

    await child.dispose()
    // The child built its own p1 and p2 (custom_providers carried forward, so p1
    // is reconstructed fresh); disposing the child tears down only those.
    expect(log.disposals.filter((n) => n === 'p1')).toHaveLength(1)
    expect(log.disposals.filter((n) => n === 'p2')).toHaveLength(1)

    // The parent's own p1 is a separate instance, still live.
    await parent.dispose()
    expect(log.disposals.filter((n) => n === 'p1')).toHaveLength(2)
    expect(log.disposals.filter((n) => n === 'p2')).toHaveLength(1)
  })

  it('merges providers by name and carries custom_providers forward', () => {
    const log = make_log()
    const parent = create_engine({
      providers: { acme: { api_key: 'original' } },
      custom_providers: { acme: make_ai_sdk_factory('acme', log) },
    })
    // Override the existing entry's init without re-supplying its factory.
    parent.with_providers({ acme: { api_key: 'overridden' } })
    // The parent built acme with the original init; the child re-ran the same
    // carried-forward factory with the overriding init.
    expect(log.inits).toEqual([{ api_key: 'original' }, { api_key: 'overridden' }])
  })

  it('carries construction-time pricing forward', () => {
    const log = make_log()
    const parent = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      pricing: { 'custom:model-x': { input_per_million: 1, output_per_million: 2 } },
    })
    const child = parent.with_providers(
      { acme_native: {} },
      { acme_native: make_native_factory('acme_native', log, []) },
    )
    expect(child.resolve_price('custom', 'model-x')).toEqual({
      input_per_million: 1,
      output_per_million: 2,
    })
    expect(child.resolve_price('anthropic', 'claude-opus-4-8')).toBeDefined()
  })

  it('derives from construction config, not runtime register_price mutations', () => {
    const parent = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    parent.register_price('anthropic', 'claude-runtime', {
      input_per_million: 9,
      output_per_million: 9,
    })
    const child = parent.with_providers({})
    // The runtime mutation stays on the parent; derivation is a pure function of
    // the construction config (value semantics, D8).
    expect(parent.resolve_price('anthropic', 'claude-runtime')).toBeDefined()
    expect(child.resolve_price('anthropic', 'claude-runtime')).toBeUndefined()
  })
})
