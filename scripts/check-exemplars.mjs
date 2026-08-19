#!/usr/bin/env node
/**
 * The voice exemplars under .vale/exemplars/ are read-only by contract.
 *
 * AGENTS.md tells every writing session to imitate them and never to edit,
 * rewrite, add to, or generate one, because a generated "improvement" replaces
 * a human original with a copy of the model's own register, which is the drift
 * the directory exists to prevent. That instruction was honour-system until
 * this check, and an agent broke it once already through a stray whitespace
 * pass rather than any deliberate rewrite.
 *
 * Any difference against HEAD fails, additions included. Adding an exemplar is
 * a human act and wants the same deliberate pause as changing one. Set
 * EXEMPLARS_UNLOCKED=1 for the commit that does it.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = '.vale/exemplars';

/** Names of files under the exemplars directory that differ from HEAD. */
function changed_paths() {
  const args = ['status', '--porcelain', '--untracked-files=all', '--', DIR];
  const out = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `${line.slice(0, 2).trim()} ${line.slice(3)}`);
}

function main() {
  if (process.env['EXEMPLARS_UNLOCKED'] === '1') {
    console.log('check-exemplars: unlocked by EXEMPLARS_UNLOCKED=1, skipping');
    return;
  }

  const changed = changed_paths();
  if (changed.length === 0) {
    console.log(`check-exemplars: ${DIR} matches HEAD`);
    return;
  }

  console.error(`check-exemplars: ${DIR} is read-only by contract, and these differ from HEAD:`);
  for (const entry of changed) console.error(`  ${entry}`);
  console.error('');
  console.error('The exemplars are the repo\'s hand-written voice reference (see AGENTS.md');
  console.error('"Prose voice"). If a model touched them, restore with:');
  console.error(`  git checkout -- ${DIR}`);
  console.error('If you are a human deliberately adding or replacing one, re-run with:');
  console.error('  EXEMPLARS_UNLOCKED=1 pnpm check');
  process.exit(1);
}

main();
