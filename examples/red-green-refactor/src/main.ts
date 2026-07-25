/**
 * Red-Green-Refactor harness entry.
 *
 * Iterates over the seed behavior list and runs one full RGR cycle per
 * behavior, sequentially, against the toy module under `toy/src/`.
 *
 * Driven by the `claude_cli` provider so the agent can read and write
 * files in this workspace. Requires `claude` on PATH.
 *
 * Usage:
 *   pnpm --filter @repo/example-red-green-refactor rgr
 *   pnpm exec tsx examples/red-green-refactor/src/main.ts
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'

import { SEED_BEHAVIORS } from './behaviors.js'
import { create_app_engine, DEFAULT_MODELS } from './engine.js'
import { build_flow } from './flow.js'
import { snapshot_tests } from './services/snapshot.js'
import { run_vitest } from './services/vitest.js'
import type { Behavior } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const TRAJECTORY_DIR = join(PACKAGE_ROOT, '.trajectory')

async function run_one(cycle: ReturnType<typeof build_flow>, b: Behavior): Promise<void> {
  await mkdir(TRAJECTORY_DIR, { recursive: true })
  const trajectory = filesystem_logger({
    output_path: join(TRAJECTORY_DIR, `${b.id}.jsonl`),
  })

  console.log(`\n=== ${b.id} ===`)
  console.log(b.description)

  await run(cycle, b, {
    install_signal_handlers: false,
    trajectory,
  })

  console.log(`✓ ${b.id} complete`)
}

export async function run_rgr(behaviors: readonly Behavior[] = SEED_BEHAVIORS): Promise<void> {
  const engine = create_app_engine()
  const cycle = build_flow(engine, DEFAULT_MODELS, {
    oracle: run_vitest,
    snapshot: snapshot_tests,
  })
  let completed = 0

  try {
    for (const b of behaviors) {
      try {
        await run_one(cycle, b)
        completed += 1
      } catch (err) {
        console.error(`✗ ${b.id} failed:`, err instanceof Error ? err.message : err)
        throw err
      }
    }
    console.log(`\nAll ${String(completed)} behaviors complete.`)
  } finally {
    await engine.dispose()
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_rgr().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
