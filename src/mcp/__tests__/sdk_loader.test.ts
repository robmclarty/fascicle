import { afterEach, describe, expect, it, vi } from 'vitest'
import { load_client_sdk } from '../sdk_loader.js'

afterEach(() => {
  vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js')
  vi.resetModules()
})

describe('load_client_sdk', () => {
  it('resolves the Client and transport constructors from the installed SDK', async () => {
    const sdk = await load_client_sdk()
    expect(typeof sdk.Client).toBe('function')
    expect(typeof sdk.StdioClientTransport).toBe('function')
    expect(typeof sdk.StreamableHTTPClientTransport).toBe('function')
  })

  it('throws a typed mcp_sdk_missing_error with install guidance when a sub-import fails', async () => {
    vi.resetModules()
    vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => {
      throw new Error('module not found (test)')
    })
    const { load_client_sdk: loader } = await import('../sdk_loader.js')
    await expect(loader()).rejects.toMatchObject({ kind: 'mcp_sdk_missing_error' })
    await expect(loader()).rejects.toThrow(/install it: pnpm add @modelcontextprotocol\/sdk/)
  })
})
