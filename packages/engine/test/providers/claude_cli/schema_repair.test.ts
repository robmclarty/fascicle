/**
 * Schema repair-path tests (spec §5.8, §6.5).
 *
 * Exercises the four branches inside the `opts.schema !== undefined` block of
 * `create_claude_cli_adapter.generate`:
 *   1. first attempt parses — no repair spawn
 *   2. first attempt fails, no session_id — throws schema_validation_error,
 *      no repair spawn
 *   3. first attempt fails, session_id present, repair succeeds — two spawns,
 *      second argv contains `--resume <id>`
 *   4. first attempt fails, repair also fails — throws after exactly one
 *      repair spawn
 *
 * The mock binary switches between `MOCK_CLAUDE_SCRIPT` and
 * `MOCK_CLAUDE_RESUME_SCRIPT` based on whether `--resume` appears in argv.
 */

import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { create_engine } from '../../../src/create_engine.js';
import { schema_validation_error } from '../../../src/errors.js';
import {
  MOCK_CLAUDE_PATH,
  build_mock_env,
  write_mock_script,
  type MockOp,
  type MockScriptHandle,
} from './fixtures/mock_helpers.js';

const cleanup_stack: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup_stack.length > 0) {
    const fn = cleanup_stack.pop();
    if (fn !== undefined) await fn();
  }
});

async function track(handle: MockScriptHandle): Promise<MockScriptHandle> {
  cleanup_stack.push(handle.cleanup);
  return handle;
}

function result_ops(opts: {
  text: string;
  session_id?: string;
}): MockOp[] {
  const ops: MockOp[] = [];
  if (opts.session_id !== undefined) {
    ops.push({
      op: 'line',
      data: { type: 'system', subtype: 'init', session_id: opts.session_id, model: 'mock' },
    });
  }
  const result_data: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    total_cost_usd: 0,
    is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
    result: opts.text,
  };
  if (opts.session_id !== undefined) result_data['session_id'] = opts.session_id;
  ops.push({ op: 'line', data: result_data });
  return ops;
}

const schema = z.object({ answer: z.string() });

describe('claude_cli schema repair path', () => {
  it('passes through when schema validates on first attempt (no repair spawn)', async () => {
    const first = await track(
      await write_mock_script(
        result_ops({ text: JSON.stringify({ answer: 'ok' }), session_id: 'sess-repair-1' }),
      ),
    );

    const engine = create_engine({
      providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
    });
    cleanup_stack.push(() => engine.dispose());

    const result = await engine.generate({
      model: 'cli-sonnet',
      prompt: 'q',
      schema,
      provider_options: {
        claude_cli: {
          env: build_mock_env({
            MOCK_CLAUDE_SCRIPT: first.script_path,
            MOCK_CLAUDE_RECORD: first.record_path,
            MOCK_CLAUDE_RECORD_RESUME: first.record_path.replace('record.json', 'record.resume.json'),
          }),
        },
      },
    });

    expect(result.content).toEqual({ answer: 'ok' });

    const first_argv = JSON.parse(await readFile(first.record_path, 'utf8')) as {
      argv: string[];
    };
    expect(first_argv.argv.includes('--resume')).toBe(false);

    // Resume record must not exist — only one spawn happened.
    await expect(
      readFile(first.record_path.replace('record.json', 'record.resume.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('throws schema_validation_error when first attempt fails and no session_id is available', async () => {
    const first = await track(
      await write_mock_script(result_ops({ text: 'not json' })),
    );

    const engine = create_engine({
      providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
    });
    cleanup_stack.push(() => engine.dispose());

    const promise = engine.generate({
      model: 'cli-sonnet',
      prompt: 'q',
      schema,
      provider_options: {
        claude_cli: {
          env: build_mock_env({
            MOCK_CLAUDE_SCRIPT: first.script_path,
            MOCK_CLAUDE_RECORD: first.record_path,
          }),
        },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(schema_validation_error);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('no session_id available for repair'),
    });
  });

  it('retries with --resume <session_id> when schema fails and repair succeeds', async () => {
    const first = await track(
      await write_mock_script(
        result_ops({ text: 'still not json', session_id: 'sess-repair-3' }),
      ),
    );
    const resume = await track(
      await write_mock_script(
        result_ops({
          text: JSON.stringify({ answer: 'repaired' }),
          session_id: 'sess-repair-3',
        }),
      ),
    );

    const engine = create_engine({
      providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
    });
    cleanup_stack.push(() => engine.dispose());

    const result = await engine.generate({
      model: 'cli-sonnet',
      prompt: 'q',
      schema,
      provider_options: {
        claude_cli: {
          env: build_mock_env({
            MOCK_CLAUDE_SCRIPT: first.script_path,
            MOCK_CLAUDE_RECORD: first.record_path,
            MOCK_CLAUDE_RESUME_SCRIPT: resume.script_path,
            MOCK_CLAUDE_RECORD_RESUME: resume.record_path,
          }),
        },
      },
    });

    expect(result.content).toEqual({ answer: 'repaired' });

    const first_snap = JSON.parse(await readFile(first.record_path, 'utf8')) as {
      argv: string[];
    };
    expect(first_snap.argv.includes('--resume')).toBe(false);

    const resume_snap = JSON.parse(await readFile(resume.record_path, 'utf8')) as {
      argv: string[];
    };
    const resume_index = resume_snap.argv.indexOf('--resume');
    expect(resume_index).toBeGreaterThanOrEqual(0);
    expect(resume_snap.argv[resume_index + 1]).toBe('sess-repair-3');
  });

  it('throws schema_validation_error after exactly one repair when repair also fails', async () => {
    const first = await track(
      await write_mock_script(
        result_ops({ text: 'bad first', session_id: 'sess-repair-4' }),
      ),
    );
    const resume = await track(
      await write_mock_script(
        result_ops({ text: 'bad second', session_id: 'sess-repair-4' }),
      ),
    );

    const engine = create_engine({
      providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
    });
    cleanup_stack.push(() => engine.dispose());

    const promise = engine.generate({
      model: 'cli-sonnet',
      prompt: 'q',
      schema,
      provider_options: {
        claude_cli: {
          env: build_mock_env({
            MOCK_CLAUDE_SCRIPT: first.script_path,
            MOCK_CLAUDE_RECORD: first.record_path,
            MOCK_CLAUDE_RESUME_SCRIPT: resume.script_path,
            MOCK_CLAUDE_RECORD_RESUME: resume.record_path,
          }),
        },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(schema_validation_error);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('after one repair attempt'),
    });

    // Repair was invoked exactly once — resume record exists and carries --resume.
    const resume_snap = JSON.parse(await readFile(resume.record_path, 'utf8')) as {
      argv: string[];
    };
    expect(resume_snap.argv.includes('--resume')).toBe(true);
  });
});
