import { afterEach, describe, expect, it, vi } from 'vitest'
import { acp_sdk_missing_error } from '../errors.js'
import { load_acp_sdk } from '../sdk_loader.js'

afterEach(() => {
  vi.doUnmock('@agentclientprotocol/sdk')
  vi.resetModules()
})

describe('load_acp_sdk', () => {
  it('resolves the protocol v1 entry the adapter builds on', async () => {
    const sdk = await load_acp_sdk()
    expect(typeof sdk.agent).toBe('function')
    expect(typeof sdk.ndJsonStream).toBe('function')
    expect(typeof sdk.RequestError).toBe('function')
    expect(sdk.PROTOCOL_VERSION).toBe(1)
  })

  it('throws a typed acp_sdk_missing_error naming both installs and the cause when the import fails', async () => {
    vi.resetModules()
    vi.doMock('@agentclientprotocol/sdk', () => {
      throw new Error('module not found (test)')
    })
    // vitest rethrows a factory's error as its own, so the cause to expect is
    // whatever the mocked import rejects with, not the factory's text.
    const cause: unknown = await import('@agentclientprotocol/sdk').catch((e: unknown) => e)
    expect(cause).toBeInstanceOf(Error)
    const { load_acp_sdk: loader } = await import('../sdk_loader.js')
    const err: unknown = await loader().catch((e: unknown) => e)
    expect(err).toMatchObject({
      kind: 'acp_sdk_missing_error',
      name: 'acp_sdk_missing_error',
      message: `@agentclientprotocol/sdk is required for fascicle/acp; install it with its zod peer: pnpm add @agentclientprotocol/sdk zod (cause: ${(cause as Error).message})`,
    })
  })
})

describe('acp_sdk_missing_error', () => {
  it('defaults to a message that names both installs', () => {
    const err = new acp_sdk_missing_error()
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('acp_sdk_missing_error')
    expect(err.name).toBe('acp_sdk_missing_error')
    expect(err.message).toBe(
      '@agentclientprotocol/sdk is required for fascicle/acp; install it with its zod peer: pnpm add @agentclientprotocol/sdk zod',
    )
  })
})
