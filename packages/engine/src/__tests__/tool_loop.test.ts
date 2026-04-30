/**
 * Colocated unit tests for tool_loop.ts.
 *
 * These exercise the loop with a mock invoke_once seam so the behavior is
 * testable without the `ai` SDK. Integration behavior (SDK call path, retry,
 * streaming) lives in generate.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  run_tool_loop,
  type InvokeOnce,
  type InvokeOnceResult,
  type RawToolCall,
} from '../tool_loop.js';
import type { Message, Tool, UsageTotals } from '../types.js';
import { tool_error, tool_approval_denied_error, aborted_error } from '../errors.js';
import { create_pricing_missing_dedup } from '../trajectory.js';

const zero_usage: UsageTotals = { input_tokens: 0, output_tokens: 0 };

function make_invoke_once(results: ReadonlyArray<Partial<InvokeOnceResult>>): InvokeOnce {
  let call = 0;
  return async (): Promise<InvokeOnceResult> => {
    const r = results[call];
    call += 1;
    if (r === undefined) throw new Error(`invoke_once called ${call} times but only ${results.length} results supplied`);
    return {
      text: r.text ?? '',
      tool_calls: r.tool_calls ?? [],
      finish_reason: r.finish_reason ?? 'stop',
      usage: r.usage ?? zero_usage,
    };
  };
}

function make_tool(overrides: Partial<Tool> = {}): Tool {
  const execute = overrides.execute ?? ((): string => 'ok');
  return {
    name: overrides.name ?? 'echo',
    description: overrides.description ?? 'echo tool',
    input_schema: overrides.input_schema ?? z.object({ value: z.string() }),
    execute,
    ...(overrides.needs_approval !== undefined ? { needs_approval: overrides.needs_approval } : {}),
  };
}

function pricing_dedup_stub(): ReturnType<typeof create_pricing_missing_dedup> {
  return create_pricing_missing_dedup(undefined);
}

describe('run_tool_loop', () => {
  it('resolves a plain completion in one step', async () => {
    const invoke = make_invoke_once([
      { text: 'hello', finish_reason: 'stop', usage: { input_tokens: 5, output_tokens: 3 } },
    ]);
    const messages: Message[] = [{ role: 'user', content: 'hi' }];

    const result = await run_tool_loop({
      invoke_once: invoke,
      messages,
      tools: [],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });
    expect(result.text).toBe('hello');
    expect(result.steps).toHaveLength(1);
    expect(result.finish_reason).toBe('stop');
    expect(result.tool_calls).toEqual([]);
  });

  it('executes a tool call and feeds the result back', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'echo', input: { value: 'hi' } };
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls', usage: { input_tokens: 10, output_tokens: 2 } },
      { text: 'done', finish_reason: 'stop', usage: { input_tokens: 15, output_tokens: 4 } },
    ]);
    const messages: Message[] = [{ role: 'user', content: 'use echo' }];
    const tool = make_tool({
      name: 'echo',
      execute: (input: unknown) => `echoed: ${(input as { value: string }).value}`,
    });

    const result = await run_tool_loop({
      invoke_once: invoke,
      messages,
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });

    expect(result.steps).toHaveLength(2);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]?.output).toBe('echoed: hi');
    expect(result.text).toBe('done');
  });

  it('feeds invalid tool input back as an error result without calling execute', async () => {
    const exec_spy = vi.fn();
    const bad: RawToolCall = { id: 'c1', name: 'echo', input: { missing: true } };
    const invoke = make_invoke_once([
      { tool_calls: [bad], finish_reason: 'tool_calls' },
      { text: 'done', finish_reason: 'stop' },
    ]);
    const tool = make_tool({ name: 'echo', execute: exec_spy });

    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });

    expect(exec_spy).not.toHaveBeenCalled();
    expect(result.tool_calls[0]?.error?.message).toMatch(/invalid tool input/);
  });

  it('feeds tool execute error back under feed_back policy', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'boom', input: { value: 'x' } };
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
      { text: 'done', finish_reason: 'stop' },
    ]);
    const tool = make_tool({
      name: 'boom',
      execute: () => {
        throw new Error('kaboom');
      },
    });
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });
    expect(result.tool_calls[0]?.error?.message).toBe('kaboom');
    expect(result.text).toBe('done');
  });

  it('throws tool_error under throw policy when execute throws', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'boom', input: { value: 'x' } };
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
    ]);
    const tool = make_tool({
      name: 'boom',
      execute: () => {
        throw new Error('kaboom');
      },
    });
    await expect(
      run_tool_loop({
        invoke_once: invoke,
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool],
        max_steps: 10,
        step_index_start: 0,
        tool_error_policy: 'throw',
        abort: new AbortController().signal,
        on_tool_approval: undefined,
        trajectory: undefined,
        stream: false,
        dispatch_chunk: undefined,
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: pricing_dedup_stub(),
      }),
    ).rejects.toBeInstanceOf(tool_error);
  });

  it('caps at max_steps and marks attempted-but-unexecuted tool calls', async () => {
    const invoke = make_invoke_once([
      {
        tool_calls: [{ id: 'c1', name: 'echo', input: { value: 'a' } }],
        finish_reason: 'tool_calls',
      },
      {
        tool_calls: [{ id: 'c2', name: 'echo', input: { value: 'b' } }],
        finish_reason: 'tool_calls',
      },
      {
        tool_calls: [{ id: 'c3', name: 'echo', input: { value: 'c' } }],
        finish_reason: 'tool_calls',
      },
    ]);
    const tool = make_tool({
      name: 'echo',
      execute: (input: unknown) => (input as { value: string }).value,
    });

    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      max_steps: 3,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });

    expect(result.finish_reason).toBe('max_steps');
    expect(result.max_steps_reached).toBe(true);
    const last_call = result.tool_calls.at(-1);
    expect(last_call?.error?.message).toBe('max_steps_exceeded_before_execution');
  });

  it('fails closed when needs_approval is truthy without on_tool_approval', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'danger', input: { value: 'x' } };
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
    ]);
    const tool = make_tool({
      name: 'danger',
      needs_approval: true,
    });

    await expect(
      run_tool_loop({
        invoke_once: invoke,
        messages: [{ role: 'user', content: 'x' }],
        tools: [tool],
        max_steps: 10,
        step_index_start: 0,
        tool_error_policy: 'feed_back',
        abort: new AbortController().signal,
        on_tool_approval: undefined,
        trajectory: undefined,
        stream: false,
        dispatch_chunk: undefined,
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: pricing_dedup_stub(),
      }),
    ).rejects.toBeInstanceOf(tool_approval_denied_error);
  });

  it('rejects with aborted_error when abort fires during approval wait', async () => {
    const controller = new AbortController();
    const tc: RawToolCall = { id: 'c1', name: 'danger', input: { value: 'x' } };
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
    ]);
    const tool = make_tool({ name: 'danger', needs_approval: true });

    const promise = run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: controller.signal,
      on_tool_approval: () => new Promise(() => {}),
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });
    setTimeout(() => controller.abort(new Error('user abort')), 20);
    await expect(promise).rejects.toBeInstanceOf(aborted_error);
  });

  it('feeds denial back when approval is rejected under feed_back', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'danger', input: { value: 'x' } };
    const invoke = make_invoke_once([
      { tool_calls: [tc], finish_reason: 'tool_calls' },
      { text: 'ok', finish_reason: 'stop' },
    ]);
    const tool = make_tool({ name: 'danger', needs_approval: true });

    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: () => false,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });
    expect(result.tool_calls[0]?.error?.message).toBe('tool_approval_denied');
    expect(result.text).toBe('ok');
  });

  it('feeds unknown tool name back under feed_back; throws under throw', async () => {
    const tc: RawToolCall = { id: 'c1', name: 'missing', input: {} };
    {
      const invoke = make_invoke_once([
        { tool_calls: [tc], finish_reason: 'tool_calls' },
        { text: 'ok', finish_reason: 'stop' },
      ]);
      const result = await run_tool_loop({
        invoke_once: invoke,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        max_steps: 10,
        step_index_start: 0,
        tool_error_policy: 'feed_back',
        abort: new AbortController().signal,
        on_tool_approval: undefined,
        trajectory: undefined,
        stream: false,
        dispatch_chunk: undefined,
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        resolve_pricing: () => undefined,
        pricing_dedup: pricing_dedup_stub(),
      });
      expect(result.tool_calls[0]?.error?.message).toMatch(/unknown tool/);
    }
    {
      const invoke = make_invoke_once([
        { tool_calls: [tc], finish_reason: 'tool_calls' },
      ]);
      await expect(
        run_tool_loop({
          invoke_once: invoke,
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          max_steps: 10,
          step_index_start: 0,
          tool_error_policy: 'throw',
          abort: new AbortController().signal,
          on_tool_approval: undefined,
          trajectory: undefined,
          stream: false,
          dispatch_chunk: undefined,
          provider: 'anthropic',
          model_id: 'claude-opus-4-7',
          resolve_pricing: () => undefined,
          pricing_dedup: pricing_dedup_stub(),
        }),
      ).rejects.toBeInstanceOf(tool_error);
    }
  });

  it('executes multiple tool calls in a single turn sequentially and records order', async () => {
    const order: string[] = [];
    const tool_a = make_tool({
      name: 'a',
      execute: async (input: unknown) => {
        order.push(`a-${(input as { value: string }).value}`);
        return 'A';
      },
    });
    const tool_b = make_tool({
      name: 'b',
      execute: async (input: unknown) => {
        order.push(`b-${(input as { value: string }).value}`);
        return 'B';
      },
    });
    const invoke = make_invoke_once([
      {
        tool_calls: [
          { id: 'c1', name: 'a', input: { value: '1' } },
          { id: 'c2', name: 'b', input: { value: '2' } },
        ],
        finish_reason: 'tool_calls',
      },
      { text: 'ok', finish_reason: 'stop' },
    ]);
    const result = await run_tool_loop({
      invoke_once: invoke,
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool_a, tool_b],
      max_steps: 10,
      step_index_start: 0,
      tool_error_policy: 'feed_back',
      abort: new AbortController().signal,
      on_tool_approval: undefined,
      trajectory: undefined,
      stream: false,
      dispatch_chunk: undefined,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      resolve_pricing: () => undefined,
      pricing_dedup: pricing_dedup_stub(),
    });
    expect(order).toEqual(['a-1', 'b-2']);
    expect(result.tool_calls.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});
