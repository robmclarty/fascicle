import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_bedrock_adapter } from '../bedrock.js'
import { engine_config_error } from '../../errors.js'

// Capture what build_model hands to the Bedrock SDK so credential/config
// assembly is observable. The real-peer integration stays covered by
// bedrock.test.ts.
const { captured } = vi.hoisted(() => {
  const value: { config: Record<string, unknown> | undefined, model_id: unknown } = {
    config: undefined,
    model_id: undefined,
  }
  return { captured: value }
})
vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

const OPTIONAL_KEYS = ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'baseURL'] as const

describe('create_bedrock_adapter config assembly', () => {
  it('is an ai_sdk adapter named bedrock', () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('bedrock')
  })

  it('rejects a missing or non-string region with a tagged engine_config_error', () => {
    for (const init of [{}, { region: '' }, { region: 123 }]) {
      let err: unknown
      try {
        create_bedrock_adapter(init)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe('bedrock provider requires a non-empty region')
      expect((err as engine_config_error).provider).toBe('bedrock')
    }
  })

  it('forwards region and every supplied credential to the SDK', async () => {
    const adapter = create_bedrock_adapter({
      region: 'us-west-2',
      api_key: 'bearer-token',
      access_key_id: 'AKIA',
      secret_access_key: 'shh',
      session_token: 'session',
      base_url: 'https://bedrock.example',
    })
    const model = await adapter.build_model('anthropic.claude-3-5-sonnet-20241022-v2:0')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({
      region: 'us-west-2',
      apiKey: 'bearer-token',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      sessionToken: 'session',
      baseURL: 'https://bedrock.example',
    })
    expect(captured.model_id).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0')
  })

  it('sends only the region when no credentials are supplied', async () => {
    captured.config = undefined
    const adapter = create_bedrock_adapter({ region: 'us-east-1' })
    await adapter.build_model('m')
    expect(captured.config).toEqual({ region: 'us-east-1' })
    // Key absence, not just value: unconditional assignment would leave
    // undefined entries that toEqual ignores.
    for (const key of OPTIONAL_KEYS) {
      expect(key in (captured.config ?? {})).toBe(false)
    }
  })

  it('ignores non-string credentials', async () => {
    captured.config = undefined
    const adapter = create_bedrock_adapter({
      region: 'us-east-1',
      api_key: 1,
      access_key_id: true,
      secret_access_key: {},
      session_token: [],
      base_url: 2,
    } as unknown as ProviderInit)
    await adapter.build_model('m')
    expect(captured.config).toEqual({ region: 'us-east-1' })
  })
})
