import { beforeEach, describe, expect, it, vi } from 'vitest'
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

// The credential chain is an optional peer loaded only when the flag selects
// it; `chain_calls` pins that it is never loaded on the other auth paths, and
// that the memoized provider is built once per adapter rather than per model.
const { chain } = vi.hoisted(() => ({ chain: { calls: 0 } }))
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => {
    chain.calls += 1
    return () =>
      Promise.resolve({ accessKeyId: 'AKIACHAIN', secretAccessKey: 'chain-secret' })
  },
}))

const OPTIONAL_KEYS = ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'baseURL'] as const

const CALLER_PROVIDER = (): Promise<{ accessKeyId: string, secretAccessKey: string }> =>
  Promise.resolve({ accessKeyId: 'AKIACALLER', secretAccessKey: 'caller-secret' })

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
    expect('credentialProvider' in (captured.config ?? {})).toBe(false)
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

describe('create_bedrock_adapter dynamic credential sources', () => {
  beforeEach(() => {
    captured.config = undefined
    chain.calls = 0
  })

  /** Read the credentialProvider the adapter attached, if any. */
  function attached_provider(): unknown {
    return captured.config?.['credentialProvider']
  }

  it('attaches the node provider chain when use_credential_chain is set', async () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1', use_credential_chain: true })
    await adapter.build_model('m')

    expect(chain.calls).toBe(1)
    const provider = attached_provider()
    expect(typeof provider).toBe('function')
    // The SDK calls it with no arguments and adds `region` itself, so the
    // provider must resolve to the bare credential record.
    expect(await (provider as () => Promise<unknown>)()).toEqual({
      accessKeyId: 'AKIACHAIN',
      secretAccessKey: 'chain-secret',
    })
    // The other credential fields stay absent; the chain is the only source.
    for (const key of OPTIONAL_KEYS) {
      expect(key in (captured.config ?? {})).toBe(false)
    }
  })

  it('builds the memoized chain once per adapter, not once per model', async () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1', use_credential_chain: true })
    await adapter.build_model('a')
    const first = attached_provider()
    await adapter.build_model('b')

    // fromNodeProviderChain returns a provider that caches credentials and
    // refreshes on expiry; rebuilding it per model would discard that cache and
    // re-resolve on every request.
    expect(chain.calls).toBe(1)
    expect(attached_provider()).toBe(first)
  })

  it('passes a caller-supplied credential_provider straight through', async () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1', credential_provider: CALLER_PROVIDER })
    await adapter.build_model('m')

    expect(attached_provider()).toBe(CALLER_PROVIDER)
    expect(chain.calls).toBe(0)
  })

  it('rejects use_credential_chain together with credential_provider', () => {
    let err: unknown
    try {
      create_bedrock_adapter({
        region: 'us-east-1',
        use_credential_chain: true,
        credential_provider: () => Promise.resolve({ accessKeyId: 'a', secretAccessKey: 'b' }),
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe(
      'bedrock provider accepts use_credential_chain or credential_provider, not both',
    )
    expect((err as engine_config_error).provider).toBe('bedrock')
  })

  // The flag is a fallback, not an override: a consumer can set it
  // unconditionally and still have Lambda's forwarded role keys take effect.
  // Passing both to the SDK would invert that, since it prefers
  // credentialProvider over accessKeyId.
  it.each([
    { label: 'access_key_id', explicit: { access_key_id: 'AKIA' } },
    { label: 'secret_access_key', explicit: { secret_access_key: 'shh' } },
    { label: 'session_token', explicit: { session_token: 'session' } },
  ])('lets an explicit $label win over a dynamic source', async ({ explicit }) => {
    const adapter = create_bedrock_adapter({
      region: 'us-east-1',
      use_credential_chain: true,
      ...explicit,
    })
    await adapter.build_model('m')

    expect(attached_provider()).toBeUndefined()
    expect('credentialProvider' in (captured.config ?? {})).toBe(false)
    expect(chain.calls).toBe(0)
  })

  it('lets the bearer token win without loading the credential-providers peer', async () => {
    const adapter = create_bedrock_adapter({
      region: 'us-east-1',
      api_key: 'bearer-token',
      use_credential_chain: true,
    })
    await adapter.build_model('m')

    expect(captured.config).toEqual({ region: 'us-east-1', apiKey: 'bearer-token' })
    // The peer is optional, so bearer-token users must never be made to install it.
    expect(chain.calls).toBe(0)
  })

  it('ignores a non-boolean flag and a non-function credential_provider', async () => {
    const adapter = create_bedrock_adapter({
      region: 'us-east-1',
      use_credential_chain: 'yes',
      credential_provider: 'nope',
    })
    await adapter.build_model('m')

    expect(captured.config).toEqual({ region: 'us-east-1' })
    expect(chain.calls).toBe(0)
  })
})
