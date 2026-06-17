#!/usr/bin/env node
/**
 * Doc snippet typecheck.
 *
 * Extracts fenced ```ts / ```typescript blocks from README.md and docs/*.md and
 * typechecks the ones explicitly opted in. A snippet is checked when an HTML
 * comment sits on the line immediately before its opening fence:
 *
 *     <!-- snippet: check -->
 *
 * Opt-in (rather than checking every fence) keeps the harness honest: many doc
 * snippets are deliberately partial fragments (undefined helper steps, output
 * samples) that assert nothing about fascicle's surface. The tagged snippets
 * are the self-contained, copy-pasteable examples — the front door. A tagged
 * snippet that fails to compile is documentation that lies about the API, and
 * this check turns that into a build failure.
 *
 * Modes:
 *   node scripts/check-doc-snippets.mjs           Typecheck against package source (fast, no build)
 *   node scripts/check-doc-snippets.mjs --dist     Typecheck against built dist/*.d.ts (run after build)
 *
 * Exit codes:
 *   0  all checked snippets compile
 *   1  one or more snippets failed to compile
 *   2  orchestrator error (no doc files, tsc missing, etc.)
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, '.check', 'doc-snippets');

const CHECK_MARKER_RE = /<!--\s*snippet:\s*check\s*-->/;
const FENCE_OPEN_RE = /^```(ts|typescript)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

async function doc_files() {
  const files = [join(REPO_ROOT, 'README.md')];
  const docs_dir = join(REPO_ROOT, 'docs');
  for (const name of await readdir(docs_dir)) {
    if (name.endsWith('.md')) files.push(join(docs_dir, name));
  }
  return files;
}

/**
 * Parse a markdown file into its ts/typescript fenced blocks, recording the
 * starting line and whether a skip marker precedes the fence.
 */
function extract_blocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i];
    if (FENCE_OPEN_RE.test(open)) {
      const start_line = i + 1;
      const check = i > 0 && CHECK_MARKER_RE.test(lines[i - 1]);
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ code: body.join('\n'), start_line, check });
    }
    i += 1;
  }
  return blocks;
}

function slug(file) {
  return file
    .replace(`${REPO_ROOT}/`, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function tsconfig_for(mode) {
  // Paths are resolved relative to this generated tsconfig's directory
  // (.check/doc-snippets/), so no baseUrl is needed (baseUrl is deprecated).
  const base = mode === 'dist' ? '../../dist' : '../../packages/fascicle/src';
  // In non-dist mode tsc follows the umbrella source, which imports the internal
  // modules via #-aliases. The generated tsconfig overrides `paths`, so these
  // must be re-declared here (relative to .check/doc-snippets/). The dist bundle
  // has them inlined, so dist mode needs no #-alias paths.
  const module_aliases = {
    '#core': ['../../packages/core/src/index.ts'],
    '#engine': ['../../packages/engine/src/index.ts'],
    '#composites': ['../../packages/composites/src/index.ts'],
    '#observability': ['../../packages/observability/src/index.ts'],
    '#stores': ['../../packages/stores/src/index.ts'],
    '#viewer': ['../../packages/viewer/src/index.ts'],
    '#agents': ['../../packages/agents/src/index.ts'],
  };
  const target =
    mode === 'dist'
      ? {
          fascicle: [`${base}/index.d.ts`],
          'fascicle/adapters': [`${base}/adapters.d.ts`],
          '@repo/fascicle': [`${base}/index.d.ts`],
        }
      : {
          fascicle: [`${base}/index.ts`],
          'fascicle/adapters': [`${base}/adapters.ts`],
          '@repo/fascicle': [`${base}/index.ts`],
          ...module_aliases,
        };
  return {
    extends: '../../tsconfig.json',
    compilerOptions: {
      paths: target,
      noEmit: true,
      // Snippets are typechecked, never emitted: relax the module-emit and
      // style strictness (false positives on illustrative imports and idiomatic
      // process.env access) while keeping the type-correctness flags that catch
      // real API drift.
      verbatimModuleSyntax: false,
      isolatedModules: false,
      noPropertyAccessFromIndexSignature: false,
    },
    // The root tsconfig excludes `.check`; clear it so our snippet files (which
    // live under .check/doc-snippets/) are seen.
    include: ['./*.ts'],
    exclude: [],
  };
}

function run_tsc(tsconfig_path) {
  return new Promise((resolve_exit) => {
    const proc = spawn('pnpm', ['exec', 'tsc', '--noEmit', '-p', tsconfig_path], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => resolve_exit({ code: -1, stdout, stderr: String(err) }));
    proc.on('close', (code) => resolve_exit({ code: code ?? -1, stdout, stderr }));
  });
}

async function main() {
  const mode = process.argv.includes('--dist') ? 'dist' : 'src';

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const files = await doc_files();
  const manifest = [];
  let checked = 0;
  let skipped = 0;

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const blocks = extract_blocks(text);
    let n = 0;
    for (const block of blocks) {
      n += 1;
      if (!block.check) {
        skipped += 1;
        continue;
      }
      const name = `${slug(file)}__${n}.ts`;
      await writeFile(join(OUT_DIR, name), `${block.code}\n`, 'utf8');
      manifest.push({ name, file: file.replace(`${REPO_ROOT}/`, ''), line: block.start_line });
      checked += 1;
    }
  }

  if (checked === 0) {
    console.error('check-doc-snippets: no importing snippets found — refusing to pass vacuously');
    process.exit(2);
  }

  const tsconfig_path = join(OUT_DIR, 'tsconfig.json');
  await writeFile(tsconfig_path, `${JSON.stringify(tsconfig_for(mode), null, 2)}\n`, 'utf8');

  process.stderr.write(
    `▸ check-doc-snippets: typechecking ${checked} snippet(s) against ${mode}` +
      ` (${skipped} skipped)\n`,
  );

  const res = await run_tsc(tsconfig_path);
  const output = `${res.stdout}${res.stderr}`.trim();

  if (res.code === 0) {
    process.stderr.write(`✔ check-doc-snippets: ${checked} snippet(s) compile (${mode})\n`);
    process.exit(0);
  }

  // Map each generated snippet file back to its source doc + line.
  const legend = manifest.map((m) => `  ${m.name}  <-  ${m.file}:${m.line}`).join('\n');
  console.error('\ncheck-doc-snippets: snippet(s) failed to compile:\n');
  console.error(output);
  console.error('\nsnippet -> source map:');
  console.error(legend);
  process.exit(1);
}

main().catch((err) => {
  console.error('check-doc-snippets: orchestrator error:', err);
  process.exit(2);
});
