#!/usr/bin/env node
/**
 * Dependency and publishability invariants for the single-package layout.
 *
 *   Dependency shape
 *   - "core may only depend on zod" and "engine may only depend on ai+zod"
 *     are now enforced at the import level by the ast-grep rules
 *     rules/no-core-npm-dep-except-zod.yml and
 *     rules/no-engine-npm-dep-except-ai-zod.yml (the single root manifest can
 *     no longer express per-module dependency shape).
 *   - The provider SDKs MUST be declared as OPTIONAL peers on the root manifest
 *     (checked here).
 *
 *   Publishability
 *   - Root package.json must NOT carry "private": true.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PKG = join(REPO_ROOT, 'package.json');
const REQUIRED_OPTIONAL_PEERS = [
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

async function check_optional_peers() {
  const pkg = await read_pkg(ROOT_PKG);
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const meta = pkg.peerDependenciesMeta ?? {};
  for (const peer of REQUIRED_OPTIONAL_PEERS) {
    if (!peers.includes(peer)) {
      fail(`root manifest is missing required peer dependency: ${peer}`);
    }
    if (!meta[peer] || meta[peer].optional !== true) {
      fail(`peer dependency ${peer} must be declared optional via peerDependenciesMeta`);
    }
  }
  console.log(
    `check-deps: optional provider peers ok (${REQUIRED_OPTIONAL_PEERS.length} required, all optional)`,
  );
}

async function check_publishability() {
  const root_pkg = await read_pkg(ROOT_PKG);
  if (root_pkg.private === true) {
    fail(`root package.json must NOT carry "private": true; found in ${ROOT_PKG}`);
  }
  if (typeof root_pkg.version !== 'string' || root_pkg.version.length === 0) {
    fail('root package.json is missing a `version` field');
  }

  console.log(`check-deps: publish invariants ok (root ${root_pkg.version}, not private)`);
}

async function main() {
  await check_optional_peers();
  await check_publishability();
}

main().catch((err) => {
  console.error('check-deps: orchestrator error:', err);
  process.exit(2);
});
