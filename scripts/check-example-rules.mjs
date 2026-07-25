#!/usr/bin/env node
/**
 * Blueprint enforcement for the example apps.
 *
 * Each app under examples/ carries its own ast-grep rules (docs/blueprint.md):
 * create_engine confined to engine.ts, no imperative loops in the composition
 * layer, and fascicle value imports confined to the files allowed to know
 * about them. The root `struct` check globs `src/**`, so it never sees the
 * examples; without this check the rules only run when a human remembers to.
 *
 * Discovers every examples/<app>/sgconfig.yml and scans that app's src.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = join(REPO_ROOT, 'examples');

function find_rule_apps() {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(EXAMPLES_DIR, name, 'sgconfig.yml')))
    .sort();
}

function report(app, result) {
  if (result.error) {
    console.error(`check-example-rules: failed to run ast-grep in ${app}: ${result.error.message}`);
    return;
  }
  console.error(`check-example-rules: ${app} violates its blueprint rules:`);
  console.error([result.stdout, result.stderr].join('').trimEnd());
}

function scan(app) {
  const result = spawnSync('pnpm', ['exec', 'ast-grep', 'scan', 'src'], {
    cwd: join(EXAMPLES_DIR, app),
    encoding: 'utf8',
  });
  const ok = !result.error && result.status === 0;
  if (!ok) report(app, result);
  return ok;
}

function main() {
  const apps = find_rule_apps();
  if (apps.length === 0) {
    console.error('check-example-rules: no examples/*/sgconfig.yml found; expected at least one');
    process.exit(1);
  }

  const failed = apps.filter((app) => !scan(app));
  if (failed.length > 0) {
    console.error(`check-example-rules: ${failed.length}/${apps.length} app(s) failed: ${failed.join(', ')}`);
    process.exit(1);
  }

  console.log(`check-example-rules: blueprint rules ok (${apps.length} apps: ${apps.join(', ')})`);
}

main();
