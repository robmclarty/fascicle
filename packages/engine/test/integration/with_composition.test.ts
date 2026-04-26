/**
 * Cross-layer integration (spec §10 / criterion 9).
 *
 * Composes `@repo/core.step` + `run` with `@repo/engine.generate`
 * to prove:
 *   (a) chunks flow through ctx.emit into run.stream events;
 *   (b) aborting the run propagates into the engine; generate rejects with
 *       aborted_error within one event-loop tick;
 *   (c) cleanup handlers fire in LIFO order even when the rejection
 *       originates inside the engine;
 *   (d) the trajectory tree includes both composition-layer spans and engine
 *       spans;
 *   (e) cost events are observable to a userland trajectory consumer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, step, timeout } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_generate_text,
  enqueue_stream,
  reset_mock_state,
} from '../fixtures/mock_ai.js';

vi.mock('ai', async () => build_mock_ai_module());
vi.mock('../../src/providers/registry.js', async () => build_mock_registry_module());

import { create_engine } from '../../src/create_engine.js';
import { aborted_error } from '../../src/errors.js';

function make_logger(): {
  logger: TrajectoryLogger;
  events: TrajectoryEvent[];
  spans: Array<{ id: string; name: string; meta: Record<string, unknown> }>;
} {
  const events: TrajectoryEvent[] = [];
  const spans: Array<{ id: string; name: string; meta: Record<string, unknown> }> = [];
  let counter = 0;
  const logger: TrajectoryLogger = {
    record: (e) => events.push(e),
    start_span: (name, meta) => {
      counter += 1;
      const id = `s${counter}`;
      spans.push({ id, name, meta: { ...meta } });
      return id;
    },
    end_span: () => {},
  };
  return { logger, events, spans };
}

beforeEach(() => reset_mock_state());
afterEach(() => reset_mock_state());

describe('engine + composition integration', () => {
  it('streams chunks through ctx.emit into run.stream; trajectory tree includes both layers', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } });

    enqueue_stream([
      { type: 'text-delta', text: 'hello ' },
      { type: 'text-delta', text: 'world' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);

    const { logger, events, spans } = make_logger();

    const ai_step = step<string, string>('ai', async (input, ctx) => {
      const result = await engine.generate({
        model: 'claude-opus',
        prompt: input,
        abort: ctx.abort,
        trajectory: ctx.trajectory,
        on_chunk: (chunk) => {
          ctx.emit({ stream: 'engine', chunk });
        },
      });
      return result.content;
    });

    const handle = run.stream(ai_step, 'hi', { trajectory: logger });
    const stream_events: TrajectoryEvent[] = [];
    (async () => {
      for await (const e of handle.events) stream_events.push(e);
    })().catch(() => {});
    const output = await handle.result;

    expect(output).toBe('hello world');
    const emit_events = stream_events.filter((e) => e.kind === 'emit');
    expect(emit_events.length).toBeGreaterThan(0);
    const engine_spans = spans.filter((s) => s.name === 'engine.generate');
    const step_spans = spans.filter((s) => s.name === 'step');
    expect(engine_spans.length).toBe(1);
    expect(step_spans.length).toBe(1);
    const cost_events = events.filter((e) => e.kind === 'cost');
    expect(cost_events.length).toBeGreaterThanOrEqual(1);
  });

  it('aborting the run propagates into the engine; generate rejects with aborted_error', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } });

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

    let captured: unknown;
    const slow_step = step<string, string>('slow_ai', async (_input, ctx) => {
      try {
        const result = await engine.generate({
          model: 'claude-opus',
          prompt: 'hi',
          abort: ctx.abort,
          on_chunk: () => {},
        });
        return result.content;
      } catch (err) {
        captured = err;
        throw err;
      }
    });

    const bounded = timeout(slow_step, 50);
    await expect(
      run(bounded, 'hi', { install_signal_handlers: false }),
    ).rejects.toBeTruthy();
    expect(captured).toBeInstanceOf(aborted_error);
  });

  it('cleanup handlers run in LIFO order when the engine rejects', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } });
    enqueue_generate_text(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));

    const order: string[] = [];
    const failing_step = step<string, string>('failing', async (_input, ctx) => {
      ctx.on_cleanup(() => {
        order.push('first');
      });
      ctx.on_cleanup(() => {
        order.push('second');
      });
      const result = await engine.generate({
        model: 'claude-opus',
        prompt: 'hi',
        retry: {
          max_attempts: 1,
          initial_delay_ms: 1,
          max_delay_ms: 2,
          retry_on: ['network'],
        },
      });
      return result.content;
    });

    await expect(
      run(failing_step, 'hi', { install_signal_handlers: false }),
    ).rejects.toBeTruthy();

    expect(order).toEqual(['second', 'first']);
  });

  it('cost events from engine are observable to userland trajectory consumer', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } });
    enqueue_generate_text({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const { logger, events } = make_logger();
    let total_usd = 0;
    const observer_logger: TrajectoryLogger = {
      record: (e) => {
        logger.record(e);
        if (e.kind === 'cost' && typeof e['total_usd'] === 'number') {
          total_usd += e['total_usd'];
        }
      },
      start_span: logger.start_span,
      end_span: logger.end_span,
    };
    const ai_step = step<string, string>('ai', async (input, ctx) => {
      const r = await engine.generate({
        model: 'sonnet',
        prompt: input,
        trajectory: ctx.trajectory,
      });
      return r.content;
    });
    await run(ai_step, 'hi', { trajectory: observer_logger, install_signal_handlers: false });
    expect(total_usd).toBeGreaterThan(0);
    const cost_event = events.find((e) => e.kind === 'cost');
    expect(cost_event).toBeDefined();
    expect(cost_event?.['source']).toBe('engine_derived');
  });
});
