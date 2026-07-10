#!/usr/bin/env node
/**
 * Version bumper — backend for the `/version` skill.
 *
 * The repo is one package with one manifest, so a bump rewrites a single
 * file: the root `package.json` version field. Accepts raw arguments
 * matching the `/version` skill's `$ARGUMENTS`:
 *
 *   patch | minor | major          → standard bump
 *   --bump <type>                   → legacy form, still supported
 *
 * Pre-flight: the working tree must be clean — a release commit must contain
 * only the bump + CHANGELOG; mixing in WIP is the bug we're refusing to ship.
 *
 * Always emits exactly one JSON object to stdout — the skill consumes this
 * directly. The `mode` field tells the caller what happened:
 *
 *   { mode: 'bump',  old, new, since }
 *   { mode: 'error', error_type, message }
 *
 * `since` on a successful bump is the SHA of the previous release — the commit
 * the most recent `vX.Y.Z` git tag reachable from HEAD points at. The tag is
 * the authoritative release marker: it is what triggers the publish workflow.
 * The skill uses `since` as the left boundary for the CHANGELOG commit range.
 * If no prior release exists, `since` is null and the skill treats this as
 * the initial release.
 *
 * Exit codes:
 *   0  bump succeeded
 *   1  expected failure (dirty_tree, usage) — JSON still on stdout
 *   2  unexpected runtime crash — JSON still on stdout if possible
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PKG = join(REPO_ROOT, 'package.json');

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function emit_error(error_type, message) {
  emit({ mode: 'error', error_type, message });
  process.exit(1);
}

function parse_args(argv) {
  const args = argv.slice(2);
  let bump_type = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bump') {
      const next = args[i + 1];
      if (!next) return { error: '--bump requires a value (patch|minor|major)' };
      if (!['patch', 'minor', 'major'].includes(next)) {
        return { error: `invalid --bump value: ${next} (expected patch|minor|major)` };
      }
      bump_type = next;
      i++;
    } else if (['patch', 'minor', 'major'].includes(a)) {
      bump_type = a;
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  return { bump_type };
}

function check_clean_tree() {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    return { ok: false, runtime_error: `git status failed: ${err.message}` };
  }
  const trimmed = out.trim();
  if (trimmed === '') return { ok: true };
  return { ok: false, dirty_files: trimmed.split('\n') };
}

// Find the SHA of the previous release. Releases are marked by an annotated
// `vX.Y.Z` git tag — the tag is the authoritative marker (it is what triggers
// the publish workflow), so the most recent release tag reachable from HEAD is
// the correct left boundary even when the tagged commit was not itself messaged
// `vX.Y.Z` (e.g. a tag placed on a merge or checkpoint commit). Falls back to
// the older commit-message convention only when no release tag is reachable,
// and returns null when there is no prior release at all (the skill interprets
// that as "first release, summarize all history").
function find_previous_release_sha() {
  // Primary: the most recent semver-shaped tag reachable from HEAD, resolved to
  // the commit it points at.
  try {
    const tag = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', 'HEAD'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (tag !== '') {
      const sha = execFileSync('git', ['rev-list', '-n', '1', tag], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      if (sha !== '') return sha;
    }
  } catch {
    // No release tag reachable — fall through to the commit-message fallback.
  }
  // Fallback: a commit whose message is exactly `vX.Y.Z` (the convention from
  // before releases were tag-triggered).
  try {
    const out = execFileSync(
      'git',
      ['log', '-E', '--grep=^v[0-9]+\\.[0-9]+\\.[0-9]+$', '-1', '--pretty=%H'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const sha = out.trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

function bump_semver(current, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`unparseable semver: ${current}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump type: ${type}`);
}

function detect_indent(text) {
  const m = text.match(/^([ \t]+)"/m);
  return m ? m[1] : 2;
}

async function mode_bump(bump_type) {
  const tree = check_clean_tree();
  if (!tree.ok) {
    if (tree.runtime_error) emit_error('runtime', tree.runtime_error);
    const lines = tree.dirty_files.map((l) => `  ${l}`).join('\n');
    emit_error(
      'dirty_tree',
      `working tree is not clean — refusing to bump.\n` +
        `  a release commit must contain only the version bump + CHANGELOG.\n` +
        `  uncommitted changes:\n${lines}`,
    );
  }

  const text = await readFile(ROOT_PKG, 'utf8');
  const pkg = JSON.parse(text);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    emit_error('runtime', 'root package.json is missing a `version` field');
  }
  const current = pkg.version;
  const next = bump_semver(current, bump_type);
  const since = find_previous_release_sha();

  pkg.version = next;
  const trailing = text.endsWith('\n') ? '\n' : '';
  await writeFile(ROOT_PKG, `${JSON.stringify(pkg, null, detect_indent(text))}${trailing}`);

  emit({ mode: 'bump', old: current, new: next, since });
}

async function main() {
  const parsed = parse_args(process.argv);
  if (parsed.error) emit_error('usage', parsed.error);
  if (!parsed.bump_type) {
    emit_error('usage', 'no arguments — pass `patch`, `minor`, or `major` to bump.');
  }
  await mode_bump(parsed.bump_type);
}

main().catch((err) => {
  try {
    emit({ mode: 'error', error_type: 'runtime', message: err.stack ?? err.message });
  } catch {
    process.stderr.write(`bump-version: orchestrator error: ${err.stack ?? err.message}\n`);
  }
  process.exit(2);
});
