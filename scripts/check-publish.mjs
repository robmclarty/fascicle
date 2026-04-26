#!/usr/bin/env node
/**
 * Publish preflight.
 *
 *   1. `npm pack --dry-run --json` — confirm the tarball contains the
 *      expected files and excludes source, tests, and internal artifacts.
 *   2. `@arethetypeswrong/cli` against ./dist/ — Node-ESM type resolution
 *      must be clean.
 *   3. Re-assert the version-lockstep invariant across the root
 *      package.json, every packages/*\/package.json, and both
 *      packages/{core,engine}/src/version.ts constants.
 *
 * Exit codes:
 *   0  ready to publish
 *   1  preflight failure
 *   2  orchestrator error
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  enumerate_lockstep,
  read_current_version,
} from './lib/lockstep.mjs';

const ROOT_PKG = join(REPO_ROOT, 'package.json');

const REQUIRED_FILES = ['dist/index.js', 'dist/index.d.ts', 'README.md', 'CHANGELOG.md'];
const FORBIDDEN_PATH_PATTERNS = [
  /\.ts$/,                     // no TypeScript source in pack (dist .d.ts is allowed separately)
  /\.test\./,                  // no test files
  /(^|\/)\.ridgeline(\/|$)/,
  /(^|\/)docs(\/|$)/,
  /(^|\/)research(\/|$)/,
  /(^|\/)\.stryker-tmp(\/|$)/,
  /(^|\/)\.check(\/|$)/,
  /(^|\/)rules(\/|$)/,
  /(^|\/)scripts(\/|$)/,
  /(^|\/)packages\/[^/]+\/src(\/|$)/,
];
const REQUIRED_FILE_EXEMPT = new Set(REQUIRED_FILES);

function fail(msg) {
  console.error(`check-publish: ${msg}`);
  process.exit(1);
}

async function read_pkg(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function run_subprocess(cmd, args, env_overrides = {}) {
  return new Promise((resolve_exit) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env_overrides },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => resolve_exit({ code: -1, stdout, stderr, error: err.message }));
    proc.on('close', (code) => resolve_exit({ code: code ?? -1, stdout, stderr }));
  });
}

async function check_pack_contents() {
  process.stderr.write(`▸ check-publish: npm pack --dry-run\n`);
  const res = await run_subprocess('npm', ['pack', '--dry-run', '--json']);
  if (res.code !== 0) {
    fail(`npm pack --dry-run exited with code ${res.code}:\n${res.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    fail(`npm pack JSON parse failed: ${err.message}\n${res.stdout.slice(0, 500)}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    fail(`npm pack output missing \`files\` array`);
  }
  const file_paths = entry.files.map((f) => f.path);

  for (const required of REQUIRED_FILES) {
    if (!file_paths.includes(required)) {
      fail(`pack is missing required file: ${required}\n  present: ${file_paths.join(', ')}`);
    }
  }

  const bad = [];
  for (const p of file_paths) {
    if (REQUIRED_FILE_EXEMPT.has(p)) continue;
    for (const re of FORBIDDEN_PATH_PATTERNS) {
      if (re.test(p)) {
        // dist/index.d.ts is required but matches /\.ts$/ via the `.d.ts`
        // suffix; whitelist only dist/*.d.ts, block everything else.
        if (p.startsWith('dist/') && p.endsWith('.d.ts')) break;
        if (p.startsWith('dist/') && p.endsWith('.d.ts.map')) break;
        bad.push({ path: p, pattern: re.source });
        break;
      }
    }
  }
  if (bad.length > 0) {
    fail(
      `pack contains forbidden paths:\n${bad
        .map((b) => `  - ${b.path} (matched /${b.pattern}/)`)
        .join('\n')}`,
    );
  }

  console.log(`check-publish: pack ok (${file_paths.length} file(s): ${file_paths.join(', ')})`);
}

async function check_types_wrong() {
  // Pin: @arethetypeswrong/cli 0.18.2 is the invoked version. It has one
  // known false positive on ESM-only packages (`CJSResolvesToESM` under
  // `node16-cjs`), which we explicitly allowlist below since the package
  // is intentionally ESM-only (constraints.md §1).
  //
  // When `check:publish` is invoked from inside `pnpm publish`'s
  // `prepublishOnly` hook, `npm pack` silently writes the tarball to an
  // unreachable staging path — pnpm/npm publish lifecycle interaction we
  // can't work around from inside the hook. Skip the attw arm in that case
  // (detected via `npm_command=publish`); the standalone `pnpm check:publish`
  // run (criterion 27, 30) will already have exercised attw with full
  // fidelity, and the outer `pnpm publish --dry-run` is not a release-
  // certifier — it just confirms publishability mechanics.
  // Running attw's built-in `--pack` form fails inside a `prepublishOnly`
  // hook (attw shells out to `npm pack`). We pack the tarball ourselves
  // and pass the tgz path to attw. We must scrub `npm_config_dry_run` from
  // the inherited env: when invoked from `pnpm publish --dry-run`'s
  // `prepublishOnly`, that env is set, which silently turns our nested
  // `npm pack` into a no-op (it prints success but writes nothing).
  process.stderr.write(`▸ check-publish: packing tarball for @arethetypeswrong/cli\n`);
  const root_pkg = await read_pkg(ROOT_PKG);
  // npm pack's tarball name: scopes slugify from `@scope/name` → `scope-name`.
  const slug = String(root_pkg.name).replace(/^@/, '').replace('/', '-');
  const tgz_name = `${slug}-${root_pkg.version}.tgz`;
  // Force the pack destination explicitly. When invoked via `pnpm publish`'s
  // `prepublishOnly` hook, pnpm may stage the package into a temporary
  // directory and silently redirect tarballs there; `--pack-destination`
  // pins the landing directory to somewhere we can find afterward.
  const pack_dest = join(REPO_ROOT, '.check');
  await mkdir(pack_dest, { recursive: true });
  const tgz_path = join(pack_dest, tgz_name);

  // Override `npm_config_dry_run` (set by `pnpm publish --dry-run` and
  // inherited via env) so this nested `npm pack` actually writes the file.
  const pack_res = await run_subprocess(
    'npm',
    ['pack', '--pack-destination', pack_dest],
    { npm_config_dry_run: 'false' },
  );
  if (pack_res.code !== 0) {
    fail(`npm pack (real) exited with code ${pack_res.code}:\n${pack_res.stderr || pack_res.stdout}`);
  }
  if (!existsSync(tgz_path)) {
    fail(
      `npm pack did not produce expected tarball at ${tgz_path}\n` +
        `  stdout: ${pack_res.stdout}\n` +
        `  stderr: ${pack_res.stderr}`,
    );
  }

  process.stderr.write(`▸ check-publish: @arethetypeswrong/cli (${tgz_name})\n`);
  const res = await run_subprocess('pnpm', [
    'exec',
    'attw',
    tgz_path,
    '--profile',
    'node16',
    '--format',
    'json',
  ]);
  // Whatever happens below, always clean up the tarball.
  const cleanup = async () => {
    try { await rm(tgz_path, { force: true }); } catch { /* best-effort */ }
  };
  // attw exits 0 when clean, 1 when any problem is found. stdout is JSON.
  // We read the JSON rather than rely on exit code alone to get a useful
  // error surface.
  const text = res.stdout.trim();
  if (!text) {
    await cleanup();
    if (res.code !== 0) {
      fail(`attw produced no output and exited ${res.code}:\n${res.stderr}`);
    }
    console.log(`check-publish: attw ok (no output, exit 0)`);
    return;
  }

  let report;
  try {
    report = JSON.parse(text);
  } catch (err) {
    await cleanup();
    if (res.code !== 0) {
      fail(`attw failed (exit ${res.code}):\n${res.stderr}\n${text.slice(0, 1000)}`);
    }
    fail(`attw JSON parse failed: ${err.message}`);
  }

  await cleanup();

  await mkdir(join(REPO_ROOT, '.check'), { recursive: true });
  await writeFile(join(REPO_ROOT, '.check', 'attw.json'), `${JSON.stringify(report, null, 2)}\n`);

  const problems = report?.analysis?.problems ?? [];
  // Node-ESM hard errors we always fail on. CJSResolvesToESM is emitted for
  // ESM-only packages whenever a CJS consumer resolves the entry point; it
  // is informational, not a Node-ESM bug. The package is intentionally
  // ESM-only (constraints.md §1: module format ESM only, no CJS output).
  const hard_errors = problems.filter((p) =>
    ['NoResolution', 'UntypedResolution', 'FalseESM', 'InternalResolutionError'].includes(p.kind),
  );
  if (hard_errors.length > 0) {
    fail(
      `attw found ${hard_errors.length} Node-ESM resolution problem(s):\n${hard_errors
        .map((p) => `  - ${p.kind} at ${p.resolutionKind ?? ''} ${p.entrypoint ?? ''}`)
        .join('\n')}`,
    );
  }
  console.log(
    `check-publish: attw ok (0 hard errors, ${problems.length} informational problem(s); see .check/attw.json)`,
  );
}

async function check_version_lockstep() {
  // The lockstep enumeration here is shared with scripts/check-deps.mjs and
  // scripts/bump-version.mjs via scripts/lib/lockstep.mjs. One source of
  // truth; don't re-derive the file list locally.
  const files = await enumerate_lockstep();
  const root_file = files.find((f) => f.kind === 'root_pkg');
  if (!root_file) fail('root package.json not found in lockstep enumeration');

  const root_version = await read_current_version(root_file).catch((err) => fail(err.message));
  if (typeof root_version !== 'string' || root_version.length === 0) {
    fail(`root package.json is missing a \`version\` field`);
  }

  let pkg_count = 0;
  let ts_count = 0;
  for (const file of files) {
    if (file === root_file) continue;
    const v = await read_current_version(file).catch((err) => fail(err.message));
    if (v !== root_version) {
      fail(`version skew: ${file.path} is "${v}" but root is "${root_version}"`);
    }
    if (file.kind === 'package_pkg') pkg_count++;
    if (file.kind === 'version_ts') ts_count++;
  }

  console.log(
    `check-publish: lockstep ok (root ${root_version} = ${pkg_count} package(s) + ${ts_count} version.ts constant(s))`,
  );
}

async function main() {
  await check_version_lockstep();
  await check_pack_contents();
  await check_types_wrong();
  console.log(`\ncheck-publish: ready to publish`);
}

main().catch((err) => {
  console.error('check-publish: orchestrator error:', err);
  process.exit(2);
});
