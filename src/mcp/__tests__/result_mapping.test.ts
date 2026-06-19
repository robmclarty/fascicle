import { describe, expect, it } from 'vitest'
import { mcp_error } from '../errors.js'
import { call_result_to_output, output_to_call_result } from '../result_mapping.js'

describe('call_result_to_output', () => {
  it('prefers structuredContent over text', () => {
    const out = call_result_to_output({
      content: [{ type: 'text', text: 'ignored' }],
      structuredContent: { value: 5 },
    })
    expect(out).toEqual({ value: 5 })
  })

  it('joins all text parts when there is no structuredContent', () => {
    const out = call_result_to_output({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    })
    expect(out).toBe('line one\nline two')
  })

  it('returns raw content when there are no text parts', () => {
    const content = [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
    expect(call_result_to_output({ content })).toEqual(content)
  })

  it('throws mcp_error when the result is an error', () => {
    expect(() =>
      call_result_to_output(
        { content: [{ type: 'text', text: 'boom' }], isError: true },
        'do_thing',
      ),
    ).toThrow(mcp_error)
    try {
      call_result_to_output({ content: [{ type: 'text', text: 'boom' }], isError: true }, 'do_thing')
    } catch (err) {
      expect(err).toBeInstanceOf(mcp_error)
      expect((err as mcp_error).message).toBe('boom')
      expect((err as mcp_error).tool_name).toBe('do_thing')
    }
  })

  it('tolerates a non-record result', () => {
    expect(call_result_to_output(null)).toBeNull()
  })

  it('uses a default message when an error result has no text content', () => {
    try {
      call_result_to_output({ isError: true }, 'do_thing')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(mcp_error)
      expect((err as mcp_error).message).toBe('MCP tool returned an error')
    }
  })

  it('ignores content parts that are not text parts when joining', () => {
    // A text-typed part with a non-string body, a string-bodied part with the
    // wrong type, and a non-record part are all skipped, so join_text finds
    // nothing and the raw content array is returned unchanged.
    expect(call_result_to_output({ content: [{ type: 'text', text: 123 }] })).toEqual([
      { type: 'text', text: 123 },
    ])
    expect(call_result_to_output({ content: [{ type: 'image', text: 'hi' }] })).toEqual([
      { type: 'image', text: 'hi' },
    ])
    expect(call_result_to_output({ content: [{ foo: 1 }] })).toEqual([{ foo: 1 }])
  })
})

describe('output_to_call_result', () => {
  it('wraps a string as a single text part', () => {
    expect(output_to_call_result('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  })

  it('emits an object as text plus structuredContent', () => {
    const result = output_to_call_result({ a: 1 })
    expect(result.content).toEqual([{ type: 'text', text: '{"a":1}' }])
    expect(result.structuredContent).toEqual({ a: 1 })
  })

  it('emits an array as text only (no structuredContent)', () => {
    const result = output_to_call_result([1, 2])
    expect(result.content).toEqual([{ type: 'text', text: '[1,2]' }])
    expect(result.structuredContent).toBeUndefined()
  })

  it('stringifies primitives', () => {
    expect(output_to_call_result(42).content[0]?.text).toBe('42')
    expect(output_to_call_result(true).content[0]?.text).toBe('true')
    expect(output_to_call_result(null).content[0]?.text).toBe('null')
  })

  it('honors a custom to_result', () => {
    const result = output_to_call_result(
      { score: 9 },
      (o) => ({ text: `score=${o.score}`, structured: { score: o.score } }),
    )
    expect(result.content).toEqual([{ type: 'text', text: 'score=9' }])
    expect(result.structuredContent).toEqual({ score: 9 })
  })

  it('omits the structuredContent key entirely when there is no structured output', () => {
    expect('structuredContent' in output_to_call_result('hi')).toBe(false)
    expect('structuredContent' in output_to_call_result([1, 2])).toBe(false)
  })

  it('stringifies undefined via the String fallback', () => {
    expect(output_to_call_result(undefined).content[0]?.text).toBe('undefined')
  })

  it('falls back to String() when JSON serialization throws', () => {
    // A bigint cannot be JSON.stringify-ed, so the catch path must produce the
    // String() form rather than leaving the text undefined.
    expect(output_to_call_result({ n: 10n }).content[0]?.text).toBe('[object Object]')
  })
})
