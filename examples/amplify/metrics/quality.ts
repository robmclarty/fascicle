/**
 * Quality metric: tests pass (gate) + size + branching penalty (score, minimize).
 *
 *   score = lines_of_code + 5 * branch_count
 *
 * `branch_count` is a token-count proxy: occurrences of `if` / `for` /
 * `while` / `case` / `&&` / `||` / `?`. Crude but adversarially honest —
 * the agent can't game it by inlining without paying the LOC cost, and
 * can't game it by deleting features (the gate catches that).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Metric } from '../src/types.js'

const BRANCH_RE = /\b(?:if|for|while|case)\b|&&|\|\||\?/g

function loc(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('//')
    }).length
}

function branch_count(source: string): number {
  return (source.match(BRANCH_RE) ?? []).length
}

export function make_metric(target_dir: string): Metric {
  return {
    name: 'quality',
    direction: 'minimize',
    mutable_path: join(target_dir, 'src', 'log_aggregator.ts'),
    gate: {
      command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts'],
      cwd: target_dir,
      expected_exit: 0,
      timeout_ms: 60_000,
    },
    score: async (impl_path: string): Promise<number> => {
      const src = await readFile(impl_path, 'utf8')
      return loc(src) + 5 * branch_count(src)
    },
  }
}
