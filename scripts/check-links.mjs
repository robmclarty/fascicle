#!/usr/bin/env node
/**
 * Relative-markdown-link check.
 *
 * Walks every *.md file under the repo (respecting the exclude set below),
 * parses every inline [text](target) link, and verifies that each relative
 * target exists on disk. External URLs (http://, https://, mailto:) and
 * pure anchors (#...) are skipped. A fragment following # in a relative
 * target is stripped before the existence check; only the file half is
 * validated.
 *
 * Writes .check/links.json:
 *   { ok: true }                        on success
 *   [{ file, line, link, resolved }]    on miss
 *
 * Exit codes:
 *   0  clean
 *   1  at least one broken relative link
 *   2  orchestrator error
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = join(REPO_ROOT, '.check');
const OUTPUT_FILE = join(OUTPUT_DIR, 'links.json');

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  '.check',
  '.stryker-tmp',
  'docs',
  'research',
  '.ridgeline',
  '.git',
  '.fallow',
  'coverage',
  '.pnpm-store',
]);

// Inline allowlist for relative links the checker must tolerate (e.g. links
// whose targets live behind generated paths, or known-to-be-created-by-build
// artifacts). Additions require a justification in the commit message.
const LINK_CHECK_ALLOWLIST = [];

const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;

async function walk_markdown(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      await walk_markdown(full, acc);
      continue;
    }
    if (entry.isFile() && name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

function is_external(target) {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:')
  );
}

function is_bare_anchor(target) {
  return target.startsWith('#');
}

function is_allowlisted(target) {
  return LINK_CHECK_ALLOWLIST.some((re) => re.test(target));
}

function strip_fragment(target) {
  const hash = target.indexOf('#');
  return hash === -1 ? target : target.slice(0, hash);
}

function parse_links(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line)) !== null) {
      hits.push({ line_number: i + 1, target: m[2] ?? '' });
    }
  }
  return hits;
}

async function check_file(md_path) {
  const text = await readFile(md_path, 'utf8');
  const misses = [];
  for (const { line_number, target } of parse_links(text)) {
    if (!target) continue;
    if (is_external(target)) continue;
    if (is_bare_anchor(target)) continue;
    if (is_allowlisted(target)) continue;

    const file_half = strip_fragment(target).trim();
    if (!file_half) continue;

    const base = isAbsolute(file_half)
      ? join(REPO_ROOT, file_half)
      : resolve(dirname(md_path), file_half);

    if (!existsSync(base)) {
      misses.push({
        file: relative(REPO_ROOT, md_path),
        line: line_number,
        link: target,
        resolved: relative(REPO_ROOT, base),
      });
    }
  }
  return misses;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const files = await walk_markdown(REPO_ROOT, []);
  const all_misses = [];
  for (const f of files) {
    const misses = await check_file(f);
    all_misses.push(...misses);
  }

  if (all_misses.length === 0) {
    await writeFile(OUTPUT_FILE, `${JSON.stringify({ ok: true }, null, 2)}\n`);
    return;
  }

  await writeFile(OUTPUT_FILE, `${JSON.stringify(all_misses, null, 2)}\n`);
  for (const m of all_misses) {
    console.error(
      `check-links: broken link in ${m.file}:${m.line} -> ${m.link} (resolved: ${m.resolved})`,
    );
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('check-links: orchestrator error:', err);
  process.exit(2);
});
