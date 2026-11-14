import { afterEach, describe, expect, it, vi } from 'vitest'
import { a2a_error, a2a_sdk_missing_error } from '../errors.js'
import { load_a2a_client, load_a2a_server } from '../sdk_loader.js'

afterEach(() => {
  vi.doUnmock('@a2a-js/sdk')
  vi.doUnmock('@a2a-js/sdk/server')
  vi.doUnmock('@a2a-js/sdk/client')
  vi.resetModules()
})

describe('load_a2a_server', () => {
  it('resolves the pieces serving builds on', async () => {
    const sdk = await load_a2a_server()
    expect(typeof sdk.server.DefaultRequestHandler).toBe('function')
    expect(typeof sdk.server.JsonRpcTransportHandler).toBe('function')
    expect(typeof sdk.server.validateVersion).toBe('function')
    expect(typeof sdk.errors.UnsupportedOperationError).toBe('function')
    expect(sdk.wire.TaskState.TASK_STATE_INPUT_REQUIRED).toBe(6)
    expect(sdk.wire.A2A_PROTOCOL_VERSION).toBe('1.0')
  })

  it('throws a typed a2a_sdk_missing_error that says how to install it when the import fails', async () => {
    vi.resetModules()
    vi.doMock('@a2a-js/sdk/server', () => {
      throw new Error('module not found (test)')
    })
    const cause: unknown = await import('@a2a-js/sdk/server').catch((e: unknown) => e)
    expect(cause).toBeInstanceOf(Error)
    const { load_a2a_server: loader } = await import('../sdk_loader.js')
    const err: unknown = await loader().catch((e: unknown) => e)
    expect(err).toMatchObject({
      kind: 'a2a_sdk_missing_error',
      name: 'a2a_sdk_missing_error',
      message: `@a2a-js/sdk is required for fascicle/a2a; install it: pnpm add @a2a-js/sdk (cause: ${(cause as Error).message})`,
    })
  })
})

describe('load_a2a_client', () => {
  it('resolves the pieces calling a remote agent builds on', async () => {
    const sdk = await load_a2a_client()
    expect(typeof sdk.client.ClientFactory).toBe('function')
    expect(typeof sdk.client.JsonRpcTransportFactory).toBe('function')
    expect(sdk.wire.Role.ROLE_USER).toBe(1)
  })

  it('throws the same typed error when the client half is missing', async () => {
    vi.resetModules()
    vi.doMock('@a2a-js/sdk/client', () => {
      throw new Error('module not found (test)')
    })
    const { load_a2a_client: loader } = await import('../sdk_loader.js')
    const err: unknown = await loader().catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'a2a_sdk_missing_error' })
    expect((err as Error).message).toContain('pnpm add @a2a-js/sdk (cause: ')
  })
})

describe('a missing peer, from the module\'s public face', () => {
  it('imports fascicle/a2a without the SDK, and a2a_agent then throws a2a_sdk_missing_error', async () => {
    vi.resetModules()
    vi.doMock('@a2a-js/sdk', () => {
      throw new Error('module not found (test)')
    })
    const a2a = await import('../index.js')
    expect(typeof a2a.a2a_agent).toBe('function')
    expect(typeof a2a.a2a_step).toBe('function')
    const { step } = await import('#core')
    const building = a2a.a2a_agent({
      flow: step('echo', (text: string) => text),
      card: { name: 'echo', description: 'echoes', url: 'http://agent.test/', skills: [] },
    })
    await expect(building).rejects.toMatchObject({ kind: 'a2a_sdk_missing_error' })
  })
})

describe('the errors', () => {
  it('defaults the missing-peer message to the install line', () => {
    const err = new a2a_sdk_missing_error()
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('a2a_sdk_missing_error')
    expect(err.name).toBe('a2a_sdk_missing_error')
    expect(err.message).toBe('@a2a-js/sdk is required for fascicle/a2a; install it: pnpm add @a2a-js/sdk')
  })

  it('carries a remote task\'s state, status text, and id on a2a_error', () => {
    const err = new a2a_error('the remote task t1 ended in TASK_STATE_FAILED: boom', {
      state: 'TASK_STATE_FAILED',
      status_text: 'boom',
      task_id: 't1',
    })
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({
      kind: 'a2a_error',
      name: 'a2a_error',
      message: 'the remote task t1 ended in TASK_STATE_FAILED: boom',
      state: 'TASK_STATE_FAILED',
      status_text: 'boom',
      task_id: 't1',
    })
    const bare = new a2a_error('no detail')
    expect(bare.state).toBeUndefined()
    expect(bare.status_text).toBeUndefined()
    expect(bare.task_id).toBeUndefined()
  })
})
