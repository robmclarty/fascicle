#!/usr/bin/env node
/**
 * Build the umbrella @robmclarty/fascicle bundle via tsdown.
 *
 * Pipeline:
 *   1. Delete ./dist/.
 *   2. Run `pnpm exec tsdown`; exit non-zero on any tsdown warning or failure.
 *   3. Verify ./dist/index.js and ./dist/index.d.ts exist and are non-empty.
 *   4. Dynamic-import the built bundle and assert the 16 composition
 *      primitives plus `create_engine`, `model_call`, `describe`, and
 *      `describe.json` are exported.
 *
 * Exit codes:
 *   0  clean build
 *   1  tsdown failure, warning, or smoke-test failure
 *   2  orchestrator error
 */

import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const DIST_JS = join(DIST_DIR, 'index.js');
const DIST_DTS = join(DIST_DIR, 'index.d.ts');

const EXPECTED_NAMED = [
  // 16 composition primitives
  'step',
  'sequence',
  'parallel',
  'branch',
  'map',
  'pipe',
  'retry',
  'fallback',
  'timeout',
  'adversarial',
  'ensemble',
  'tournament',
  'consensus',
  'checkpoint',
  'suspend',
  'scope',
  'stash',
  'use',
  // runner
  'run',
  // engine bridge + umbrella additions
  'create_engine',
  'model_call',
  'describe',
];

function run_subprocess(cmd, args, opts = {}) {
  return new Promise((resolve_exit) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      process.stderr.write(s);
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(s);
    });
    proc.on('error', (err) => {
      resolve_exit({ code: -1, stdout, stderr, error: err.message });
    });
    proc.on('close', (code) => {
      resolve_exit({ code: code ?? -1, stdout, stderr });
    });
  });
}

// Known-benign tsdown self-deprecation messages. These fire when the spec-
// mandated config field names (`external`, `noExternal`) are used instead of
// tsdown's newer `deps.neverBundle` / `deps.alwaysBundle`. Keeping the spec
// field names is deliberate (constraints.md §3.3); tsdown still honors them.
const BENIGN_WARNING_RE = [
  /`external` is deprecated\. Use `deps\.neverBundle` instead\./,
  /`noExternal` is deprecated\. Use `deps\.alwaysBundle` instead\./,
];

function detect_warning(text) {
  // Rolldown emits `(!) ...` for real bundler warnings; those are hard failures.
  // tsdown emits yellow-boxed `WARN` lines for its own config deprecations;
  // allowlisted via BENIGN_WARNING_RE above.
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('(!) ')) return trimmed;
    if (/\bWARN\b/.test(trimmed)) {
      if (BENIGN_WARNING_RE.some((re) => re.test(trimmed))) continue;
      return trimmed;
    }
  }
  return null;
}

async function main() {
  process.stderr.write(`\n▸ build: cleaning ${DIST_DIR}\n`);
  await rm(DIST_DIR, { recursive: true, force: true });

  process.stderr.write(`▸ build: running tsdown\n`);
  const res = await run_subprocess('pnpm', ['exec', 'tsdown']);
  if (res.code !== 0) {
    console.error(`\nbuild: tsdown exited with code ${res.code}`);
    process.exit(1);
  }

  const combined = `${res.stdout}\n${res.stderr}`;
  const warning = detect_warning(combined);
  if (warning) {
    console.error(`\nbuild: tsdown emitted a warning, failing: ${warning}`);
    process.exit(1);
  }

  if (!existsSync(DIST_JS)) {
    console.error(`\nbuild: ${DIST_JS} was not produced`);
    process.exit(1);
  }
  if (!existsSync(DIST_DTS)) {
    console.error(`\nbuild: ${DIST_DTS} was not produced`);
    process.exit(1);
  }
  const js_stat = await stat(DIST_JS);
  const dts_stat = await stat(DIST_DTS);
  if (js_stat.size === 0) {
    console.error(`\nbuild: ${DIST_JS} is empty`);
    process.exit(1);
  }
  if (dts_stat.size === 0) {
    console.error(`\nbuild: ${DIST_DTS} is empty`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: verifying bundle externals\n`);
  const dist_text = await readFile(DIST_JS, 'utf8');

  // Workspace deps MUST be inlined.
  const repo_static = /from\s+["']@repo\//.test(dist_text);
  const repo_dynamic = /import\(\s*["']@repo\//.test(dist_text);
  if (repo_static || repo_dynamic) {
    console.error(`\nbuild: @repo/* appears in dist — workspace deps were not inlined`);
    process.exit(1);
  }

  // Required runtime peers: static imports of `ai` and `zod`.
  if (!/from\s+["']ai["']/.test(dist_text)) {
    console.error(`\nbuild: dist missing \`from 'ai'\` — peer not preserved as external`);
    process.exit(1);
  }
  if (!/from\s+["']zod["']/.test(dist_text)) {
    console.error(`\nbuild: dist missing \`from 'zod'\` — peer not preserved as external`);
    process.exit(1);
  }

  // Optional peers (`@ai-sdk/*`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider`)
  // are loaded via `await import('<specifier>')` inside provider adapters.
  // They are external-by-dynamic-import; the bundler preserves the literal
  // specifier. Assert the `@ai-sdk/` family appears as a specifier substring.
  if (!/["']@ai-sdk\//.test(dist_text)) {
    console.error(
      `\nbuild: dist missing any \`@ai-sdk/\` specifier — optional peers were not preserved as externals`,
    );
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_JS}\n`);
  const mod = await import(pathToFileURL(DIST_JS).href);
  const missing = EXPECTED_NAMED.filter((name) => typeof mod[name] === 'undefined');
  if (missing.length > 0) {
    console.error(`\nbuild: smoke test missing exports: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (typeof mod.describe?.json !== 'function') {
    console.error(`\nbuild: smoke test missing describe.json namespace member`);
    process.exit(1);
  }

  process.stderr.write(
    `\n✔ build ok (${js_stat.size} bytes js, ${dts_stat.size} bytes d.ts, ${EXPECTED_NAMED.length} named exports + describe.json verified)\n`,
  );
}

main().catch((err) => {
  console.error('build: orchestrator error:', err);
  process.exit(2);
});
