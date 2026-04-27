/**
 * Golden-output metric: tests pass (gate) + per-character output match
 * against a captured baseline (score, maximize — fraction in [0, 1]).
 *
 * The first time this metric runs, if `golden.json` does not exist, it is
 * captured from the current implementation. Subsequent runs compare each
 * candidate's output to that baseline character-by-character.
 *
 * Useful when "improvement" means "structurally better while preserving
 * exact output" — e.g., refactoring a stable function for clarity.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Metric } from '../src/types.js';

const SAMPLE_INPUT = [
  'INFO  service=auth ok',
  'ERROR service=auth db timeout',
  'WARN  service=billing slow',
  'ERROR service=billing card declined',
  'ERROR service=auth rate-limited',
].join('\n');
const SAMPLE_SERVICES = ['auth', 'billing', 'search'] as const;

type AggregateFn = (
  text: string,
  services: ReadonlyArray<string>,
) => Record<string, number>;

function is_record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function get_aggregate(mod: unknown): AggregateFn {
  if (!is_record(mod)) {
    throw new Error('golden metric: module did not load as an object');
  }
  const fn = mod['aggregate'];
  if (typeof fn !== 'function') {
    throw new Error('golden metric: module is missing exported function "aggregate"');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fn as AggregateFn;
}

async function run_impl(impl_path: string): Promise<string> {
  const mod: unknown = await import(impl_path);
  const aggregate = get_aggregate(mod);
  const result = aggregate(SAMPLE_INPUT, SAMPLE_SERVICES);
  return JSON.stringify(result, null, 2);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max_len = Math.max(a.length, b.length);
  if (max_len === 0) return 1;
  let matches = 0;
  const min_len = Math.min(a.length, b.length);
  for (let i = 0; i < min_len; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / max_len;
}

export function make_metric(target_dir: string): Metric {
  const golden_path = join(target_dir, 'fixtures', 'golden.json');
  return {
    name: 'golden',
    direction: 'maximize',
    mutable_path: join(target_dir, 'src', 'log_aggregator.ts'),
    gate: {
      command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts'],
      cwd: target_dir,
      expected_exit: 0,
      timeout_ms: 60_000,
    },
    score: async (impl_path: string): Promise<number> => {
      const actual = await run_impl(impl_path);
      if (!existsSync(golden_path)) {
        await writeFile(golden_path, actual, 'utf8');
        return 1;
      }
      const golden = await readFile(golden_path, 'utf8');
      return similarity(actual, golden);
    },
  };
}
