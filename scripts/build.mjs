#!/usr/bin/env node
/**
 * Build the umbrella fascicle bundle via tsdown.
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
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const DIST_JS = join(DIST_DIR, 'index.js');
const DIST_DTS = join(DIST_DIR, 'index.d.ts');
const DIST_ADAPTERS_JS = join(DIST_DIR, 'adapters.js');
const DIST_ADAPTERS_DTS = join(DIST_DIR, 'adapters.d.ts');
const DIST_AGENTS_JS = join(DIST_DIR, 'agents.js');
const DIST_AGENTS_DTS = join(DIST_DIR, 'agents.d.ts');
const DIST_MCP_JS = join(DIST_DIR, 'mcp.js');
const DIST_MCP_DTS = join(DIST_DIR, 'mcp.d.ts');
const DIST_OTEL_JS = join(DIST_DIR, 'otel.js');
const DIST_OTEL_DTS = join(DIST_DIR, 'otel.d.ts');
const DIST_STDIO_JS = join(DIST_DIR, 'stdio.js');
const DIST_STDIO_DTS = join(DIST_DIR, 'stdio.d.ts');
const DIST_TESTING_JS = join(DIST_DIR, 'testing.js');
const DIST_TESTING_DTS = join(DIST_DIR, 'testing.d.ts');
const DIST_UI_JS = join(DIST_DIR, 'ui.js');
const DIST_UI_DTS = join(DIST_DIR, 'ui.d.ts');
const DIST_VIEWER_JS = join(DIST_DIR, 'viewer.js');
const DIST_VIEWER_DTS = join(DIST_DIR, 'viewer.d.ts');
const DIST_STATIC_DIR = join(DIST_DIR, 'static');
const DIST_STATIC_HTML = join(DIST_STATIC_DIR, 'viewer.html');
const VIEWER_HTML_SRC = join(REPO_ROOT, 'src', 'viewer', 'static', 'viewer.html');
const DIST_BIN_DIR = join(DIST_DIR, 'bin');
const DIST_BIN_VIEWER = join(DIST_BIN_DIR, 'fascicle-viewer.js');

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
  const chunk_files = (await readdir(DIST_DIR)).filter((f) => f.endsWith('.js'));
  const chunk_texts = new Map();
  for (const chunk_file of chunk_files) {
    chunk_texts.set(chunk_file, await readFile(join(DIST_DIR, chunk_file), 'utf8'));
  }
  const all_text = [...chunk_texts.values()].join('\n');

  // Internal modules MUST be inlined: neither the old workspace names (@repo/*)
  // nor the #-import aliases may survive in any published chunk.
  const repo_static = /from\s+["']@repo\//.test(all_text);
  const repo_dynamic = /import\(\s*["']@repo\//.test(all_text);
  if (repo_static || repo_dynamic) {
    console.error(`\nbuild: @repo/* appears in dist — internal modules were not inlined`);
    process.exit(1);
  }
  const hash_static = /from\s+["']#/.test(all_text);
  const hash_dynamic = /import\(\s*["']#/.test(all_text);
  if (hash_static || hash_dynamic) {
    console.error(`\nbuild: #-import alias appears in dist — internal modules were not inlined`);
    process.exit(1);
  }

  // `ai` is reached lazily: generate.ts imports the ai_sdk turn seam with
  // `await import(...)`. A static `from 'ai'` edge on any consumer path is
  // what once put the SDK on every consumer's graph, native transports
  // included. The seam may land in any chunk (once another entry shares
  // engine values, the bundler hoists engine into a common chunk), so the
  // invariant is checked across all of dist: whichever chunk imports `ai`
  // must keep it external and be reached only through a dynamic import.
  // Only the root entry's graph is constrained: fascicle/ui interops with AI
  // SDK UI messages and imports `ai` statically on purpose, and a consumer of
  // that subpath has opted in. Walk the static closure of index.js.
  const static_deps = (text) =>
    [...text.matchAll(/(?:from\s+|import\s+)["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
  const closure = new Set(['index.js']);
  const queue = ['index.js'];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dep of static_deps(chunk_texts.get(current) ?? '')) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }
  const static_ai = [...closure].filter((f) => /from\s+["']ai["']/.test(chunk_texts.get(f) ?? ''));
  if (static_ai.length > 0) {
    console.error(
      `\nbuild: the root entry statically reaches 'ai' via ${static_ai.join(', ')}; the ai_sdk seam must stay lazy`,
    );
    process.exit(1);
  }
  const dynamic_targets = [...closure].flatMap((f) =>
    [...(chunk_texts.get(f) ?? '').matchAll(/import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g)].map(
      (m) => m[1],
    ),
  );
  const seam_chunks = dynamic_targets.filter((t) =>
    /from\s+["']ai["']/.test(chunk_texts.get(t) ?? ''),
  );
  if (seam_chunks.length === 0) {
    console.error(
      `\nbuild: no dynamic chunk import from the root entry reaches 'ai'; the ai_sdk seam was inlined or dropped`,
    );
    process.exit(1);
  }

  // `zod` is no longer imported as a value anywhere fascicle's own code runs:
  // its one remaining site (src/mcp/serve.ts) is `import type`, erased at
  // build time, so no dist chunk should carry a runtime `from 'zod'` either.
  const closure_text = [...closure].map((f) => chunk_texts.get(f) ?? '').join('\n');
  if (/from\s+["']zod["']/.test(closure_text)) {
    console.error(`\nbuild: the root entry statically imports 'zod'; it should be type-only now`);
    process.exit(1);
  }

  // Optional peers (`@ai-sdk/*`, `ai-sdk-ollama`, `@openrouter/ai-sdk-provider`)
  // are loaded via `await import('<specifier>')` inside provider adapters.
  // They are external-by-dynamic-import; the bundler preserves the literal
  // specifier. Assert the `@ai-sdk/` family appears as a specifier substring.
  if (!/["']@ai-sdk\//.test(closure_text)) {
    console.error(
      `\nbuild: root entry graph missing any \`@ai-sdk/\` specifier; optional peers were not preserved as externals`,
    );
    process.exit(1);
  }

  process.stderr.write(`▸ build: copying viewer static assets\n`);
  await mkdir(DIST_STATIC_DIR, { recursive: true });
  await copyFile(VIEWER_HTML_SRC, DIST_STATIC_HTML);
  const html_stat = await stat(DIST_STATIC_HTML);
  if (html_stat.size === 0) {
    console.error(`\nbuild: ${DIST_STATIC_HTML} copied as empty file`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: writing fascicle-viewer bin shim\n`);
  await mkdir(DIST_BIN_DIR, { recursive: true });
  await write_viewer_bin_shim(DIST_BIN_VIEWER);

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

  process.stderr.write(`▸ build: smoke-importing ${DIST_ADAPTERS_JS}\n`);
  if (!existsSync(DIST_ADAPTERS_JS) || !existsSync(DIST_ADAPTERS_DTS)) {
    console.error(`\nbuild: dist/adapters.{js,d.ts} were not produced (the ./adapters subpath)`);
    process.exit(1);
  }
  const adapters_mod = await import(pathToFileURL(DIST_ADAPTERS_JS).href);
  const EXPECTED_ADAPTERS = [
    'filesystem_logger',
    'http_logger',
    'noop_logger',
    'stderr_logger',
    'tee_logger',
    'filesystem_store',
  ];
  const missing_adapters = EXPECTED_ADAPTERS.filter((name) => typeof adapters_mod[name] === 'undefined');
  if (missing_adapters.length > 0) {
    console.error(`\nbuild: adapters smoke test missing exports: ${missing_adapters.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_AGENTS_JS}\n`);
  if (!existsSync(DIST_AGENTS_JS) || !existsSync(DIST_AGENTS_DTS)) {
    console.error(`\nbuild: dist/agents.{js,d.ts} were not produced (the ./agents subpath)`);
    process.exit(1);
  }
  const agents_mod = await import(pathToFileURL(DIST_AGENTS_JS).href);
  const EXPECTED_AGENTS = ['define_agent'];
  const missing_agents = EXPECTED_AGENTS.filter((name) => typeof agents_mod[name] === 'undefined');
  if (missing_agents.length > 0) {
    console.error(`\nbuild: agents smoke test missing exports: ${missing_agents.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_MCP_JS}\n`);
  if (!existsSync(DIST_MCP_JS) || !existsSync(DIST_MCP_DTS)) {
    console.error(`\nbuild: dist/mcp.{js,d.ts} were not produced (the ./mcp subpath)`);
    process.exit(1);
  }
  const mcp_mod = await import(pathToFileURL(DIST_MCP_JS).href);
  const EXPECTED_MCP = ['mcp_client', 'serve_flow', 'json_schema_to_standard'];
  const missing_mcp = EXPECTED_MCP.filter((name) => typeof mcp_mod[name] === 'undefined');
  if (missing_mcp.length > 0) {
    console.error(`\nbuild: mcp smoke test missing exports: ${missing_mcp.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_OTEL_JS}\n`);
  if (!existsSync(DIST_OTEL_JS) || !existsSync(DIST_OTEL_DTS)) {
    console.error(`\nbuild: dist/otel.{js,d.ts} were not produced (the ./otel subpath)`);
    process.exit(1);
  }
  const otel_mod = await import(pathToFileURL(DIST_OTEL_JS).href);
  const EXPECTED_OTEL = ['create_otel_trajectory_logger'];
  const missing_otel = EXPECTED_OTEL.filter((name) => typeof otel_mod[name] === 'undefined');
  if (missing_otel.length > 0) {
    console.error(`\nbuild: otel smoke test missing exports: ${missing_otel.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_STDIO_JS}\n`);
  if (!existsSync(DIST_STDIO_JS) || !existsSync(DIST_STDIO_DTS)) {
    console.error(`\nbuild: dist/stdio.{js,d.ts} were not produced (the ./stdio subpath)`);
    process.exit(1);
  }
  const stdio_mod = await import(pathToFileURL(DIST_STDIO_JS).href);
  const EXPECTED_STDIO = ['run_stdio', 'execute_stdio'];
  const missing_stdio = EXPECTED_STDIO.filter((name) => typeof stdio_mod[name] === 'undefined');
  if (missing_stdio.length > 0) {
    console.error(`\nbuild: stdio smoke test missing exports: ${missing_stdio.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_TESTING_JS}\n`);
  if (!existsSync(DIST_TESTING_JS) || !existsSync(DIST_TESTING_DTS)) {
    console.error(`\nbuild: dist/testing.{js,d.ts} were not produced (the ./testing subpath)`);
    process.exit(1);
  }
  const testing_mod = await import(pathToFileURL(DIST_TESTING_JS).href);
  const EXPECTED_TESTING = ['make_stub_engine', 'make_capture_engine'];
  const missing_testing = EXPECTED_TESTING.filter((name) => typeof testing_mod[name] === 'undefined');
  if (missing_testing.length > 0) {
    console.error(`\nbuild: testing smoke test missing exports: ${missing_testing.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_UI_JS}\n`);
  if (!existsSync(DIST_UI_JS) || !existsSync(DIST_UI_DTS)) {
    console.error(`\nbuild: dist/ui.{js,d.ts} were not produced (the ./ui subpath)`);
    process.exit(1);
  }
  const ui_mod = await import(pathToFileURL(DIST_UI_JS).href);
  const EXPECTED_UI = ['to_ui_message_response', 'pipe_ui_message_stream_to_response', 'to_ui_message_chunks'];
  const missing_ui = EXPECTED_UI.filter((name) => typeof ui_mod[name] === 'undefined');
  if (missing_ui.length > 0) {
    console.error(`\nbuild: ui smoke test missing exports: ${missing_ui.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(`▸ build: smoke-importing ${DIST_VIEWER_JS}\n`);
  if (!existsSync(DIST_VIEWER_JS) || !existsSync(DIST_VIEWER_DTS)) {
    console.error(`\nbuild: dist/viewer.{js,d.ts} were not produced (the ./viewer subpath)`);
    process.exit(1);
  }
  const viewer_mod = await import(pathToFileURL(DIST_VIEWER_JS).href);
  const EXPECTED_VIEWER = ['start_viewer', 'run_viewer_cli', 'create_broadcaster', 'start_server', 'start_tail'];
  const missing_viewer = EXPECTED_VIEWER.filter((name) => typeof viewer_mod[name] === 'undefined');
  if (missing_viewer.length > 0) {
    console.error(`\nbuild: viewer smoke test missing exports: ${missing_viewer.join(', ')}`);
    process.exit(1);
  }

  process.stderr.write(
    `\n✔ build ok (${js_stat.size} bytes js, ${dts_stat.size} bytes d.ts, ${EXPECTED_NAMED.length} named exports + describe.json + ${EXPECTED_ADAPTERS.length} adapters + ${EXPECTED_AGENTS.length} agents + ${EXPECTED_MCP.length} mcp + ${EXPECTED_OTEL.length} otel + ${EXPECTED_STDIO.length} stdio + ${EXPECTED_TESTING.length} testing + ${EXPECTED_UI.length} ui + ${EXPECTED_VIEWER.length} viewer verified)\n`,
  );
}

async function write_viewer_bin_shim(path) {
  const { writeFile, chmod } = await import('node:fs/promises');
  const shim = `#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist_viewer = resolve(here, '..', 'viewer.js');
const mod = await import(pathToFileURL(dist_viewer).href);
await mod.run_viewer_cli(process.argv.slice(2));
`;
  await writeFile(path, shim, 'utf8');
  await chmod(path, 0o755);
}

main().catch((err) => {
  console.error('build: orchestrator error:', err);
  process.exit(2);
});
