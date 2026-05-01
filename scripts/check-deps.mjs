#!/usr/bin/env node
/**
 * Dependency and publishability invariants per constraints.md §7.2
 * and publish spec §6.1 / §10:
 *
 *   Dependency shape
 *   - @repo/core production deps are exactly: zod
 *   - @repo/engine production deps are exactly: @repo/core, ai, zod
 *   - @repo/engine declares six provider SDKs as OPTIONAL peers
 *
 *   Publishability
 *   - Root package.json must NOT carry "private": true (only the root
 *     manifest ships to npm)
 *   - Every packages/*\/package.json MUST carry "private": true
 *   - Every packages/*\/package.json version MUST equal the root version
 *   - Both packages/core/src/version.ts and packages/engine/src/version.ts
 *     literal constants MUST equal the root version
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  REPO_ROOT,
  enumerate_lockstep,
  read_current_version,
} from './lib/lockstep.mjs';

const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const CORE_PKG = join(PACKAGES_DIR, 'core', 'package.json');
const ENGINE_PKG = join(PACKAGES_DIR, 'engine', 'package.json');
const FASCICLE_PKG = join(PACKAGES_DIR, 'fascicle', 'package.json');

const CORE_ALLOWED = new Set(['zod']);
const ENGINE_ALLOWED = new Set(['@repo/core', 'ai', 'zod']);
const ENGINE_REQUIRED_OPTIONAL_PEERS = [
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@openrouter/ai-sdk-provider',
  'ai-sdk-ollama',
];

function fail(msg) {
  console.error(`check-deps: ${msg}`);
  process.exit(1);
}

async function read_pkg(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function check_core() {
  const pkg = await read_pkg(CORE_PKG);
  const deps = Object.keys(pkg.dependencies ?? {});
  const disallowed = deps.filter((d) => !CORE_ALLOWED.has(d));
  if (disallowed.length > 0) {
    fail(
      `@repo/core has disallowed production dependencies: ${disallowed.join(', ')}. ` +
        `only allowed: ${[...CORE_ALLOWED].join(', ')}`,
    );
  }
  for (const required of CORE_ALLOWED) {
    if (!deps.includes(required)) {
      fail(`@repo/core is missing required dependency: ${required}`);
    }
  }
  console.log(`check-deps: core ok (${deps.length} prod dep(s): ${deps.join(', ')})`);
}

async function check_engine() {
  const pkg = await read_pkg(ENGINE_PKG);
  const deps = Object.keys(pkg.dependencies ?? {});
  const disallowed = deps.filter((d) => !ENGINE_ALLOWED.has(d));
  if (disallowed.length > 0) {
    fail(
      `@repo/engine has disallowed production dependencies: ${disallowed.join(', ')}. ` +
        `only allowed: ${[...ENGINE_ALLOWED].join(', ')}`,
    );
  }
  for (const required of ENGINE_ALLOWED) {
    if (!deps.includes(required)) {
      fail(`@repo/engine is missing required dependency: ${required}`);
    }
  }

  const peers = Object.keys(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};
  for (const peer of ENGINE_REQUIRED_OPTIONAL_PEERS) {
    if (!peers.includes(peer)) {
      fail(`@repo/engine is missing required peer dependency: ${peer}`);
    }
    if (!meta[peer] || meta[peer].optional !== true) {
      fail(
        `@repo/engine peer dependency ${peer} must be declared optional via peerDependenciesMeta`,
      );
    }
  }
  console.log(
    `check-deps: engine ok (${deps.length} prod dep(s): ${deps.join(', ')}; ${peers.length} peer(s), all optional where required)`,
  );
}

async function check_publishability() {
  // The lockstep enumeration here is shared with scripts/check-publish.mjs
  // and scripts/bump-version.mjs via scripts/lib/lockstep.mjs. One source of
  // truth; don't re-derive package discovery locally.
  const files = await enumerate_lockstep();
  const root_file = files.find((f) => f.kind === 'root_pkg');
  if (!root_file) fail('root package.json not found in lockstep enumeration');

  const root_pkg = await read_pkg(root_file.path);
  if (root_pkg.private === true) {
    fail(
      `root package.json must NOT carry "private": true (only the root manifest publishes); ` +
        `found in ${root_file.path}`,
    );
  }
  const root_version = await read_current_version(root_file).catch((err) => fail(err.message));

  let package_count = 0;
  let version_ts_count = 0;
  for (const file of files) {
    if (file === root_file) continue;
    if (file.kind === 'package_pkg') {
      const pkg = await read_pkg(file.path);
      if (pkg.private !== true) {
        fail(`${file.path} must carry "private": true (only the root manifest publishes)`);
      }
      if (pkg.version !== root_version) {
        fail(`version skew: ${file.path} is "${pkg.version}" but root is "${root_version}"`);
      }
      package_count++;
      continue;
    }
    if (file.kind === 'version_ts') {
      const v = await read_current_version(file).catch((err) => fail(err.message));
      if (v !== root_version) {
        fail(`version skew: ${file.path} is "${v}" but root is "${root_version}"`);
      }
      version_ts_count++;
    }
  }

  console.log(
    `check-deps: publish invariants ok (root ${root_version}, ${package_count} package(s) + ${version_ts_count} version.ts literal(s) in lockstep)`,
  );
}

async function check_viewer_isolation() {
  // The viewer ships as a separate published package (fascicle-viewer). It
  // must NOT appear in the @repo/fascicle umbrella's dependency graph, so the
  // runtime install graph of `fascicle` stays free of HTTP-server deps. See
  // spec/viewer.md §3.
  const pkg = await read_pkg(FASCICLE_PKG);
  const all = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  if (Object.prototype.hasOwnProperty.call(all, '@repo/viewer')) {
    fail(
      `@repo/viewer must not appear in @repo/fascicle's dependency graph. ` +
        `Viewer is a separate dev tool (fascicle-viewer); ${FASCICLE_PKG} should not depend on it.`,
    );
  }
  console.log(`check-deps: viewer isolation ok (@repo/viewer not in @repo/fascicle deps)`);
}

async function main() {
  await check_core();
  await check_engine();
  await check_viewer_isolation();
  await check_publishability();
}

main().catch((err) => {
  console.error('check-deps: orchestrator error:', err);
  process.exit(2);
});
