/**
 * Benchmark harness: runs `aggregate_file` N times on the fixture and
 * prints the median wall-clock in milliseconds, one number per line.
 *
 * The metric loader parses the LAST line of stdout as the score.
 *
 * Override the implementation path with `IMPL_PATH=/abs/path/to/file.js` to
 * benchmark a specific candidate. Defaults to the in-tree starter.
 */

import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'sample.log');
const SERVICES = ['auth', 'billing', 'search', 'orders', 'inventory'] as const;

const RUNS = Number.parseInt(process.env['BENCH_RUNS'] ?? '5', 10);
const IMPL_PATH = process.env['IMPL_PATH'] ?? join(HERE, 'src', 'log_aggregator.ts');

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const v = sorted[mid];
    if (v === undefined) throw new Error('median: empty');
    return v;
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) throw new Error('median: empty');
  return (a + b) / 2;
}

type AggregateFileFn = (
  path: string,
  services: ReadonlyArray<string>,
) => Promise<Record<string, number>>;

function is_record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function get_aggregate_file(mod: unknown): AggregateFileFn {
  if (!is_record(mod)) {
    throw new Error('bench: module did not load as an object');
  }
  const fn = mod['aggregate_file'];
  if (typeof fn !== 'function') {
    throw new Error('bench: module is missing exported function "aggregate_file"');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fn as AggregateFileFn;
}

async function main(): Promise<void> {
  const mod: unknown = await import(IMPL_PATH);
  const aggregate_file = get_aggregate_file(mod);

  // Warmup
  await aggregate_file(FIXTURE, SERVICES);

  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await aggregate_file(FIXTURE, SERVICES);
    const t1 = performance.now();
    samples.push(t1 - t0);
  }

  const ms = median(samples);
  console.log(`runs=${String(RUNS)} samples=[${samples.map((s) => s.toFixed(2)).join(', ')}]`);
  console.log(ms.toFixed(3));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
