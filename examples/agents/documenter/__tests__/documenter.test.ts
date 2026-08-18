import { run } from 'fascicle'
import { make_capture_engine } from 'fascicle/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { documenter } from '../index.js'
import type { DocumenterOutput } from '../schema.js'

// Capture engine whose canned reply also round-trips the caller's schema, so
// invalid canned data rejects the run the way a real engine would.
function make_mock_engine(canned: unknown) {
  return make_capture_engine({
    result: {
      content: canned,
      tool_calls: [],
      steps: [],
      usage: { input_tokens: 1, output_tokens: 1 },
      finish_reason: 'stop',
      model_resolved: { provider: 'mock', model_id: 'doc' },
    },
    on_generate: async (opts) => {
      const checked = await opts.schema?.['~standard'].validate(canned)
      if (checked?.issues !== undefined) throw new Error('stub: canned response failed its schema')
    },
  })
}

const canned: DocumenterOutput = {
  doc: '/**\n * Example.\n */',
  inferred_purpose: 'Computes the sum of an array.',
}

describe('documenter', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
  })

  it('returns parsed { doc, inferred_purpose } from a structured engine result', async () => {
    const { engine } = make_mock_engine(canned)
    const agent = documenter({ engine })
    const result = await run(
      agent,
      {
        target: { kind: 'symbol', name: 'sum', signature: '(xs: number[]) => number' },
      },
      { install_signal_handlers: false },
    )
    expect(result).toEqual(canned)
  })

  it('formats a symbol target without a body', async () => {
    const { engine, calls } = make_mock_engine(canned)
    const agent = documenter({ engine })
    await run(
      agent,
      {
        target: { kind: 'symbol', name: 'sum', signature: '(xs: number[]) => number' },
      },
      { install_signal_handlers: false },
    )
    expect(calls[0]?.prompt).toBe(
      'Style: tsdoc\n\nSymbol: sum\nSignature: (xs: number[]) => number',
    )
  })

  it('appends the body block when the symbol target supplies one', async () => {
    const { engine, calls } = make_mock_engine(canned)
    const agent = documenter({ engine })
    await run(
      agent,
      {
        target: {
          kind: 'symbol',
          name: 'sum',
          signature: '(xs: number[]) => number',
          body: 'return xs.reduce((a, b) => a + b, 0);',
        },
        style: 'jsdoc',
      },
      { install_signal_handlers: false },
    )
    expect(calls[0]?.prompt).toBe(
      'Style: jsdoc\n\nSymbol: sum\nSignature: (xs: number[]) => number\n\nBody:\nreturn xs.reduce((a, b) => a + b, 0);',
    )
  })

  it('formats a file target with path and contents', async () => {
    const { engine, calls } = make_mock_engine(canned)
    const agent = documenter({ engine })
    await run(
      agent,
      {
        target: { kind: 'file', path: 'src/sum.ts', contents: 'export const sum = ...;' },
        style: 'markdown',
      },
      { install_signal_handlers: false },
    )
    expect(calls[0]?.prompt).toBe(
      'Style: markdown\n\nFile: src/sum.ts\n\nexport const sum = ...;',
    )
  })

  it('defaults to tsdoc when style is omitted', async () => {
    const { engine, calls } = make_mock_engine(canned)
    const agent = documenter({ engine })
    await run(
      agent,
      { target: { kind: 'file', path: 'a', contents: 'b' } },
      { install_signal_handlers: false },
    )
    const prompt = calls[0]?.prompt
    expect(typeof prompt).toBe('string')
    expect((prompt as string).startsWith('Style: tsdoc')).toBe(true)
  })

  it('uses "documenter" as the step id from frontmatter', async () => {
    const { engine } = make_mock_engine(canned)
    const agent = documenter({ engine })
    expect(agent.id).toBe('documenter')
  })

  it('honors a name override', async () => {
    const { engine } = make_mock_engine(canned)
    const agent = documenter({ engine, name: 'doc_writer' })
    expect(agent.id).toBe('doc_writer')
  })

  it('surfaces a schema validation error when the engine returns malformed output', async () => {
    const { engine } = make_mock_engine({ doc: 1, inferred_purpose: false })
    const agent = documenter({ engine })
    await expect(
      run(
        agent,
        { target: { kind: 'file', path: 'a', contents: 'b' } },
        { install_signal_handlers: false },
      ),
    ).rejects.toThrow()
  })
})
