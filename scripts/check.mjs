#!/usr/bin/env node
/**
 * Check orchestrator.
 *
 * Runs the check pipeline, captures per-tool output (JSON where supported), and
 * writes an aggregate report to .check/summary.json that agents can parse.
 *
 * Usage:
 *   node scripts/check.mjs                    Run default checks (excludes opt-in), human-readable output
 *   node scripts/check.mjs --json             Machine-readable output to stdout
 *   node scripts/check.mjs --bail             Stop at the first failure
 *   node scripts/check.mjs --only types,lint
 *   node scripts/check.mjs --skip docs,spell
 *   node scripts/check.mjs --include mutation  Add opt-in checks on top of the default set
 *   node scripts/check.mjs --all               Run every check, including opt-in ones
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 *   2  orchestrator error (missing tool, IO failure, etc.)
 *
 * Design notes:
 *   - Procedural, no classes.
 *   - Each check is a plain data object. To add a check, append to CHECKS.
 *   - Each tool writes its raw output to .check/<name>.{json,txt}.
 *   - The orchestrator never parses diagnostics itself; agents read the tool
 *     JSON directly. This keeps the orchestrator dumb and upgrade-proof.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const OUTPUT_DIR = '.check';

// Check catalogue. Order matters: cheapest first for fast-bail feedback loops.
const CHECKS = [
  {
    name: 'types',
    description: 'TypeScript type checking',
    command: 'pnpm',
    args: ['exec', 'tsc', '--noEmit'],
    output_file: null,
  },
  {
    name: 'lint',
    description: 'Oxlint with tsgolint type-aware rules',
    command: 'pnpm',
    args: ['exec', 'oxlint', '--type-aware', '--format=json'],
    output_file: 'lint.json',
  },
  {
    name: 'struct',
    description: 'Structural rules (ast-grep)',
    command: 'pnpm',
    args: ['exec', 'ast-grep', 'scan', '--json=compact'],
    output_file: 'struct.json',
  },
  {
    name: 'deps',
    description: 'core/engine production deps + engine optional peers invariant (constraints.md §7.2)',
    command: 'node',
    args: ['scripts/check-deps.mjs'],
    output_file: null,
  },
  {
    name: 'dead',
    description: 'Fallow: dead code, cycles, duplication, boundaries, complexity',
    command: 'pnpm',
    args: ['exec', 'fallow', '--format', 'json'],
    output_file: 'dead.json',
  },
  {
    name: 'test',
    description: 'Vitest tests with coverage',
    command: 'pnpm',
    args: [
      'exec', 'vitest', 'run',
      '--coverage',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=.check/test.json',
    ],
    output_file: null, // vitest writes its own file via --outputFile
  },
  {
    name: 'mutation',
    description: 'Stryker mutation testing (incremental)',
    command: 'pnpm',
    args: ['exec', 'stryker', 'run'],
    output_file: null, // stryker's jsonReporter writes .check/mutation.json directly
    opt_in: true,
  },
  {
    name: 'docs',
    description: 'Markdown linting',
    command: 'pnpm',
    args: ['exec', 'markdownlint-cli2'],
    output_file: null,
  },
  {
    name: 'links',
    description: 'Relative markdown link targets exist on disk',
    command: 'node',
    args: ['scripts/check-links.mjs'],
    output_file: 'links.json',
  },
  {
    name: 'spell',
    description: 'Spell check',
    command: 'pnpm',
    args: ['exec', 'cspell', '--no-progress', '--no-summary', '--reporter=default'],
    output_file: null,
  },
];

/**
 * Run a single check as a subprocess. Returns a result record.
 */
function run_check(check) {
  return new Promise((resolve) => {
    const start = performance.now();
    const proc = spawn(check.command, check.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      resolve({
        name: check.name,
        description: check.description,
        ok: false,
        exit_code: -1,
        duration_ms: Math.round(performance.now() - start),
        error: `Failed to spawn: ${err.message}`,
        stdout: '',
        stderr: '',
      });
    });

    proc.on('close', (code) => {
      resolve({
        name: check.name,
        description: check.description,
        ok: code === 0,
        exit_code: code ?? -1,
        duration_ms: Math.round(performance.now() - start),
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Persist per-check output. JSON-emitting tools write to .check/<name>.json
 * (validated), everything else writes raw text to .check/<name>.txt.
 */
async function persist_output(check, result) {
  if (check.output_file && result.stdout.trim()) {
    try {
      JSON.parse(result.stdout);
      await writeFile(join(OUTPUT_DIR, check.output_file), result.stdout);
      return;
    } catch {
      // Fall through to text output below.
    }
  }
  if (result.stdout.trim()) {
    await writeFile(join(OUTPUT_DIR, `${check.name}.stdout.txt`), result.stdout);
  }
  if (result.stderr.trim()) {
    await writeFile(join(OUTPUT_DIR, `${check.name}.stderr.txt`), result.stderr);
  }
}

function parse_list(value) {
  if (!value) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function select_checks(all, only, skip, include, runAll) {
  const skipSet = new Set(skip ?? []);
  const includeSet = new Set(include ?? []);
  return all.filter((c) => {
    if (only) return only.includes(c.name);
    if (skipSet.has(c.name)) return false;
    if (c.opt_in && !runAll && !includeSet.has(c.name)) return false;
    return true;
  });
}

function format_status_line(result) {
  const mark = result.ok ? '\u2714' : '\u2718';
  const name = result.name.padEnd(8);
  const duration = `${result.duration_ms}ms`.padStart(8);
  return `  ${mark} ${name} ${duration}  ${result.description}`;
}

function write_line(stream, line) {
  stream.write(`${line}\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      bail: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      only: { type: 'string' },
      skip: { type: 'string' },
      include: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });

  await mkdir(OUTPUT_DIR, { recursive: true });

  const only = parse_list(values.only);
  const skip = parse_list(values.skip);
  const include = parse_list(values.include);
  const selected = select_checks(CHECKS, only, skip, include, values.all);

  if (!values.json) {
    write_line(process.stderr, `\nRunning ${selected.length} check(s)...\n`);
  }

  const results = [];
  for (const check of selected) {
    if (!values.json) {
      write_line(process.stderr, `  \u25B8 ${check.name}  ${check.description}`);
    }
    const result = await run_check(check);
    await persist_output(check, result);
    results.push(result);
    if (!values.json) {
      write_line(process.stderr, format_status_line(result));
    }
    if (!result.ok && values.bail) break;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    ok: results.every((r) => r.ok),
    total_duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
    checks: results.map((r) => ({
      name: r.name,
      description: r.description,
      ok: r.ok,
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      output_file: CHECKS.find((c) => c.name === r.name)?.output_file ?? null,
    })),
  };

  await writeFile(
    join(OUTPUT_DIR, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  if (values.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    write_line(process.stderr, '');
    const status = summary.ok ? '\u2714 all checks passed' : '\u2718 one or more checks failed';
    write_line(process.stderr, `${status} in ${summary.total_duration_ms}ms`);
    write_line(process.stderr, `report: ${OUTPUT_DIR}/summary.json`);
    write_line(process.stderr, '');
  }

  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('orchestrator error:', err);
  process.exit(2);
});
