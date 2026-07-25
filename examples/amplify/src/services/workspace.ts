/**
 * File-system bridge between candidate specs and the metric.
 *
 * Two concerns, one file:
 *
 *   1. Archiving — every candidate's content is written to
 *      `.runs/<run>/round-<n>/<proposer_id>.ts` for replay and audit.
 *
 *   2. Swap-in — to evaluate a candidate, we save the current content of
 *      the metric's `mutable_path`, write the candidate over it, run the
 *      gate + score, then restore. Sequential eval; safe under parallel
 *      proposes because ensemble's `score` callback runs sequentially.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CandidateSpec } from '../types.js'

/**
 * The file-system surface the flow depends on.
 *
 * A port rather than direct calls, so `flow.ts` names the steps while this
 * module owns the effects, and the flow test can run the whole topology
 * against an in-memory workspace.
 */
export type Workspace = {
  readonly read_parent: (path: string) => Promise<string>
  readonly commit_parent: (path: string, content: string) => Promise<void>
  readonly cache_research: (run_dir: string, summary: string) => Promise<void>
}

export type CandidateArchive = {
  readonly proposer_id: string
  readonly archive_path: string
}

export async function archive_candidate(
  round_dir: string,
  spec: CandidateSpec,
): Promise<CandidateArchive> {
  const archive_path = join(round_dir, `${spec.proposer_id}.ts`)
  await mkdir(dirname(archive_path), { recursive: true })
  await writeFile(archive_path, spec.content, 'utf8')
  return { proposer_id: spec.proposer_id, archive_path }
}

export type RestoreFn = () => Promise<void>

export async function swap_in(target_path: string, content: string): Promise<RestoreFn> {
  const original = await readFile(target_path, 'utf8')
  await writeFile(target_path, content, 'utf8')
  return async () => {
    await writeFile(target_path, original, 'utf8')
  }
}

async function commit_parent(target_path: string, content: string): Promise<void> {
  await writeFile(target_path, content, 'utf8')
}

/** Read the current parent contents: the starting point of round 1. */
async function read_parent(target_path: string): Promise<string> {
  return readFile(target_path, 'utf8')
}

/** Persist the research summary next to the run's other artifacts. */
async function cache_research(run_dir: string, summary: string): Promise<void> {
  await mkdir(run_dir, { recursive: true })
  await writeFile(join(run_dir, 'research.md'), summary, 'utf8')
}

export const filesystem_workspace: Workspace = {
  read_parent,
  commit_parent,
  cache_research,
}
