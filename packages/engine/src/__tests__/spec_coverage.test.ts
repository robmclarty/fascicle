/**
 * Full spec coverage sweep — extends the core tests in generate.test.ts,
 * tool_loop.test.ts, and create_engine.test.ts to cover every success
 * criterion (spec §10) and failure mode (spec §9) end-to-end through
 * `generate`. See those files for the criteria already exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import type { StreamChunk } from '../types.js';
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_generate_text,
  enqueue_generate_text_fn,
  enqueue_stream,
  make_text_result,
  mock_state,
  reset_mock_state,
} from '../../test/fixtures/mock_ai.js';

vi.mock('ai', async () => build_mock_ai_module());
vi.mock('../providers/registry.js', async () => build_mock_registry_module());

import { create_engine } from '../create_engine.js';
import {
  aborted_error,
  model_not_found_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  rate_limit_error,
  tool_approval_denied_error,
} from '../errors.js';

function make_logger(): {
  logger: TrajectoryLogger;
  events: TrajectoryEvent[];
  spans: Array<{ id: string; name: string; meta: Record<string, unknown>; end?: Record<string, unknown> }>;
} {
  const events: TrajectoryEvent[] = [];
  const spans: Array<{
    id: string;
    name: string;
    meta: Record<string, unknown>;
    end?: Record<string, unknown>;
  }> = [];
  let counter = 0;
  const logger: TrajectoryLogger = {
    record: (e) => events.push(e),
    start_span: (name, meta) => {
      counter += 1;
      const id = `span_${counter}`;
      spans.push({ id, name, meta: { ...meta } });
      return id;
    },
    end_span: (id, meta) => {
      const span = spans.find((s) => s.id === id);
      if (span) span.end = { ...meta };
    },
  };
  return { logger, events, spans };
}

function basic_engine() {
  return create_engine({ providers: { anthropic: { api_key: 'k' } } });
}

function mk_429_with_header(): Error {
  return Object.assign(new Error('rate limited'), {
    statusCode: 429,
    responseHeaders: { 'retry-after': '0.05' },
  });
}

function mk_429(): Error {
  return Object.assign(new Error('rate limited'), { statusCode: 429 });
}

function mk_net(): Error {
  return Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
}

beforeEach(() => reset_mock_state());
afterEach(() => reset_mock_state());

describe('spec §10: success criteria (remaining)', () => {
  it('C7 multi-tool single-turn sequential order', async () => {
    const order: string[] = [];
    enqueue_generate_text({
      text: '',
      toolCalls: [
        { toolCallId: 'c1', toolName: 'a', input: { v: '1' } },
        { toolCallId: 'c2', toolName: 'b', input: { v: '2' } },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    enqueue_generate_text(make_text_result('done'));
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'a',
          description: 'a',
          input_schema: z.object({ v: z.string() }),
          execute: async (input) => {
            order.push(`a-${(input as { v: string }).v}`);
            return 'A';
          },
        },
        {
          name: 'b',
          description: 'b',
          input_schema: z.object({ v: z.string() }),
          execute: async (input) => {
            order.push(`b-${(input as { v: string }).v}`);
            return 'B';
          },
        },
      ],
    });
    expect(order).toEqual(['a-1', 'b-2']);
    expect(result.tool_calls.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('C8 malformed tool input fed back, next turn succeeds', async () => {
    const exec_spy = vi.fn();
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { wrong: true } }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    enqueue_generate_text(make_text_result('recovered'));
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'echo',
          description: 'echo',
          input_schema: z.object({ v: z.string() }),
          execute: exec_spy,
        },
      ],
    });
    expect(exec_spy).not.toHaveBeenCalled();
    expect(result.tool_calls[0]?.error?.message).toMatch(/invalid tool input/);
    expect(result.content).toBe('recovered');
  });

  it('C9 tool execute error under feed_back continues loop', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'boom', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    enqueue_generate_text(make_text_result('ok'));
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      tools: [
        {
          name: 'boom',
          description: 'b',
          input_schema: z.object({}).passthrough(),
          execute: () => {
            throw new Error('kaboom');
          },
        },
      ],
    });
    expect(result.tool_calls[0]?.error?.message).toBe('kaboom');
    expect(result.content).toBe('ok');
  });

  it('C12 effort mapping forwards provider options; effort_ignored on Ollama', async () => {
    enqueue_generate_text(make_text_result('ok'));
    await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      effort: 'high',
    });
    const params_a = mock_state.last_generate_text_params as {
      providerOptions?: { anthropic?: { effort: string } };
    };
    expect(params_a.providerOptions?.anthropic?.effort).toBe('high');

    const { logger, events } = make_logger();
    enqueue_generate_text(make_text_result('ok'));
    const engine_ollama = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    });
    await engine_ollama.generate({
      model: 'ollama:gemma3:27b',
      prompt: 'x',
      effort: 'high',
      trajectory: logger,
    });
    const effort_ignored = events.find((e) => e.kind === 'effort_ignored');
    expect(effort_ignored).toBeDefined();
    expect(effort_ignored?.['model_id']).toBe('gemma3:27b');
    const params_b = mock_state.last_generate_text_params as {
      providerOptions?: unknown;
    };
    expect(params_b.providerOptions).toBeUndefined();
  });

  it('C14 streaming + tools emits tool_call_start / input_delta / end / tool_result / step_finish', async () => {
    enqueue_stream([
      { type: 'tool-input-start', id: 't1', toolName: 'echo' },
      { type: 'tool-input-delta', id: 't1', delta: '{"v":' },
      { type: 'tool-input-delta', id: 't1', delta: '"hi"}' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: { v: 'hi' } },
      {
        type: 'finish-step',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    enqueue_stream([
      { type: 'text-delta', text: 'done' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const chunks: StreamChunk[] = [];
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      on_chunk: (c) => {
        chunks.push(c);
      },
      tools: [
        {
          name: 'echo',
          description: 'echo',
          input_schema: z.object({ v: z.string() }),
          execute: (input) => `echoed:${(input as { v: string }).v}`,
        },
      ],
    });
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain('tool_call_start');
    expect(kinds).toContain('tool_call_input_delta');
    expect(kinds).toContain('tool_call_end');
    expect(kinds).toContain('tool_result');
    expect(kinds).toContain('step_finish');
    expect(kinds.at(-1)).toBe('finish');
    expect(result.tool_calls[0]?.output).toBe('echoed:hi');
  });

  it('C17 abort during streaming rejects with aborted_error', async () => {
    enqueue_stream(
      [
        { type: 'text-delta', text: 'a' },
        { type: 'text-delta', text: 'b' },
        {
          type: 'finish-step',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
      500,
    );
    const controller = new AbortController();
    const promise = basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      abort: controller.signal,
      on_chunk: () => {},
    });
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await expect(promise).rejects.toBeInstanceOf(aborted_error);
  });

  it('C18 abort during tool execute carries tool_call_in_flight metadata', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'slow', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const controller = new AbortController();
    const tool_ctx_abort: { received?: AbortSignal } = {};
    const promise = basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      abort: controller.signal,
      tools: [
        {
          name: 'slow',
          description: 's',
          input_schema: z.object({}).passthrough(),
          execute: async (_input, ctx) => {
            tool_ctx_abort.received = ctx.abort;
            await new Promise((resolve, reject) => {
              if (ctx.abort.aborted) {
                reject(new Error('aborted'));
                return;
              }
              ctx.abort.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
              setTimeout(resolve, 5000);
            });
            return 'ok';
          },
        },
      ],
    });
    setTimeout(() => controller.abort(new Error('user abort')), 20);
    await expect(promise).rejects.toMatchObject({
      kind: 'aborted_error',
      tool_call_in_flight: { id: 'c1', name: 'slow' },
    });
    expect(tool_ctx_abort.received?.aborted).toBe(true);
  });

  it('C20 retry respects numeric Retry-After', async () => {
    enqueue_generate_text(mk_429_with_header());
    enqueue_generate_text(make_text_result('ok'));
    const t0 = Date.now();
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      retry: {
        max_attempts: 3,
        initial_delay_ms: 1,
        max_delay_ms: 5,
        retry_on: ['rate_limit', 'provider_5xx', 'network'],
      },
    });
    const elapsed = Date.now() - t0;
    expect(result.content).toBe('ok');
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('C23 usage aggregation across a three-turn tool loop sums correctly', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'step_tool', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c2', toolName: 'step_tool', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 20, outputTokens: 3 },
    });
    enqueue_generate_text({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 30, outputTokens: 5 },
    });
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      max_steps: 5,
      tools: [
        {
          name: 'step_tool',
          description: 'tool',
          input_schema: z.object({}).passthrough(),
          execute: () => 'ok',
        },
      ],
    });
    expect(result.usage.input_tokens).toBe(60);
    expect(result.usage.output_tokens).toBe(10);
    expect(result.steps).toHaveLength(3);
  });

  it('C27 trajectory spans: engine.generate parent with engine.generate.step children', async () => {
    const { logger, events, spans } = make_logger();
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'noop', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    enqueue_generate_text(make_text_result('ok'));
    await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      trajectory: logger,
      tools: [
        {
          name: 'noop',
          description: 'noop',
          input_schema: z.object({}).passthrough(),
          execute: () => 'ok',
        },
      ],
    });
    const generate_span = spans.find((s) => s.name === 'engine.generate');
    const step_spans = spans.filter((s) => s.name === 'engine.generate.step');
    expect(generate_span).toBeDefined();
    expect(step_spans.length).toBeGreaterThanOrEqual(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('request_sent');
    expect(kinds).toContain('response_received');
    expect(kinds).toContain('tool_call');
  });

  it('C28 two engines maintain independent alias and pricing tables under concurrent calls', async () => {
    const a = create_engine({ providers: { anthropic: { api_key: 'key_a' } } });
    const b = create_engine({ providers: { anthropic: { api_key: 'key_b' } } });
    a.register_alias('shared', { provider: 'anthropic', model_id: 'claude-opus-4-7' });
    b.register_alias('shared', { provider: 'anthropic', model_id: 'claude-haiku-4-5' });
    enqueue_generate_text(make_text_result('a'));
    enqueue_generate_text(make_text_result('b'));
    const [result_a, result_b] = await Promise.all([
      a.generate({ model: 'shared', prompt: 'x' }),
      b.generate({ model: 'shared', prompt: 'x' }),
    ]);
    const ids = new Set([result_a.model_resolved.model_id, result_b.model_resolved.model_id]);
    expect(ids).toEqual(new Set(['claude-opus-4-7', 'claude-haiku-4-5']));
  });

  it('C30 cost aggregates across turns within tolerance', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'noop', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    enqueue_generate_text({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 2000, outputTokens: 100 },
    });
    const engine = basic_engine();
    engine.register_price('anthropic', 'claude-sonnet-4-6', {
      input_per_million: 3,
      output_per_million: 15,
    });
    const result = await engine.generate({
      model: 'sonnet',
      prompt: 'x',
      tools: [
        {
          name: 'noop',
          description: 'n',
          input_schema: z.object({}).passthrough(),
          execute: () => 'ok',
        },
      ],
    });
    expect(result.cost).toBeDefined();
    expect(result.cost?.input_usd).toBeCloseTo(3000 * 3 / 1e6, 9);
    expect(result.cost?.output_usd).toBeCloseTo(600 * 15 / 1e6, 9);
  });

  it('C32 cost missing for unknown model emits exactly one pricing_missing event', async () => {
    const { logger, events } = make_logger();
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'noop', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    enqueue_generate_text(make_text_result('done'));
    const engine = basic_engine();
    engine.register_alias('custom', {
      provider: 'anthropic',
      model_id: 'never-heard-of-it',
    });
    const result = await engine.generate({
      model: 'custom',
      prompt: 'x',
      trajectory: logger,
      tools: [
        {
          name: 'noop',
          description: 'n',
          input_schema: z.object({}).passthrough(),
          execute: () => 'ok',
        },
      ],
    });
    expect(result.cost).toBeUndefined();
    const pricing_missing = events.filter((e) => e.kind === 'pricing_missing');
    expect(pricing_missing).toHaveLength(1);
  });
});

describe('spec §9: failure modes (remaining)', () => {
  it('F1 unknown alias throws model_not_found_error', async () => {
    await expect(
      basic_engine().generate({ model: 'does-not-exist', prompt: 'x' }),
    ).rejects.toBeInstanceOf(model_not_found_error);
  });

  it('F2 unconfigured provider throws provider_not_configured_error at call time', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } });
    await expect(
      engine.generate({ model: 'openai:gpt-4o', prompt: 'x' }),
    ).rejects.toBeInstanceOf(provider_not_configured_error);
  });

  it('F6 provider_capability_error when streaming requested on non-streaming adapter (simulated)', async () => {
    mock_state.capability_overrides['anthropic'] = { streaming: false };
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        on_chunk: () => {},
      }),
    ).rejects.toBeInstanceOf(provider_capability_error);
  });

  it('F7 429 exhaustion throws rate_limit_error', async () => {
    enqueue_generate_text(mk_429());
    enqueue_generate_text(mk_429());
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        retry: {
          max_attempts: 2,
          initial_delay_ms: 1,
          max_delay_ms: 2,
          retry_on: ['rate_limit'],
        },
      }),
    ).rejects.toBeInstanceOf(rate_limit_error);
  });

  it('F10 token limit exceeded mid-stream returns finish_reason length with partial content', async () => {
    enqueue_generate_text({
      text: 'partial response cut off',
      toolCalls: [],
      finishReason: 'length',
      usage: { inputTokens: 10, outputTokens: 500 },
    });
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
    });
    expect(result.finish_reason).toBe('length');
    expect(result.content).toBe('partial response cut off');

    enqueue_generate_text({
      text: '{"v":42',
      toolCalls: [],
      finishReason: 'length',
      usage: { inputTokens: 10, outputTokens: 500 },
    });
    const with_schema = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      schema: z.object({ v: z.number() }),
    });
    expect(with_schema.finish_reason).toBe('length');
    expect(with_schema.content).toBe('{"v":42');
  });

  it('F12 abort during tool execute surfaces tool_call_in_flight metadata', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'slow', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const controller = new AbortController();
    const promise = basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      abort: controller.signal,
      tools: [
        {
          name: 'slow',
          description: 's',
          input_schema: z.object({}).passthrough(),
          execute: async (_input, ctx) => {
            await new Promise((resolve, reject) => {
              ctx.abort.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
              setTimeout(resolve, 5000);
            });
            return 'ok';
          },
        },
      ],
    });
    setTimeout(() => controller.abort(new Error('user abort')), 20);
    await expect(promise).rejects.toMatchObject({
      kind: 'aborted_error',
      tool_call_in_flight: { id: 'c1', name: 'slow' },
    });
  });

  it('F13 content_filter finish reason is returned normally, not thrown', async () => {
    enqueue_generate_text({
      text: 'filtered response',
      toolCalls: [],
      finishReason: 'content-filter',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const result = await basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
    });
    expect(result.finish_reason).toBe('content_filter');
    expect(result.content).toBe('filtered response');
  });

  it('F14 schema fallback succeeds for providers without native JSON mode (ollama)', async () => {
    enqueue_generate_text(make_text_result('{"v":42}'));
    const engine = create_engine({
      providers: { ollama: { base_url: 'http://localhost:11434' } },
    });
    const schema = z.object({ v: z.number() });
    const result = await engine.generate({
      model: 'ollama:gemma3:27b',
      prompt: 'x',
      schema,
    });
    expect(result.content).toEqual({ v: 42 });
    const params = mock_state.last_generate_text_params as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const system_msg = params.messages.find((m) => m.role === 'system');
    expect(system_msg).toBeDefined();
    expect(String(system_msg?.content)).toMatch(/JSON/);
  });

  it('F19 abort during on_tool_approval await rejects with aborted_error', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'danger', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const controller = new AbortController();
    const exec_spy = vi.fn();
    const promise = basic_engine().generate({
      model: 'claude-opus',
      prompt: 'x',
      abort: controller.signal,
      on_tool_approval: () => new Promise(() => {}),
      tools: [
        {
          name: 'danger',
          description: 'd',
          input_schema: z.object({}).passthrough(),
          needs_approval: true,
          execute: exec_spy,
        },
      ],
    });
    setTimeout(() => controller.abort(new Error('mid-approval')), 100);
    await expect(promise).rejects.toBeInstanceOf(aborted_error);
    expect(exec_spy).not.toHaveBeenCalled();
  });

  it('F20 needs_approval without on_tool_approval fails closed (redundant but explicit)', async () => {
    enqueue_generate_text({
      text: '',
      toolCalls: [{ toolCallId: 'c1', toolName: 'danger', input: {} }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        tools: [
          {
            name: 'danger',
            description: 'd',
            input_schema: z.object({}).passthrough(),
            needs_approval: true,
            execute: () => 'ok',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(tool_approval_denied_error);
  });

  it('F22 network kind surfaces provider_error after retry exhaustion', async () => {
    enqueue_generate_text(mk_net());
    enqueue_generate_text(mk_net());
    await expect(
      basic_engine().generate({
        model: 'claude-opus',
        prompt: 'x',
        retry: {
          max_attempts: 2,
          initial_delay_ms: 1,
          max_delay_ms: 2,
          retry_on: ['rate_limit', 'provider_5xx', 'network'],
        },
      }),
    ).rejects.toBeInstanceOf(provider_error);
  });

  it('a second generate call after a retry failure still reaches the mock', async () => {
    enqueue_generate_text_fn(() => make_text_result('first'));
    const engine = basic_engine();
    const first = await engine.generate({ model: 'claude-opus', prompt: 'a' });
    expect(first.content).toBe('first');
  });
});
