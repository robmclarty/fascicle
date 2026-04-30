import { describe as vdescribe, expect, it } from 'vitest';
import { aborted_error, describe, run } from '@repo/core';
import type { RunContext } from '@repo/core';
import type { Engine, GenerateOptions, GenerateResult, StreamChunk } from '@repo/engine';
import { model_call } from '../model_call.js';

function make_result(content: string): GenerateResult {
  return {
    content,
    tool_calls: [],
    steps: [],
    usage: { input_tokens: 1, output_tokens: 1 },
    finish_reason: 'stop',
    model_resolved: { provider: 'mock', model_id: 'x' },
  };
}

type MockEngineOptions = {
  readonly on_generate?: (opts: GenerateOptions) => Promise<void> | void;
  readonly result?: GenerateResult;
};

type CapturedCall = {
  readonly opts: GenerateOptions;
  readonly had_on_chunk: boolean;
};

function make_mock_engine(options: MockEngineOptions = {}): {
  engine: Engine;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const result = options.result ?? make_result('ok');
  const engine: Engine = {
    generate: async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      calls.push({ opts: opts as GenerateOptions, had_on_chunk: typeof opts.on_chunk === 'function' });
      if (options.on_generate) await options.on_generate(opts as GenerateOptions);
      return result as unknown as GenerateResult<t>;
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'mock', model_id: 'x' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  };
  return { engine, calls };
}

vdescribe('model_call', () => {
  it('happy path: runs the engine and returns the canned result', async () => {
    const { engine, calls } = make_mock_engine({ result: make_result('hello') });
    const s = model_call({ engine, model: 'x' });
    expect(s.kind).toBe('step');
    expect(s.id.startsWith('model_call')).toBe(true);
    const result = await run(s, 'hi', { install_signal_handlers: false });
    expect(result.content).toBe('hello');
    expect(calls.length).toBe(1);
    expect(calls[0]?.opts.abort).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.opts.trajectory).toBeDefined();
    expect(calls[0]?.had_on_chunk).toBe(false);
  });

  it('default id is a stable hash over { model, system, has_tools, has_schema }', () => {
    const { engine } = make_mock_engine();
    const a1 = model_call({ engine, model: 'x' });
    const a2 = model_call({ engine, model: 'x' });
    expect(a1.id).toBe(a2.id);
    const b = model_call({ engine, model: 'y' });
    expect(b.id).not.toBe(a1.id);
    const with_system = model_call({ engine, model: 'x', system: 'be brief' });
    expect(with_system.id).not.toBe(a1.id);
  });

  it('normalizes string input to a user message and leaves arrays unchanged', async () => {
    const { engine, calls } = make_mock_engine();
    const s = model_call({ engine, model: 'x' });
    await run(s, 'hi there', { install_signal_handlers: false });
    const first = calls[0]?.opts.prompt;
    expect(Array.isArray(first)).toBe(true);
    expect(first).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi there' }] },
    ]);

    calls.length = 0;
    const pre = [
      { role: 'system' as const, content: 'be brief' },
      { role: 'user' as const, content: 'expand' },
    ];
    await run(s, pre, { install_signal_handlers: false });
    expect(calls[0]?.opts.prompt).toEqual(pre);
  });

  it('explicit cfg.id overrides the default id', () => {
    const { engine } = make_mock_engine();
    const b = model_call({ engine, model: 'x', id: 'generate_plan' });
    expect(b.id).toBe('generate_plan');
  });

  it('raises aborted_error before engine.generate when ctx.abort is pre-aborted', async () => {
    const { engine, calls } = make_mock_engine();
    const s = model_call({ engine, model: 'x' });
    const controller = new AbortController();
    controller.abort();
    const logger = {
      record: () => {},
      start_span: () => 'span',
      end_span: () => {},
    };
    const ctx: RunContext = {
      run_id: 'rid',
      trajectory: logger,
      state: new Map<string, unknown>(),
      abort: controller.signal,
      emit: () => {},
      on_cleanup: () => {},
      streaming: false,
    };
    await expect(s.run('hi', ctx)).rejects.toBeInstanceOf(aborted_error);
    expect(calls.length).toBe(0);
  });

  it('propagates abort mid-call and the engine receives the signal', async () => {
    let observed_abort: AbortSignal | undefined;
    const { engine } = make_mock_engine({
      on_generate: async (opts) => {
        observed_abort = opts.abort;
        await new Promise<void>((resolve, reject) => {
          const err = new aborted_error('aborted', { reason: { signal: 'abort' } });
          if (opts.abort?.aborted) return reject(err);
          opts.abort?.addEventListener(
            'abort',
            () => {
              reject(err);
            },
            { once: true },
          );
        });
      },
    });
    const s = model_call({ engine, model: 'x' });
    const controller = new AbortController();
    const logger = {
      record: () => {},
      start_span: () => 'span',
      end_span: () => {},
    };
    const ctx: RunContext = {
      run_id: 'rid',
      trajectory: logger,
      state: new Map<string, unknown>(),
      abort: controller.signal,
      emit: () => {},
      on_cleanup: () => {},
      streaming: false,
    };
    const pending = s.run('hi', ctx);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toBeInstanceOf(aborted_error);
    expect(observed_abort).toBeDefined();
    expect(observed_abort?.aborted).toBe(true);
  });

  it('streaming parity: run and run.stream yield identical GenerateResult', async () => {
    const canned = make_result('stream_result');
    const plain = make_mock_engine({ result: canned });
    const streamed = make_mock_engine({
      result: canned,
      on_generate: async (opts) => {
        if (opts.on_chunk) {
          const chunk: StreamChunk = { kind: 'text', text: 'hi', step_index: 0 };
          await opts.on_chunk(chunk);
        }
      },
    });

    const plain_step = model_call({ engine: plain.engine, model: 'x' });
    const streamed_step = model_call({ engine: streamed.engine, model: 'x' });

    const plain_result = await run(plain_step, 'hi', { install_signal_handlers: false });
    const stream_handle = run.stream(streamed_step, 'hi', { install_signal_handlers: false });
    const events: unknown[] = [];
    const consume = (async () => {
      for await (const e of stream_handle.events) events.push(e);
    })();
    const stream_result = await stream_handle.result;
    await consume;

    expect(stream_result).toEqual(plain_result);
    expect(plain.calls[0]?.had_on_chunk).toBe(false);
    expect(streamed.calls[0]?.had_on_chunk).toBe(true);
    const emitted = events.filter(
      (e): e is { kind: 'emit'; step_id?: string } =>
        typeof e === 'object' && (e as { kind?: string } | null)?.kind === 'emit',
    );
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('describe surfaces model config and omits the raw engine object', () => {
    const { engine } = make_mock_engine();
    const s = model_call({ engine, model: 'cli-sonnet', system: 'be careful' });
    const text = describe(s);
    expect(text).toContain('model_call');
    expect(text).toContain('"cli-sonnet"');
    expect(text).toContain('"be careful"');
    expect(text).not.toContain('[object Object]');
    const json = describe.json(s);
    const cfg = json.config as Record<string, unknown>;
    expect(cfg['model']).toBe('cli-sonnet');
    expect(cfg['system']).toBe('be careful');
    expect(cfg['has_tools']).toBe(false);
    expect(cfg['has_schema']).toBe(false);
    expect('engine' in cfg).toBe(false);
  });

  it('does not mutate cfg', async () => {
    const { engine } = make_mock_engine();
    const cfg = Object.freeze({ engine, model: 'x', system: 'fixed' });
    const s = model_call(cfg);
    await run(s, 'hi', { install_signal_handlers: false });
    expect(cfg.model).toBe('x');
    expect(cfg.system).toBe('fixed');
  });
});
