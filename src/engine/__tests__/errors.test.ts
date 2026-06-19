import { describe, expect, it } from 'vitest'
import {
  aborted_error,
  claude_cli_error,
  engine_config_error,
  engine_disposed_error,
  model_required_error,
  on_chunk_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  rate_limit_error,
  schema_validation_error,
  tool_approval_denied_error,
  tool_error,
} from '../errors.js'

describe('typed errors', () => {
  it('aborted_error carries reason / step_index / tool_call_in_flight metadata', () => {
    const err = new aborted_error('aborted', {
      reason: 'user cancel',
      step_index: 2,
      tool_call_in_flight: { id: 'c9', name: 'search' },
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('aborted_error')
    expect(err.reason).toBe('user cancel')
    expect(err.step_index).toBe(2)
    expect(err.tool_call_in_flight).toEqual({ id: 'c9', name: 'search' })
  })

  it('rate_limit_error carries retry_after_ms / attempts / status', () => {
    const err = new rate_limit_error('rate limited', {
      retry_after_ms: 3000,
      attempts: 3,
      status: 429,
    })
    expect(err.kind).toBe('rate_limit_error')
    expect(err.retry_after_ms).toBe(3000)
    expect(err.attempts).toBe(3)
    expect(err.status).toBe(429)
  })

  it('provider_error carries status / body / cause_kind', () => {
    const err = new provider_error('boom', {
      status: 503,
      body: 'Service Unavailable',
      cause_kind: 'provider_5xx',
    })
    expect(err.kind).toBe('provider_error')
    expect(err.status).toBe(503)
    expect(err.body).toBe('Service Unavailable')
    expect(err.cause_kind).toBe('provider_5xx')
  })

  it('schema_validation_error carries zod_error and raw_text', () => {
    const zerr = new Error('expected object, got string')
    const err = new schema_validation_error('validation failed', zerr, 'not json')
    expect(err.kind).toBe('schema_validation_error')
    expect(err.zod_error).toBe(zerr)
    expect(err.raw_text).toBe('not json')
  })

  it('tool_error carries tool_name / tool_call_id / cause', () => {
    const inner = new Error('bad')
    const err = new tool_error('tool failed', {
      tool_name: 'search',
      tool_call_id: 'c1',
      cause: inner,
    })
    expect(err.kind).toBe('tool_error')
    expect(err.tool_name).toBe('search')
    expect(err.tool_call_id).toBe('c1')
    expect(err.cause).toBe(inner)
  })

  it('tool_approval_denied_error carries tool_name / step_index / tool_call_id', () => {
    const err = new tool_approval_denied_error('denied', {
      tool_name: 'exec',
      step_index: 1,
      tool_call_id: 'c9',
    })
    expect(err.kind).toBe('tool_approval_denied_error')
    expect(err.tool_name).toBe('exec')
    expect(err.step_index).toBe(1)
    expect(err.tool_call_id).toBe('c9')
  })

  it('model_required_error carries a helpful default message', () => {
    const err = new model_required_error()
    expect(err.kind).toBe('model_required_error')
    expect(err.message).toContain('model')
    expect(err).toBeInstanceOf(Error)
  })

  it('provider_not_configured_error names the provider', () => {
    const err = new provider_not_configured_error('mysterious')
    expect(err.kind).toBe('provider_not_configured_error')
    expect(err.provider).toBe('mysterious')
  })

  it('engine_config_error optionally carries a provider tag', () => {
    const err = new engine_config_error('bad config', 'anthropic')
    expect(err.kind).toBe('engine_config_error')
    expect(err.provider).toBe('anthropic')
    const bare = new engine_config_error('root config bad')
    expect(bare.provider).toBeUndefined()
  })

  it('on_chunk_error wraps the original cause', () => {
    const cause = new Error('inner')
    const err = new on_chunk_error('callback failed', cause)
    expect(err.kind).toBe('on_chunk_error')
    expect(err.cause).toBe(cause)
  })

  it('provider_capability_error names provider and capability', () => {
    const err = new provider_capability_error('ollama', 'image_input')
    expect(err.kind).toBe('provider_capability_error')
    expect(err.provider).toBe('ollama')
    expect(err.capability).toBe('image_input')
    expect(err.message).toContain('ollama')
    expect(err.message).toContain('image_input')
  })

  it('provider_capability_error appends detail only when given', () => {
    expect(new provider_capability_error('ollama', 'image_input', 'binary too old').message).toBe(
      "provider 'ollama' does not support 'image_input': binary too old",
    )
    expect(new provider_capability_error('ollama', 'image_input').message).toBe(
      "provider 'ollama' does not support 'image_input'",
    )
  })

  it('provider_not_configured_error message names the provider', () => {
    expect(new provider_not_configured_error('mysterious').message).toBe(
      "provider 'mysterious' is not configured on this engine",
    )
  })

  it('engine_disposed_error carries a default message', () => {
    const err = new engine_disposed_error()
    expect(err.kind).toBe('engine_disposed_error')
    expect(err.message).toContain('disposed')
  })

  it('claude_cli_error carries reason and optional status / stderr_snippet', () => {
    const err = new claude_cli_error('auth_expired', 'login expired', {
      status: 401,
      stderr_snippet: 'token expired',
    })
    expect(err.kind).toBe('claude_cli_error')
    expect(err.reason).toBe('auth_expired')
    expect(err.status).toBe(401)
    expect(err.stderr_snippet).toBe('token expired')
    const bare = new claude_cli_error('binary_not_found', 'no binary')
    expect(bare.reason).toBe('binary_not_found')
    expect(bare.status).toBeUndefined()
    expect(bare.stderr_snippet).toBeUndefined()
  })

  it('provider_auth_error carries provider and optional refresh_command', () => {
    const err = new provider_auth_error('anthropic', 'auth failed', { refresh_command: 'claude login' })
    expect(err.kind).toBe('provider_auth_error')
    expect(err.provider).toBe('anthropic')
    expect(err.refresh_command).toBe('claude login')
    const bare = new provider_auth_error('openai', 'no key')
    expect(bare.provider).toBe('openai')
    expect(bare.refresh_command).toBeUndefined()
  })

  it('sets .name to match each error kind', () => {
    expect(new rate_limit_error('x').name).toBe('rate_limit_error')
    expect(new provider_error('x').name).toBe('provider_error')
    expect(new schema_validation_error('x', null, '').name).toBe('schema_validation_error')
    expect(new tool_error('x', { tool_name: 't', tool_call_id: 'c', cause: null }).name).toBe('tool_error')
    expect(
      new tool_approval_denied_error('x', { tool_name: 't', step_index: 0, tool_call_id: 'c' }).name,
    ).toBe('tool_approval_denied_error')
    expect(new model_required_error().name).toBe('model_required_error')
    expect(new provider_not_configured_error('x').name).toBe('provider_not_configured_error')
    expect(new engine_config_error('x').name).toBe('engine_config_error')
    expect(new on_chunk_error('x', null).name).toBe('on_chunk_error')
    expect(new provider_capability_error('x', 'y').name).toBe('provider_capability_error')
    expect(new engine_disposed_error().name).toBe('engine_disposed_error')
    expect(new claude_cli_error('binary_not_found', 'x').name).toBe('claude_cli_error')
    expect(new provider_auth_error('p', 'x').name).toBe('provider_auth_error')
  })

  it('every typed error is an instance of Error', () => {
    const errors: Error[] = [
      new aborted_error(),
      new rate_limit_error('x'),
      new provider_error('x'),
      new schema_validation_error('x', null, ''),
      new tool_error('x', { tool_name: 't', tool_call_id: 'c', cause: null }),
      new tool_approval_denied_error('x', { tool_name: 't', step_index: 0, tool_call_id: 'c' }),
      new model_required_error(),
      new provider_not_configured_error('x'),
      new engine_config_error('x'),
      new on_chunk_error('x', null),
      new provider_capability_error('x', 'y'),
    ]
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error)
    }
  })
})
