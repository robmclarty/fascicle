/**
 * Shared fixture helpers for claude_cli tests.
 *
 * - MOCK_CLAUDE_PATH is the absolute path to the mock binary.
 * - write_mock_script persists a JSON operations file in a temp dir and returns
 *   its path plus a cleanup function.
 * - success_ops produces a canonical init / assistant-text / result sequence.
 * - create_captured_trajectory builds an in-memory TrajectoryLogger that
 *   captures records and spans for assertions.
 */

import { chmodSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';

const here = dirname(fileURLToPath(import.meta.url));

export const MOCK_CLAUDE_PATH = join(here, 'mock_claude.mjs');

// Stryker's sandbox copy strips the exec bit; ensure the mock is runnable.
chmodSync(MOCK_CLAUDE_PATH, 0o755);

export type MockOp =
  | { op: 'line'; data: unknown }
  | { op: 'raw'; text: string }
  | { op: 'stderr'; text: string }
  | { op: 'delay'; ms: number }
  | { op: 'exit'; code?: number }
  | { op: 'hang' };

export type MockScriptHandle = {
  readonly script_path: string;
  readonly record_path: string;
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
};

/**
 * The mock binary uses `#!/usr/bin/env node`, so the child needs PATH to find
 * `node`. build_mock_env() adds PATH and merges any caller-supplied variables.
 */
export function build_mock_env(extra: Record<string, string> = {}): Record<string, string> {
  const path_val = process.env['PATH'] ?? '';
  return { PATH: path_val, ...extra };
}

export async function write_mock_script(ops: ReadonlyArray<MockOp>): Promise<MockScriptHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-cli-mock-'));
  const script_path = join(dir, 'script.json');
  const record_path = join(dir, 'record.json');
  await writeFile(script_path, JSON.stringify(ops));
  return {
    script_path,
    record_path,
    dir,
    cleanup: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function success_ops(
  text: string,
  opts: {
    session_id?: string;
    total_cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_write_tokens?: number;
    duration_ms?: number;
  } = {},
): MockOp[] {
  const session_id = opts.session_id ?? 'sess-1';
  return [
    {
      op: 'line',
      data: { type: 'system', subtype: 'init', session_id, model: 'mock' },
    },
    {
      op: 'line',
      data: { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    },
    {
      op: 'line',
      data: {
        type: 'result',
        subtype: 'success',
        session_id,
        duration_ms: opts.duration_ms ?? 10,
        total_cost_usd: opts.total_cost_usd ?? 0.001,
        is_error: false,
        usage: {
          input_tokens: opts.input_tokens ?? 10,
          output_tokens: opts.output_tokens ?? 5,
          ...(opts.cached_input_tokens !== undefined
            ? { cache_read_input_tokens: opts.cached_input_tokens }
            : {}),
          ...(opts.cache_write_tokens !== undefined
            ? { cache_creation_input_tokens: opts.cache_write_tokens }
            : {}),
        },
        result: text,
      },
    },
  ];
}

export type CapturedSpan = {
  readonly id: string;
  readonly name: string;
  readonly meta: Record<string, unknown>;
  ended?: Record<string, unknown>;
};

export type CapturedTrajectory = {
  readonly logger: TrajectoryLogger;
  readonly events: TrajectoryEvent[];
  readonly spans: CapturedSpan[];
};

export function create_captured_trajectory(): CapturedTrajectory {
  const events: TrajectoryEvent[] = [];
  const spans: CapturedSpan[] = [];
  let counter = 0;
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event);
    },
    start_span: (name, meta) => {
      counter += 1;
      const id = `span-${counter}`;
      spans.push({ id, name, meta: { ...meta } });
      return id;
    },
    end_span: (id, meta) => {
      const match = spans.find((s) => s.id === id);
      if (match !== undefined) match.ended = { ...meta };
    },
  };
  return { logger, events, spans };
}
