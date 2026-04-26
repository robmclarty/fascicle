/**
 * Tool-call loop orchestration (spec §6.4).
 *
 * Invariants:
 *   - Tools execute SEQUENTIALLY within a turn (no parallel dispatch).
 *   - Abort is checked at the top of each loop iteration AND before each tool
 *     call within a turn.
 *   - Tool input is validated against tool.input_schema BEFORE execute is
 *     invoked. Invalid input is fed back as a tool result with error: true and
 *     consumes a step; execute is not called.
 *   - tool_error_policy:
 *       'feed_back' (default) serializes the thrown error into a tool result
 *           with { error: <message> }. Loop continues.
 *       'throw' wraps the error in tool_error and ends the call.
 *   - needs_approval (boolean or predicate) gates execute. Abort fired during
 *     the await rejects with aborted_error.
 *   - Absent on_tool_approval with needs_approval truthy FAILS CLOSED
 *     (tool_approval_denied_error thrown before execute).
 *   - max_steps cap RESOLVES with finish_reason: 'max_steps' (does not throw).
 *     Attempted-but-unexecuted tool calls from the final turn land in
 *     tool_calls with error: { message: 'max_steps_exceeded_before_execution' }.
 *
 * The loop does not itself call the AI SDK. It invokes a supplied `invoke_once`
 * seam that returns a neutral InvokeOnceResult. generate.ts builds the real
 * seam using generateText/streamText; tests inject a mock seam directly.
 */

import type { z } from 'zod';
import type { TrajectoryLogger } from '@repo/core';
import type {
  CostBreakdown,
  FinishReason,
  Message,
  Pricing,
  StepRecord,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
  ToolCallRecord,
  ToolExecContext,
  UsageTotals,
} from './types.js';
import {
  aborted_error,
  tool_approval_denied_error,
  tool_error,
} from './errors.js';
import {
  record_cost,
  record_tool_approval,
  record_tool_call,
  end_step_span,
  start_step_span,
  type PricingMissingDedup,
} from './trajectory.js';
import { compute_cost, FREE_PROVIDERS } from './pricing.js';

export type InvokeOnceArgs = {
  readonly step_index: number;
  readonly messages: ReadonlyArray<Message>;
  readonly tools: ReadonlyArray<Tool>;
  readonly abort: AbortSignal;
  readonly stream: boolean;
};

export type RawToolCall = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

export type InvokeOnceResult = {
  readonly text: string;
  readonly tool_calls: ReadonlyArray<RawToolCall>;
  readonly finish_reason: FinishReason;
  readonly usage: UsageTotals;
};

export type InvokeOnce = (args: InvokeOnceArgs) => Promise<InvokeOnceResult>;

export type ToolLoopConfig = {
  readonly invoke_once: InvokeOnce;
  readonly messages: Message[];
  readonly tools: ReadonlyArray<Tool>;
  readonly max_steps: number;
  readonly step_index_start: number;
  readonly tool_error_policy: 'feed_back' | 'throw';
  readonly abort: AbortSignal;
  readonly on_tool_approval: ToolApprovalHandler | undefined;
  readonly trajectory: TrajectoryLogger | undefined;
  readonly stream: boolean;
  readonly dispatch_chunk: ((chunk: StreamChunk) => Promise<void>) | undefined;
  readonly provider: string;
  readonly model_id: string;
  readonly resolve_pricing: () => Pricing | undefined;
  readonly pricing_dedup: PricingMissingDedup;
  readonly on_finish_step?: (record: StepRecord) => void;
};

export type ToolLoopResult = {
  readonly text: string;
  readonly steps: StepRecord[];
  readonly tool_calls: ToolCallRecord[];
  readonly finish_reason: FinishReason;
  readonly max_steps_reached: boolean;
};

function throw_if_aborted(abort: AbortSignal, step_index: number): void {
  if (!abort.aborted) return;
  throw new aborted_error('aborted', { reason: abort.reason, step_index });
}

function throw_if_aborted_in_flight(
  abort: AbortSignal,
  step_index: number,
  tool_call: { id: string; name: string },
): void {
  if (!abort.aborted) return;
  throw new aborted_error('aborted', {
    reason: abort.reason,
    step_index,
    tool_call_in_flight: { id: tool_call.id, name: tool_call.name },
  });
}

function serialize_error(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

async function request_approval(
  tool: Tool,
  input: unknown,
  step_index: number,
  tool_call_id: string,
  abort: AbortSignal,
  on_tool_approval: ToolApprovalHandler | undefined,
  trajectory: TrajectoryLogger | undefined,
): Promise<boolean> {
  const needs_approval = tool.needs_approval;
  const needs =
    typeof needs_approval === 'function'
      ? await needs_approval(input)
      : needs_approval === true;
  if (!needs) return true;

  record_tool_approval(trajectory, 'tool_approval_requested', {
    tool_name: tool.name,
    step_index,
    tool_call_id,
  });

  if (on_tool_approval === undefined) {
    record_tool_approval(trajectory, 'tool_approval_denied', {
      tool_name: tool.name,
      step_index,
      tool_call_id,
    });
    throw new tool_approval_denied_error(
      `tool approval required for '${tool.name}' but no on_tool_approval handler was provided`,
      { tool_name: tool.name, step_index, tool_call_id },
    );
  }

  const approval_promise = Promise.resolve(
    on_tool_approval({ tool_name: tool.name, input, step_index, abort }),
  );

  const approved = await new Promise<boolean>((resolve, reject) => {
    if (abort.aborted) {
      reject(new aborted_error('aborted', { reason: abort.reason, step_index }));
      return;
    }
    const on_abort = (): void => {
      reject(new aborted_error('aborted', { reason: abort.reason, step_index }));
    };
    abort.addEventListener('abort', on_abort, { once: true });
    approval_promise.then(
      (value) => {
        abort.removeEventListener('abort', on_abort);
        resolve(value);
      },
      (err: unknown) => {
        abort.removeEventListener('abort', on_abort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

  record_tool_approval(
    trajectory,
    approved ? 'tool_approval_granted' : 'tool_approval_denied',
    { tool_name: tool.name, step_index, tool_call_id },
  );

  return approved;
}

async function dispatch_tool_result_chunk(
  dispatch_chunk: ((chunk: StreamChunk) => Promise<void>) | undefined,
  step_index: number,
  id: string,
  output?: unknown,
  error?: { message: string },
): Promise<void> {
  if (dispatch_chunk === undefined) return;
  const chunk: StreamChunk = { kind: 'tool_result', id, step_index };
  if (output !== undefined) chunk.output = output;
  if (error !== undefined) chunk.error = error;
  await dispatch_chunk(chunk);
}

function build_tool_result_message(
  tool_call_id: string,
  tool_name: string,
  content: unknown,
): Message {
  const serialized =
    typeof content === 'string' ? content : safe_json_stringify(content);
  return {
    role: 'tool',
    tool_call_id,
    name: tool_name,
    content: serialized,
  };
}

function safe_json_stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function build_assistant_message(text: string, tool_calls: ReadonlyArray<RawToolCall>): Message {
  if (tool_calls.length === 0) return { role: 'assistant', content: text };
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_call'; id: string; name: string; input: unknown }
  > = [];
  if (text.length > 0) parts.push({ type: 'text', text });
  for (const tc of tool_calls) {
    parts.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input });
  }
  return { role: 'assistant', content: parts };
}

function compute_and_record_cost(
  config: ToolLoopConfig,
  step_index: number,
  usage: UsageTotals,
): CostBreakdown | undefined {
  const pricing = config.resolve_pricing();
  if (pricing === undefined && !FREE_PROVIDERS.has(config.provider)) {
    config.pricing_dedup.emit(config.provider, config.model_id);
    return undefined;
  }
  const breakdown = compute_cost(usage, pricing, config.provider);
  if (breakdown !== undefined) {
    record_cost(config.trajectory, step_index, breakdown, 'engine_derived');
  }
  return breakdown;
}

function validate_tool_input(
  tool: Tool,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  // The schema field is typed as z.ZodType<i>; we call safeParse in the
  // runtime position where the input has not been narrowed.
  const schema: z.ZodType = tool.input_schema;
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const error_message = serialize_error(parsed.error);
  return { ok: false, message: `invalid tool input: ${error_message}` };
}

export async function run_tool_loop(config: ToolLoopConfig): Promise<ToolLoopResult> {
  const steps: StepRecord[] = [];
  const tool_calls_all: ToolCallRecord[] = [];
  let text = '';
  let finish_reason: FinishReason = 'stop';
  let step_index = config.step_index_start;
  let max_steps_reached = false;

  const tool_map = new Map<string, Tool>();
  for (const t of config.tools) tool_map.set(t.name, t);

  while (true) {
    throw_if_aborted(config.abort, step_index);

    if (step_index >= config.max_steps) {
      max_steps_reached = true;
      finish_reason = 'max_steps';
      break;
    }

    const step_span = start_step_span(config.trajectory, step_index);

    let turn: InvokeOnceResult;
    try {
      config.trajectory?.record({ kind: 'request_sent', step_index });
      turn = await config.invoke_once({
        step_index,
        messages: config.messages,
        tools: config.tools,
        abort: config.abort,
        stream: config.stream,
      });
      config.trajectory?.record({
        kind: 'response_received',
        step_index,
        output_tokens: turn.usage.output_tokens,
        finish_reason: turn.finish_reason,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      end_step_span(config.trajectory, step_span, { error: message });
      throw err;
    }

    const step_tool_records: ToolCallRecord[] = [];
    const assistant_message = build_assistant_message(turn.text, turn.tool_calls);
    config.messages.push(assistant_message);

    if (turn.tool_calls.length === 0) {
      text = turn.text;
      finish_reason = turn.finish_reason;
      const record_step: StepRecord = {
        index: step_index,
        text: turn.text,
        tool_calls: [],
        usage: turn.usage,
        finish_reason: turn.finish_reason,
      };
      const breakdown = compute_and_record_cost(config, step_index, turn.usage);
      if (breakdown !== undefined) record_step.cost = breakdown;
      steps.push(record_step);
      if (config.on_finish_step !== undefined) config.on_finish_step(record_step);
      end_step_span(config.trajectory, step_span, {
        usage: turn.usage,
        finish_reason: turn.finish_reason,
      });
      break;
    }

    // This turn has tool calls. Execute them sequentially.
    const would_exceed_after = step_index + 1 >= config.max_steps;
    const tool_results_to_feed: Message[] = [];

    for (const raw_call of turn.tool_calls) {
      throw_if_aborted_in_flight(config.abort, step_index, { id: raw_call.id, name: raw_call.name });

      if (would_exceed_after) {
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: raw_call.name,
          input: raw_call.input,
          error: { message: 'max_steps_exceeded_before_execution' },
          duration_ms: 0,
          started_at: Date.now(),
        };
        step_tool_records.push(record);
        tool_calls_all.push(record);
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: 'max_steps_exceeded_before_execution' },
        );
        continue;
      }

      const tool = tool_map.get(raw_call.name);
      if (tool === undefined) {
        const err_message = `unknown tool '${raw_call.name}'`;
        if (config.tool_error_policy === 'throw') {
          const thrown = new tool_error(err_message, {
            tool_name: raw_call.name,
            tool_call_id: raw_call.id,
            cause: new Error(err_message),
          });
          end_step_span(config.trajectory, step_span, { error: err_message });
          throw thrown;
        }
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: raw_call.name,
          input: raw_call.input,
          error: { message: err_message },
          duration_ms: 0,
          started_at: Date.now(),
        };
        step_tool_records.push(record);
        tool_calls_all.push(record);
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, raw_call.name, {
            error: err_message,
          }),
        );
        record_tool_call(config.trajectory, {
          step_index,
          name: raw_call.name,
          tool_call_id: raw_call.id,
          input: raw_call.input,
          duration_ms: 0,
          error: { message: err_message },
        });
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: err_message },
        );
        continue;
      }

      const validation = validate_tool_input(tool, raw_call.input);
      if (!validation.ok) {
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: raw_call.name,
          input: raw_call.input,
          error: { message: validation.message },
          duration_ms: 0,
          started_at: Date.now(),
        };
        step_tool_records.push(record);
        tool_calls_all.push(record);
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, raw_call.name, {
            error: validation.message,
          }),
        );
        record_tool_call(config.trajectory, {
          step_index,
          name: raw_call.name,
          tool_call_id: raw_call.id,
          input: raw_call.input,
          duration_ms: 0,
          error: { message: validation.message },
        });
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: validation.message },
        );
        continue;
      }

      let approved: boolean;
      try {
        approved = await request_approval(
          tool,
          validation.value,
          step_index,
          raw_call.id,
          config.abort,
          config.on_tool_approval,
          config.trajectory,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        end_step_span(config.trajectory, step_span, { error: message });
        throw err;
      }

      if (!approved) {
        const denied_message = 'tool_approval_denied';
        if (config.tool_error_policy === 'throw') {
          const thrown = new tool_approval_denied_error(
            `tool '${tool.name}' approval denied`,
            { tool_name: tool.name, step_index, tool_call_id: raw_call.id },
          );
          end_step_span(config.trajectory, step_span, { error: denied_message });
          throw thrown;
        }
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: tool.name,
          input: validation.value,
          error: { message: denied_message },
          duration_ms: 0,
          started_at: Date.now(),
        };
        step_tool_records.push(record);
        tool_calls_all.push(record);
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, tool.name, { error: denied_message }),
        );
        record_tool_call(config.trajectory, {
          step_index,
          name: tool.name,
          tool_call_id: raw_call.id,
          input: validation.value,
          duration_ms: 0,
          error: { message: denied_message },
        });
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: denied_message },
        );
        continue;
      }

      throw_if_aborted_in_flight(config.abort, step_index, {
        id: raw_call.id,
        name: tool.name,
      });

      const started_at = Date.now();
      const tool_ctx: ToolExecContext = {
        abort: config.abort,
        tool_call_id: raw_call.id,
        step_index,
        ...(config.trajectory !== undefined ? { trajectory: config.trajectory } : {}),
      };

      let output: unknown;
      let err_message: string | undefined;
      let thrown: unknown;
      try {
        const execute = tool.execute;
        const maybe = execute(validation.value, tool_ctx);
        output = maybe instanceof Promise ? await maybe : maybe;
      } catch (err: unknown) {
        thrown = err;
        err_message = serialize_error(err);
      }

      const duration_ms = Date.now() - started_at;

      if (thrown !== undefined) {
        if (config.abort.aborted) {
          const abort_err = new aborted_error('aborted', {
            reason: config.abort.reason,
            step_index,
            tool_call_in_flight: { id: raw_call.id, name: tool.name },
          });
          end_step_span(config.trajectory, step_span, { error: 'aborted' });
          throw abort_err;
        }
        if (config.tool_error_policy === 'throw') {
          const wrapped = new tool_error(`tool '${tool.name}' failed: ${err_message ?? 'unknown'}`, {
            tool_name: tool.name,
            tool_call_id: raw_call.id,
            cause: thrown,
          });
          end_step_span(config.trajectory, step_span, { error: err_message ?? 'tool error' });
          throw wrapped;
        }
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: tool.name,
          input: validation.value,
          error: { message: err_message ?? 'unknown' },
          duration_ms,
          started_at,
        };
        step_tool_records.push(record);
        tool_calls_all.push(record);
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, tool.name, { error: err_message ?? 'unknown' }),
        );
        record_tool_call(config.trajectory, {
          step_index,
          name: tool.name,
          tool_call_id: raw_call.id,
          input: validation.value,
          duration_ms,
          error: { message: err_message ?? 'unknown' },
        });
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: err_message ?? 'unknown' },
        );
        continue;
      }

      const record: ToolCallRecord = {
        id: raw_call.id,
        name: tool.name,
        input: validation.value,
        output,
        duration_ms,
        started_at,
      };
      step_tool_records.push(record);
      tool_calls_all.push(record);
      tool_results_to_feed.push(
        build_tool_result_message(raw_call.id, tool.name, output ?? ''),
      );
      record_tool_call(config.trajectory, {
        step_index,
        name: tool.name,
        tool_call_id: raw_call.id,
        input: validation.value,
        duration_ms,
      });
      await dispatch_tool_result_chunk(config.dispatch_chunk, step_index, raw_call.id, output);
    }

    for (const m of tool_results_to_feed) config.messages.push(m);

    const turn_finish_reason: FinishReason = would_exceed_after ? 'max_steps' : turn.finish_reason;
    const step_record: StepRecord = {
      index: step_index,
      text: turn.text,
      tool_calls: step_tool_records,
      usage: turn.usage,
      finish_reason: turn_finish_reason,
    };
    const breakdown = compute_and_record_cost(config, step_index, turn.usage);
    if (breakdown !== undefined) step_record.cost = breakdown;
    steps.push(step_record);
    if (config.on_finish_step !== undefined) config.on_finish_step(step_record);
    end_step_span(config.trajectory, step_span, {
      usage: turn.usage,
      finish_reason: turn_finish_reason,
    });

    if (would_exceed_after) {
      max_steps_reached = true;
      finish_reason = 'max_steps';
      text = turn.text;
      break;
    }

    step_index += 1;
  }

  return { text, steps, tool_calls: tool_calls_all, finish_reason, max_steps_reached };
}
