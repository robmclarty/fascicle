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
  no_result_error,
} from '../../../providers/claude_cli/adapter.js'

const EXIT_ACTION = ': run `claude -p hello` in the same directory to see whether the CLI works by itself'

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
  it('serializes the JSON Schema of a schema', () => {
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

  // The CLI's `--json-schema` argv value stays byte-identical whichever
  // schema emitter builds it.
  // The strip moved from a bespoke rest-spread in this adapter to the
  // `strip_meta` option on the shared emitter; these are the bytes that
  // change if that option ever stops being passed. The schema carries no
  // defaulted field, so the composed input-direction emission leaves the
  // rest of the value alone.
  it('emits byte-identical argv JSON, $schema and $id absent', () => {
    expect(compile_schema(z.object({ city: z.string() }))).toBe(
      '{"type":"object","properties":{"city":{"type":"string"}},' +
        '"required":["city"],"additionalProperties":false}',
    )
  })
})

describe('classify_close_error', () => {
  it('classifies an auth failure with a refresh command, which its message names', () => {
    const err = classify_close_error(1, null, 'Error: unauthorized request')
    expect(err).toBeInstanceOf(provider_auth_error)
    expect(err.message).toBe('claude CLI reported an auth failure: Error: unauthorized request: run claude auth login')
    expect((err as provider_auth_error).refresh_command).toBe('claude auth login')
  })

  it('names the refresh command alone when the CLI gave no reason', () => {
    const err = classify_close_error(1, null, '', {
      is_error: false,
      final_text: '',
      api_error: 'authentication_failed',
    })
    expect(err.message).toBe('claude CLI reported an auth failure: run claude auth login')
  })

  // Shaped like Claude Code 2.1.316's message when failIfUnavailable stops a
  // run because its own sandbox can't start. The detail varies by platform;
  // the closing sentence is the CLI's own.
  const SANDBOX_START_FAILED = 'sandbox unavailable detail: socat is missing. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.'

  it("classifies Claude Code's own sandbox failing to start from stderr", () => {
    const err = classify_close_error(1, null, SANDBOX_START_FAILED)
    expect(err).toBeInstanceOf(claude_cli_error)
    expect((err as claude_cli_error).reason).toBe('sandbox_unavailable')
    expect(err.message).toContain("Claude Code's sandbox couldn't start")
    expect(err.message).toContain('bubblewrap and socat')
    expect(err.message).toContain(SANDBOX_START_FAILED)
    expect((err as claude_cli_error).stderr_snippet).toBe(SANDBOX_START_FAILED)
  })

  it("classifies Claude Code's own sandbox failing to start from the error result", () => {
    const err = classify_close_error(1, null, '', {
      is_error: true,
      final_text: SANDBOX_START_FAILED,
    })
    expect((err as claude_cli_error).reason).toBe('sandbox_unavailable')
    expect(err.message).toContain(SANDBOX_START_FAILED)
  })

  it('classifies a missing sandbox binary', () => {
    const err = classify_close_error(127, null, 'bwrap: command not found')
    expect(err).toBeInstanceOf(claude_cli_error)
    expect((err as claude_cli_error).reason).toBe('sandbox_unavailable')
    expect(err.message).toBe(
      "sandbox binary unavailable: bwrap: command not found: install the binary that it names and put it on PATH. A providers.claude_cli.sandbox.kind of 'bwrap' or 'greywall' can switch to kind: 'claude_code' instead, which needs no wrapper on macOS and needs bubblewrap and socat on Linux",
    )
    expect((err as claude_cli_error).stderr_snippet).toBe('bwrap: command not found')
  })

  it('quotes a missing sandbox binary\'s stderr without its closing newline, and keeps the snippet raw', () => {
    const err = classify_close_error(127, null, 'greywall: command not found\n')
    expect(err.message).toMatch(/^sandbox binary unavailable: greywall: command not found: install the binary/)
    expect((err as claude_cli_error).stderr_snippet).toBe('greywall: command not found\n')
  })

  it('never tells a missing-binary reader that claude_code needs nothing', () => {
    const err = classify_close_error(127, null, 'bwrap: command not found')
    expect(err.message).not.toMatch(/needs no wrapper$/)
    expect(err.message).toContain('needs bubblewrap and socat on Linux')
  })

  it('blames the claude binary, not bwrap, when bwrap cannot exec it in the sandbox', () => {
    const stderr = 'bwrap: execvp /home/me/.local/bin/claude: No such file or directory\n'
    const err = classify_close_error(1, null, stderr)
    expect(err).toBeInstanceOf(claude_cli_error)
    expect((err as claude_cli_error).reason).toBe('binary_not_found')
    expect(err.message).toBe(
      `bwrap ran but found no claude binary at '/home/me/.local/bin/claude' inside its sandbox, which binds only /usr, /bin, /lib, /lib64, and additional_write_paths: ${stderr.trim()}: point providers.claude_cli.binary at a claude under one of those, or switch the sandbox to kind: 'claude_code', which wraps nothing`,
    )
    expect((err as claude_cli_error).stderr_snippet).toBe(stderr)
  })

  it('leaves other bwrap exec failures to the later classifications', () => {
    const err = classify_close_error(1, null, 'bwrap: execvp /usr/bin/claude: Permission denied')
    expect((err as claude_cli_error).reason).toBe('subprocess_exit')
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
    expect(err.message).toBe(`claude CLI exited with code 2: boom${EXIT_ACTION}`)
    expect((err as claude_cli_error).status).toBe(2)
    expect((err as claude_cli_error).stderr_snippet).toBe('boom')
  })

  it('quotes stderr without its closing newline, so the action stays on the same line', () => {
    const err = classify_close_error(1, null, 'boom\n')
    expect(err.message).toBe(`claude CLI exited with code 1: boom${EXIT_ACTION}`)
    expect((err as claude_cli_error).stderr_snippet).toBe('boom\n')
  })

  it('treats a stderr of only whitespace as no reason', () => {
    const err = classify_close_error(1, null, ' \n')
    expect(err.message).toBe(`claude CLI exited with code 1: it printed no reason${EXIT_ACTION}`)
  })

  it('falls back to the error result\'s text when stderr is only whitespace', () => {
    const err = classify_close_error(1, null, '\n', { is_error: true, final_text: 'API Error: 529 overloaded\n' })
    expect(err.message).toBe(`claude CLI exited with code 1: API Error: 529 overloaded${EXIT_ACTION}`)
  })

  it('says only what to run when an auth failure came with whitespace alone', () => {
    const err = classify_close_error(1, null, '\n', { is_error: false, final_text: '', api_error: 'authentication_failed' })
    expect(err.message).toBe('claude CLI reported an auth failure: run claude auth login')
  })

  it('includes the signal and omits the status when terminated by a signal', () => {
    const err = classify_close_error(null, 'SIGTERM', 'killed')
    expect(err.message).toBe(`claude CLI exited with code null (signal SIGTERM): killed${EXIT_ACTION}`)
    expect((err as claude_cli_error).status).toBeUndefined()
  })

  it('truncates the stderr snippet to 512 characters', () => {
    const long = 'x'.repeat(600)
    const err = classify_close_error(1, null, long)
    expect((err as claude_cli_error).stderr_snippet).toHaveLength(512)
  })

  it('classifies a logged-out session from the stream, in the CLI\'s own words', () => {
    const err = classify_close_error(1, null, '', {
      is_error: true,
      final_text: 'Not logged in · Please run /login',
      api_error: 'authentication_failed',
    })
    expect(err).toBeInstanceOf(provider_auth_error)
    expect(err.message).toBe('claude CLI reported an auth failure: Not logged in · Please run /login: run claude auth login')
    expect((err as provider_auth_error).refresh_command).toBe('claude auth login')
  })

  it('leaves any other stream error code to the later classifications', () => {
    const err = classify_close_error(1, null, '', {
      is_error: true,
      final_text: 'API Error: 529 overloaded',
      api_error: 'server_error',
    })
    expect((err as claude_cli_error).reason).toBe('subprocess_exit')
  })

  it('carries an error result\'s text when stderr is empty', () => {
    const err = classify_close_error(1, null, '', { is_error: true, final_text: 'API Error: 529 overloaded' })
    expect((err as claude_cli_error).reason).toBe('subprocess_exit')
    expect(err.message).toBe(`claude CLI exited with code 1: API Error: 529 overloaded${EXIT_ACTION}`)
    expect((err as claude_cli_error).stderr_snippet).toBe('')
  })

  it('prefers stderr over the error result\'s text', () => {
    const err = classify_close_error(1, null, 'boom', { is_error: true, final_text: 'reported' })
    expect(err.message).toBe(`claude CLI exited with code 1: boom${EXIT_ACTION}`)
  })

  it('leaves out the text of a run that reported no error', () => {
    const err = classify_close_error(1, null, '', { is_error: false, final_text: 'half an answer' })
    expect(err.message).toBe(`claude CLI exited with code 1: it printed no reason${EXIT_ACTION}`)
  })

  it('truncates the error result\'s text to 512 characters', () => {
    const err = classify_close_error(1, null, '', { is_error: true, final_text: 'y'.repeat(600) })
    expect(err.message).toBe(`claude CLI exited with code 1: ${'y'.repeat(512)}${EXIT_ACTION}`)
  })
})

describe('no_result_error', () => {
  const ACTION = ': retry the call, and if it happens again, run claude update, since an older CLI may not write one'

  it('says what to do when the CLI wrote nothing to stderr', () => {
    const err = no_result_error('')
    expect(err).toBeInstanceOf(claude_cli_error)
    expect(err.reason).toBe('no_result_event')
    expect(err.message).toBe(`claude CLI closed without emitting a terminal result event${ACTION}`)
    expect(err.stderr_snippet).toBe('')
  })

  it('treats whitespace on stderr as nothing said', () => {
    expect(no_result_error(' \n').message).toBe(
      `claude CLI closed without emitting a terminal result event${ACTION}`,
    )
  })

  it('puts what the CLI wrote to stderr before the action, trimmed, and keeps the snippet as it came', () => {
    const err = no_result_error('stream closed early\n')
    expect(err.message).toBe(
      `claude CLI closed without emitting a terminal result event: stream closed early${ACTION}`,
    )
    expect(err.stderr_snippet).toBe('stream closed early\n')
  })
})
