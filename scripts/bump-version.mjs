#!/usr/bin/env node
/**
 * Lockstep version bumper — backend for the `/version` skill.
 *
 * Accepts raw arguments matching the `/version` skill's `$ARGUMENTS`:
 *
 *   patch | minor | major          → standard bump
 *   --repair-skew                   → force-align without bumping
 *   <type> --repair-skew            → repair (bump type ignored)
 *   --bump <type>                   → legacy form, still supported
 *
 * Pre-flight (bump mode only):
 *   - working tree must be clean (a release commit must contain only the
 *     bump + CHANGELOG; mixing in WIP is the bug we're refusing to ship),
 *   - every LOCKSTEP_SET file must already carry the root's current version.
 *
 * Always emits exactly one JSON object to stdout — the skill consumes this
 * directly. The `mode` field tells the caller what happened:
 *
 *   { mode: 'bump',        old, new, since, files: [...], changed_count }
 *   { mode: 'repair-skew', old, new,        files: [...], changed_count }
 *   { mode: 'error',       error_type, message }
 *
 * `since` on a successful bump is the SHA of the previous `vX.Y.Z` release
 * commit (the repo's release-marker convention — see `taste.md` Principle
 * 16). The skill uses it as the left boundary for the CHANGELOG commit range.
 * If no prior release exists, `since` is null and the skill treats this as
 * the initial release.
 *
 * Exit codes:
 *   0  bump or repair-skew succeeded
 *   1  expected failure (dirty_tree, skew, usage) — JSON still on stdout
 *   2  unexpected runtime crash — JSON still on stdout if possible
 */

import { execFileSync } from 'node:child_process';
import {
  enumerate_lockstep,
  read_current_version,
  write_new_version,
  bump_semver,
  REPO_ROOT,
} from './lib/lockstep.mjs';

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function emit_error(error_type, message) {
  emit({ mode: 'error', error_type, message });
  process.exit(1);
}

function parse_args(argv) {
  const args = argv.slice(2);
  let repair_skew = false;
  let bump_type = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repair-skew') {
      repair_skew = true;
    } else if (a === '--bump') {
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
  return { repair_skew, bump_type };
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

// Find the SHA of the previous release commit — one whose message matches
// exactly `vX.Y.Z` (this repo's release-marker convention; see `taste.md`
// Principle 16 and CHANGELOG.md history). Returns null if no prior release
// exists, which the skill interprets as "first release, summarize all history".
function find_previous_release_sha() {
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

async function mode_bump(bump_type) {
  const tree = check_clean_tree();
  if (!tree.ok) {
    if (tree.runtime_error) emit_error('runtime', tree.runtime_error);
    const lines = tree.dirty_files.map((l) => `  ${l}`).join('\n');
    emit_error(
      'dirty_tree',
      `working tree is not clean — refusing to bump.\n` +
        `  a release commit must contain only the lockstep bump + CHANGELOG.\n` +
        `  uncommitted changes:\n${lines}`,
    );
  }

  const files = await enumerate_lockstep();
  const root_file = files.find((f) => f.kind === 'root_pkg');
  if (!root_file) emit_error('runtime', 'root package.json not found');
  const current = await read_current_version(root_file);

  const skew = [];
  for (const file of files) {
    if (file === root_file) continue;
    const v = await read_current_version(file);
    if (v !== current) skew.push({ rel: file.rel, version: v });
  }
  if (skew.length > 0) {
    const lines = skew.map((s) => `  - ${s.rel}: "${s.version}" (root: "${current}")`);
    emit_error(
      'skew',
      `workspace version skew detected (refusing to bump).\n` +
        `  run \`/version patch --repair-skew\` to force-align, or edit manually:\n` +
        lines.join('\n'),
    );
  }

  const since = find_previous_release_sha();
  const next = bump_semver(current, bump_type);
  const results = [];
  for (const file of files) {
    const changed = await write_new_version(file, next);
    results.push({ rel: file.rel, kind: file.kind, changed });
  }
  const changed_count = results.filter((r) => r.changed).length;
  emit({ mode: 'bump', old: current, new: next, since, files: results, changed_count });
}

async function mode_repair_skew() {
  const files = await enumerate_lockstep();
  const root_file = files.find((f) => f.kind === 'root_pkg');
  if (!root_file) emit_error('runtime', 'root package.json not found');
  const root_version = await read_current_version(root_file);

  const results = [];
  for (const file of files) {
    const before = await read_current_version(file);
    if (before === root_version) {
      results.push({ rel: file.rel, kind: file.kind, changed: false, before });
      continue;
    }
    await write_new_version(file, root_version);
    results.push({ rel: file.rel, kind: file.kind, changed: true, before });
  }
  const changed_count = results.filter((r) => r.changed).length;
  emit({
    mode: 'repair-skew',
    old: root_version,
    new: root_version,
    files: results,
    changed_count,
  });
}

async function main() {
  const parsed = parse_args(process.argv);
  if (parsed.error) emit_error('usage', parsed.error);
  if (parsed.repair_skew) {
    await mode_repair_skew();
    return;
  }
  if (!parsed.bump_type) {
    emit_error(
      'usage',
      'no arguments — pass `patch`, `minor`, or `major` to bump, or `--repair-skew` to force-align.',
    );
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
