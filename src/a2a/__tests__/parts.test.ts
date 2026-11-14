import { describe, expect, it } from 'vitest'
import type { Part } from '@a2a-js/sdk'
import { data_of, data_part, files_of, from_plain, output_parts, text_of, text_part, to_plain } from '../parts.js'

const raw_part: Part = {
  content: { $case: 'raw', value: Buffer.from('bytes') },
  metadata: undefined,
  filename: 'notes.bin',
  mediaType: 'application/octet-stream',
}
const url_part: Part = {
  content: { $case: 'url', value: 'https://example.test/report.pdf' },
  metadata: undefined,
  filename: 'report.pdf',
  mediaType: 'application/pdf',
}

describe('part builders', () => {
  it('builds a text part and a data part with their media types', () => {
    expect(text_part('hi')).toEqual({
      content: { $case: 'text', value: 'hi' },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    })
    expect(data_part({ n: 1 })).toEqual({
      content: { $case: 'data', value: { n: 1 } },
      metadata: undefined,
      filename: '',
      mediaType: 'application/json',
    })
  })

  it('turns an output into parts: a string as text, nothing as nothing, anything else as data', () => {
    expect(output_parts('done')).toEqual([text_part('done')])
    expect(output_parts(undefined)).toEqual([])
    expect(output_parts(null)).toEqual([])
    expect(output_parts({ ok: true })).toEqual([data_part({ ok: true })])
    expect(output_parts(0)).toEqual([data_part(0)])
    expect(output_parts(false)).toEqual([data_part(false)])
  })
})

describe('part readers', () => {
  const parts = [text_part('one'), data_part({ a: 1 }), raw_part, text_part('two'), url_part, data_part([2])]

  it('joins the text parts, with a separator when given one', () => {
    expect(text_of(parts)).toBe('onetwo')
    expect(text_of(parts, '\n')).toBe('one\ntwo')
    expect(text_of([data_part(1)])).toBe('')
  })

  it('reads the data parts in order', () => {
    expect(data_of(parts)).toEqual([{ a: 1 }, [2]])
    expect(data_of([text_part('x')])).toEqual([])
  })

  it('reads the file parts as sent, with bytes as base64 and a url as a url', () => {
    expect(files_of(parts)).toEqual([
      { filename: 'notes.bin', media_type: 'application/octet-stream', base64: Buffer.from('bytes').toString('base64') },
      { filename: 'report.pdf', media_type: 'application/pdf', url: 'https://example.test/report.pdf' },
    ])
    expect(files_of([text_part('x'), data_part(1)])).toEqual([])
  })

  it('skips a part with no content', () => {
    const empty: Part = { content: undefined, metadata: undefined, filename: '', mediaType: '' }
    expect(text_of([empty])).toBe('')
    expect(data_of([empty])).toEqual([])
    expect(files_of([empty])).toEqual([])
  })
})

describe('to_plain and from_plain', () => {
  it('carries bytes through JSON, wherever they sit', () => {
    const value = { parts: [raw_part, text_part('t')], nested: { bytes: new Uint8Array([1, 2, 3]) }, n: 1, none: null }
    const plain = to_plain(value)
    expect(JSON.stringify(plain)).toContain(`{"$bytes":"${Buffer.from('bytes').toString('base64')}"}`)
    const back = from_plain(JSON.parse(JSON.stringify(plain))) as typeof value
    expect(back.parts[0]?.content).toEqual({ $case: 'raw', value: Buffer.from('bytes') })
    expect(Buffer.isBuffer(back.nested.bytes)).toBe(true)
    expect([...back.nested.bytes]).toEqual([1, 2, 3])
    expect(back.parts[1]).toEqual(JSON.parse(JSON.stringify(text_part('t'))))
    expect(back.n).toBe(1)
    expect(back.none).toBeNull()
  })

  it('leaves primitives alone', () => {
    for (const value of ['text', 3, true, null, undefined]) {
      expect(to_plain(value)).toBe(value)
      expect(from_plain(value)).toBe(value)
    }
  })

  it('reads an object that only looks like bytes as an object', () => {
    expect(from_plain({ $bytes: 'aGk=', other: 1 })).toEqual({ $bytes: 'aGk=', other: 1 })
    expect(from_plain({ $bytes: 7 })).toEqual({ $bytes: 7 })
    expect(from_plain({ $bytes: 'aGk=' })).toEqual(Buffer.from('hi'))
  })
})
