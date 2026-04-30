#!/usr/bin/env node
/**
 * Run the no-semicolons ast-grep rule until it converges.
 *
 * ast-grep deduplicates overlapping matches per pass: when an outer statement
 * (e.g. do_statement) and an inner one (e.g. expression_statement) both have a
 * trailing `;`, only the outer fix is applied. The inner one is fixed on the
 * next pass once the outer has stabilized. We loop until a pass reports zero
 * changes or we hit the cap.
 */

import { spawnSync } from 'node:child_process';

const MAX_PASSES = 10;

const RULES = ['no-semicolons', 'no-semicolons-types'];

for (const rule of RULES) {
  for (let i = 1; i <= MAX_PASSES; i += 1) {
    const result = spawnSync(
      'pnpm',
      ['exec', 'ast-grep', 'scan', '--filter', rule, '-U'],
      { encoding: 'utf8' },
    );
    const out = `${result.stdout}${result.stderr}`;
    const match = out.match(/Applied (\d+) changes/);
    const changes = match ? Number(match[1]) : 0;
    if (changes === 0) break;
  }
}
process.exit(0);
