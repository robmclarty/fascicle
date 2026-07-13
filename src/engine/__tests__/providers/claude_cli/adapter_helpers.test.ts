import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { claude_cli_error, provider_auth_error } from '../../../errors.js'
import type { GenerateOptions, Message } from '../../../types.js'
import {
  classify_close_error,
  compile_schema,
  count_user_messages,
  effort_env_for_claude_cli,
  extract_call_opts,
  extract_prompt_text,
  extract_system_text,
} from '../../../providers/claude_cli/adapter.js'

describe('effort_env_for_claude_cli', () => {
  it('sets no env for undefined or none', () => {
    expect(effort_env_for_claude_cli(undefined)).toEqual({})
    expect(effort_env_for_claude_cli('none')).toEqual({})
  })

  it('maps each non-none level to its CLAUDE_CODE_EFFORT_LEVEL value', () => {
    expect(effort_env_for_claude_cli('low')).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'low' })
    expect(effort_env_for_claude_cli('medium')).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'medium' })
    expect(effort_env_for_claude_cli('high')).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' })
    expect(effort_env_for_claude_cli('xhigh')).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' })
    expect(effort_env_for_claude_cli('max')).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'max' })
  })
})

const opts = (provider_options?: Record<string, unknown>): GenerateOptions<unknown> =>
  ({ prompt: 'x', ...(provider_options !== undefined ? { provider_options } : {}) })

describe('extract_call_opts', () => {
  it('returns {} when provider_options is absent', () => {
    expect(extract_call_opts(opts())).toEqual({})
  })

  it('returns {} when the claude_cli key is missing, null, or not an object', () => {
    expect(extract_call_opts(opts({}))).toEqual({})
    expect(extract_call_opts(opts({ claude_cli: null }))).toEqual({})
    expect(extract_call_opts(opts({ claude_cli: 'nope' }))).toEqual({})
  })

  it('returns the claude_cli options object when present', () => {
    const claude_cli = { session_id: 'abc' }
    expect(extract_call_opts(opts({ claude_cli }))).toBe(claude_cli)
  })
})

describe('count_user_messages', () => {
  it('counts a string prompt as one user message', () => {
    expect(count_user_messages('hello')).toBe(1)
  })

  it('counts only user-role messages in an array', () => {
    const prompt: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    expect(count_user_messages(prompt)).toBe(2)
  })
})

describe('extract_prompt_text', () => {
  it('returns a string prompt verbatim', () => {
    expect(extract_prompt_text('hello world')).toBe('hello world')
  })

  it('returns the first user message string content', () => {
    const prompt: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    expect(extract_prompt_text(prompt)).toBe('hi')
  })

  it('joins only the text parts of array content with newlines', () => {
    const prompt: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', image: 'data' },
          { type: 'text', text: 'b' },
        ],
      },
    ]
    expect(extract_prompt_text(prompt)).toBe('a\nb')
  })

  it('returns an empty string when there is no user message', () => {
    expect(extract_prompt_text([{ role: 'system', content: 'sys' }])).toBe('')
  })
})

describe('extract_system_text', () => {
  it('returns undefined for a string prompt', () => {
    expect(extract_system_text('hello')).toBeUndefined()
  })

  it('returns the first system message content', () => {
    const prompt: Message[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]
    expect(extract_system_text(prompt)).toBe('be brief')
  })

  it('scans past non-system messages to find the system message', () => {
    const prompt: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be brief' },
    ]
    expect(extract_system_text(prompt)).toBe('be brief')
  })

  it('returns undefined when there is no system message', () => {
    expect(extract_system_text([{ role: 'user', content: 'hi' }])).toBeUndefined()
  })
})

describe('compile_schema', () => {
  it('serializes the JSON Schema of a Zod type', () => {
    const json = JSON.parse(compile_schema(z.object({ x: z.number() }))) as Record<string, unknown>
    expect(json['type']).toBe('object')
    expect((json['properties'] as Record<string, unknown>)['x']).toMatchObject({ type: 'number' })
  })

  it('strips the top-level $schema and $id keys the CLI rejects', () => {
    const json = JSON.parse(compile_schema(z.object({ a: z.string() }))) as Record<string, unknown>
    expect(json).not.toHaveProperty('$schema')
    expect(json).not.toHaveProperty('$id')
    // field constraints survive the strip
    expect((json['properties'] as Record<string, unknown>)['a']).toMatchObject({ type: 'string' })
    expect(json['required']).toEqual(['a'])
  })
})

describe('classify_close_error', () => {
  it('classifies an auth failure with a refresh command', () => {
    const err = classify_close_error(1, null, 'Error: unauthorized request')
    expect(err).toBeInstanceOf(provider_auth_error)
    expect(err.message).toContain('auth failure')
    expect((err as provider_auth_error).refresh_command).toBe('claude login')
  })

  it('classifies a missing sandbox binary', () => {
    const err = classify_close_error(127, null, 'bwrap: command not found')
    expect(err).toBeInstanceOf(claude_cli_error)
    expect((err as claude_cli_error).reason).toBe('sandbox_unavailable')
    expect(err.message).toContain('sandbox')
    expect((err as claude_cli_error).stderr_snippet).toBe('bwrap: command not found')
  })

  it('requires both sandbox and not-found markers for the sandbox classification', () => {
    // "not found" alone (no sandbox/bwrap/greywall token) is an ordinary exit.
    const err = classify_close_error(1, null, 'config file not found')
    expect((err as claude_cli_error).reason).toBe('subprocess_exit')
  })

  it('classifies an ordinary non-zero exit with code and stderr', () => {
    const err = classify_close_error(2, null, 'boom')
    expect(err).toBeInstanceOf(claude_cli_error)
    expect((err as claude_cli_error).reason).toBe('subprocess_exit')
    expect(err.message).toContain('code 2')
    expect(err.message).toContain('boom')
    expect(err.message).not.toContain('(signal')
    expect((err as claude_cli_error).status).toBe(2)
    expect((err as claude_cli_error).stderr_snippet).toBe('boom')
  })

  it('includes the signal and omits the status when terminated by a signal', () => {
    const err = classify_close_error(null, 'SIGTERM', 'killed')
    expect(err.message).toContain('(signal SIGTERM)')
    expect((err as claude_cli_error).status).toBeUndefined()
  })

  it('truncates the stderr snippet to 512 characters', () => {
    const long = 'x'.repeat(600)
    const err = classify_close_error(1, null, long)
    expect((err as claude_cli_error).stderr_snippet).toHaveLength(512)
  })
})
