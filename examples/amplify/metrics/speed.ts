/**
 * Default metric: tests pass (gate) + median wall-clock (score, minimize).
 *
 * The gate runs vitest against the target's locked regression suite. The
 * score spawns `target/bench.ts` against the candidate file (passed via
 * `IMPL_PATH`), parsing the median ms from the last line of stdout.
 *
 * Mutations that game runtime by deleting features die at the gate, by
 * construction.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import type { Metric } from '../src/types.js';

const BENCH_TIMEOUT_MS = 60_000;

type SpawnResult = { stdout: string; stderr: string; exit_code: number };

function spawn_capture(
  cmd: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  timeout_ms: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const head = cmd[0];
    const tail = cmd.slice(1);
    if (head === undefined) {
      reject(new Error('spawn: empty command'));
      return;
    }
    const proc = spawn(head, tail, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeout_ms);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code ?? -1 });
    });
  });
}

export function make_metric(target_dir: string): Metric {
  const bench_script = join(target_dir, 'bench.ts');
  return {
    name: 'speed',
    direction: 'minimize',
    mutable_path: join(target_dir, 'src', 'log_aggregator.ts'),
    gate: {
      command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts'],
      cwd: target_dir,
      expected_exit: 0,
      timeout_ms: 60_000,
    },
    score: async (impl_path: string): Promise<number> => {
      const result = await spawn_capture(
        ['pnpm', 'exec', 'tsx', bench_script],
        target_dir,
        { IMPL_PATH: impl_path, BENCH_RUNS: '5' },
        BENCH_TIMEOUT_MS,
      );
      if (result.exit_code !== 0) {
        throw new Error(`bench failed (exit ${String(result.exit_code)}): ${result.stderr}`);
      }
      const lines = result.stdout.trim().split('\n');
      const last = lines[lines.length - 1];
      if (last === undefined) {
        throw new Error('bench produced no output');
      }
      const ms = Number.parseFloat(last);
      if (!Number.isFinite(ms)) {
        throw new Error(`bench output not a number: "${last}"`);
      }
      return ms;
    },
  };
}
