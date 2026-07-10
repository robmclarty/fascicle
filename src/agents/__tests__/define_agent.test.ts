import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aborted_error, run } from '#core'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import type { Engine, GenerateOptions, GenerateResult } from '#engine'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { define_agent } from '../define_agent.js'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = []
  let id = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: (name, meta) => {
      id += 1
      const span_id = `span_${id}`
      events.push({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta })
    },
  }
  return { logger, events }
}

type CapturedCall = {
  readonly opts: GenerateOptions<unknown>
}

function make_mock_engine(
  canned: unknown,
  provider = 'mock',
  model_id = 'x',
): {
  engine: Engine
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const engine: Engine = {
    generate: async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      calls.push({ opts: opts })
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: canned as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 7, output_tokens: 11 },
        finish_reason: 'stop',
        model_resolved: { provider, model_id },
      }
    },
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }
  return { engine, calls }
}

async function with_tmp_md(
  body: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'define-agent-'))
  const path = join(dir, 'prompt.md')
  await writeFile(path, body)
  try {
    await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('define_agent', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
  })

  it('parses frontmatter and substitutes {{name}} placeholders into the user prompt', async () => {
    await with_tmp_md(
      [
        '---',
        'name: greeter',
        'description: greets',
        'model: gpt-test',
        'temperature: 0.25',
        '---',
        '',
        'Say hi to {{who}} about {{topic}}.',
      ].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ greeting: 'hi' })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ greeting: z.string() }),
          engine,
        })
      
        expect(agent.id).toBe('greeter')
      
        const result = await run(
          agent,
          { who: 'world', topic: 'launch' },
          { install_signal_handlers: false },
        )
        expect(result).toEqual({ greeting: 'hi' })
        expect(calls.length).toBe(1)
        expect(calls[0]?.opts.prompt).toBe('Say hi to world about launch.')
        expect(calls[0]?.opts.system).toBeUndefined()
        expect(calls[0]?.opts.model).toBe('gpt-test')
        expect(calls[0]?.opts.temperature).toBe(0.25)
        expect(calls[0]?.opts.schema).toBeDefined()
        expect(calls[0]?.opts.abort).toBeInstanceOf(AbortSignal)
        expect(calls[0]?.opts.trajectory).toBeDefined()
      },
    )
  })

  it('leaves placeholders unmatched when the input field is missing or non-string', async () => {
    await with_tmp_md(
      [
        '---',
        'name: keep',
        '---',
        '',
        'a={{a}} b={{b}} c={{c}}',
      ].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, { a: 'x', b: 42 }, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('a=x b={{b}} c={{c}}')
      },
    )
  })

  it('build_prompt returning a string overrides body and treats body as system', async () => {
    await with_tmp_md(
      [
        '---',
        'name: reviewer',
        '---',
        '',
        'You are a code reviewer.',
      ].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent<{ diff: string }, { ok: boolean }>({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
          build_prompt: (input) => `Diff:\n${input.diff}`,
        })
        await run(agent, { diff: '+++ a\n--- b' }, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('Diff:\n+++ a\n--- b')
        expect(calls[0]?.opts.system).toBe('You are a code reviewer.')
      },
    )
  })

  it('build_prompt returning { user, system } overrides both', async () => {
    await with_tmp_md(
      [
        '---',
        'name: r2',
        '---',
        '',
        'Default system.',
      ].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent<{ x: number }, { ok: boolean }>({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
          build_prompt: () => ({ user: 'U', system: 'S' }),
        })
        await run(agent, { x: 1 }, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('U')
        expect(calls[0]?.opts.system).toBe('S')
      },
    )
  })

  it('build_prompt returning { user } without system falls back to body', async () => {
    await with_tmp_md(
      [
        '---',
        'name: r3',
        '---',
        '',
        'Body system.',
      ].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent<{ x: number }, { ok: boolean }>({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
          build_prompt: () => ({ user: 'U' }),
        })
        await run(agent, { x: 1 }, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('U')
        expect(calls[0]?.opts.system).toBe('Body system.')
      },
    )
  })

  it('config.name overrides frontmatter name', async () => {
    await with_tmp_md(
      [
        '---',
        'name: from_md',
        '---',
        '',
        'body',
      ].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
          name: 'override',
        })
        expect(agent.id).toBe('override')
      },
    )
  })

  it('records an agent.call trajectory event with name, model, and usage', async () => {
    await with_tmp_md(
      [
        '---',
        'name: traced',
        '---',
        '',
        'body',
      ].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true }, 'anthropic', 'sonnet')
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        const { logger, events } = recording_logger()
        await run(agent, { ignored: true }, {
          trajectory: logger,
          install_signal_handlers: false,
        })
        const call = events.find((e) => e.kind === 'agent.call')
        expect(call).toBeDefined()
        expect(call?.['name']).toBe('traced')
        expect(call?.['model']).toBe('anthropic:sonnet')
        expect(call?.['usage']).toEqual({ input_tokens: 7, output_tokens: 11 })
      },
    )
  })

  it('throws at factory time when frontmatter is malformed (missing close)', async () => {
    await with_tmp_md(
      [
        '---',
        'name: bad',
        '',
        'no close marker',
      ].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        expect(() =>
          define_agent({
            md_path: path,
            schema: z.object({ ok: z.boolean() }),
            engine,
          }),
        ).toThrow(/malformed frontmatter/)
      },
    )
  })

  it('throws at factory time when temperature is not numeric', async () => {
    await with_tmp_md(
      [
        '---',
        'name: bad',
        'temperature: hot',
        '---',
        '',
        'body',
      ].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        expect(() =>
          define_agent({
            md_path: path,
            schema: z.object({ ok: z.boolean() }),
            engine,
          }),
        ).toThrow(/temperature/)
      },
    )
  })

  it('accepts md_path as a URL constructed from import.meta.url', async () => {
    await with_tmp_md(
      [
        '---',
        'name: url_form',
        '---',
        '',
        'urls work too',
      ].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: new URL(`file://${path}`),
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('urls work too')
      },
    )
  })

  it('handles a markdown file with no frontmatter (whole file is body)', async () => {
    await with_tmp_md('hello world {{name}}', async (path) => {
      const { engine, calls } = make_mock_engine({ ok: true })
      const agent = define_agent({
        md_path: path,
        schema: z.object({ ok: z.boolean() }),
        engine,
      })
      expect(agent.id).toBe('agent')
      await run(agent, { name: 'thing' }, { install_signal_handlers: false })
      expect(calls[0]?.opts.prompt).toBe('hello world thing')
    })
  })

  it('unquotes double-quoted frontmatter values', async () => {
    await with_tmp_md(
      ['---', 'name: "Bot"', 'model: "m-1"', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('Bot')
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.model).toBe('m-1')
      },
    )
  })

  it('unquotes single-quoted frontmatter values', async () => {
    await with_tmp_md(
      ['---', "model: 'm-2'", '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.model).toBe('m-2')
      },
    )
  })

  it('treats an empty quote pair as an empty value, not the literal quotes', async () => {
    await with_tmp_md(
      ['---', 'model: ""', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.model).toBe('')
      },
    )
  })

  it('leaves a value with a single unmatched quote untouched', async () => {
    await with_tmp_md(
      ['---', 'model: "oops', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.model).toBe('"oops')
      },
    )
  })

  it('skips comment and whitespace-only lines inside frontmatter', async () => {
    await with_tmp_md(
      ['---', '# a comment', '   ', 'name: commented', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('commented')
      },
    )
  })

  it('trims surrounding whitespace from frontmatter lines', async () => {
    await with_tmp_md(
      ['---', '  name: padded  ', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('padded')
      },
    )
  })

  it('throws when a frontmatter line has no colon', async () => {
    await with_tmp_md(
      ['---', 'name: ok', 'garbage-no-colon', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        expect(() =>
          define_agent({
            md_path: path,
            schema: z.object({ ok: z.boolean() }),
            engine,
          }),
        ).toThrow(/malformed frontmatter line/)
      },
    )
  })

  it('does not parse --- that is not at the very start of the file', async () => {
    const content = ['preamble line', '---', 'name: should_not_parse', '---', 'tail'].join('\n')
    await with_tmp_md(content, async (path) => {
      const { engine, calls } = make_mock_engine({ ok: true })
      const agent = define_agent({
        md_path: path,
        schema: z.object({ ok: z.boolean() }),
        engine,
      })
      expect(agent.id).toBe('agent')
      await run(agent, {}, { install_signal_handlers: false })
      expect(calls[0]?.opts.prompt).toBe(content)
    })
  })

  it('matches an opening --- followed by trailing spaces before the newline', async () => {
    await with_tmp_md(
      ['---   ', 'name: spaced_open', '---', '', 'body'].join('\n'),
      async (path) => {
        const { engine } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('spaced_open')
      },
    )
  })

  it('requires the closing --- to occupy its whole line (a --- prefix with a colon is frontmatter)', async () => {
    await with_tmp_md(
      ['---', '---: ignored', 'name: after_dashes', '---', '', 'real body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('after_dashes')
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('real body')
      },
    )
  })

  it('does not treat a --- at the end of a value line as the closing marker', async () => {
    await with_tmp_md(
      ['---', 'model: a---', '---', '', 'real body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('real body')
        expect(calls[0]?.opts.model).toBe('a---')
      },
    )
  })

  it('parses a closing --- immediately followed by the body (no blank line)', async () => {
    await with_tmp_md(
      ['---', 'name: tight', '---', 'tight body'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('tight')
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('tight body')
      },
    )
  })

  it('accepts md_path as a file:// string, not only a URL object', async () => {
    await with_tmp_md(
      ['---', 'name: str_url', '---', '', 'from string url'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: `file://${path}`,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        expect(agent.id).toBe('str_url')
        await run(agent, {}, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('from string url')
      },
    )
  })

  it('returns the body unchanged when substituting against a null input', async () => {
    await with_tmp_md(
      ['---', 'name: nul', '---', '', 'hello {{x}}'].join('\n'),
      async (path) => {
        const { engine, calls } = make_mock_engine({ ok: true })
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        await run(agent, null, { install_signal_handlers: false })
        expect(calls[0]?.opts.prompt).toBe('hello {{x}}')
      },
    )
  })

  it('omits opts.system when the resolved system prompt is an empty string', async () => {
    await with_tmp_md(['---', 'name: empty_sys', '---', ''].join('\n'), async (path) => {
      const { engine, calls } = make_mock_engine({ ok: true })
      const agent = define_agent<{ x: number }, { ok: boolean }>({
        md_path: path,
        schema: z.object({ ok: z.boolean() }),
        engine,
        build_prompt: () => ({ user: 'U' }),
      })
      await run(agent, { x: 1 }, { install_signal_handlers: false })
      expect(calls[0]?.opts.prompt).toBe('U')
      expect('system' in (calls[0]?.opts ?? {})).toBe(false)
    })
  })

  it('does not set opts.model or opts.temperature when frontmatter omits them', async () => {
    await with_tmp_md(['---', 'name: minimal', '---', '', 'body'].join('\n'), async (path) => {
      const { engine, calls } = make_mock_engine({ ok: true })
      const agent = define_agent({
        md_path: path,
        schema: z.object({ ok: z.boolean() }),
        engine,
      })
      await run(agent, {}, { install_signal_handlers: false })
      expect('model' in (calls[0]?.opts ?? {})).toBe(false)
      expect('temperature' in (calls[0]?.opts ?? {})).toBe(false)
    })
  })

  it('threads ctx.abort into engine.generate so SIGINT cancels in-flight calls', async () => {
    await with_tmp_md(
      [
        '---',
        'name: cancellable',
        '---',
        '',
        'body',
      ].join('\n'),
      async (path) => {
        let abort_signal: AbortSignal | undefined
        const engine: Engine = {
          generate: async <t = string>(
            opts: GenerateOptions<t>,
          ): Promise<GenerateResult<t>> => {
            abort_signal = opts.abort
            await new Promise<void>((_resolve, reject) => {
              if (opts.abort?.aborted) {
                reject(new Error('aborted'))
                return
              }
              opts.abort?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              )
            })
            throw new Error('unreachable')
          },
          register_price: () => {},
          resolve_price: () => undefined,
          list_prices: () => ({}),
          dispose: async () => {},
        }
        const agent = define_agent({
          md_path: path,
          schema: z.object({ ok: z.boolean() }),
          engine,
        })
        const pending = run(agent, {})
        await wait(20)
        expect(abort_signal).toBeInstanceOf(AbortSignal)
        process.emit('SIGINT')
        await expect(pending).rejects.toBeInstanceOf(aborted_error)
      },
    )
  })
})
