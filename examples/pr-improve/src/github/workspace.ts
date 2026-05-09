/**
 * Worktree + commit + push helpers for Phase B.
 *
 * The improvement branch name is `fascicle/improve-<n>`. Re-runs are
 * idempotent: any pre-existing worktree pinned to that branch is removed
 * before a new one is created. Cleanup happens on success only; on failure
 * the worktree is left in place for inspection.
 */

import { join } from 'node:path'

import { safe_spawn } from './spawn.js'

export type SetupWorktreeArgs = {
  readonly cwd: string
  readonly run_id: string
  readonly pr_number: number
  readonly head_oid: string
}

export type WorktreeInfo = {
  readonly worktree_path: string
  readonly improvement_branch: string
}

export function build_improvement_branch(pr_number: number): string {
  return `fascicle/improve-${String(pr_number)}`
}

async function list_worktrees(cwd: string): Promise<ReadonlyArray<{ path: string; branch: string | null }>> {
  const out = await safe_spawn({
    cmd: 'git',
    argv: ['-C', cwd, 'worktree', 'list', '--porcelain'],
  })
  const blocks = out.stdout.split('\n\n').filter((b) => b.trim().length > 0)
  const result: { path: string; branch: string | null }[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    let path: string | undefined
    let branch: string | null = null
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim()
        const short = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
        branch = short
      }
    }
    if (path !== undefined) result.push({ path, branch })
  }
  return result
}

export async function setup_worktree(args: SetupWorktreeArgs): Promise<WorktreeInfo> {
  const improvement_branch = build_improvement_branch(args.pr_number)
  const worktree_path = join(args.cwd, '.fascicle', args.run_id)

  const existing = await list_worktrees(args.cwd)
  for (const wt of existing) {
    if (wt.branch === improvement_branch) {
      await safe_spawn({
        cmd: 'git',
        argv: ['-C', args.cwd, 'worktree', 'remove', '--force', wt.path],
      })
    }
  }

  await safe_spawn({
    cmd: 'git',
    argv: [
      '-C',
      args.cwd,
      'worktree',
      'add',
      '-B',
      improvement_branch,
      worktree_path,
      args.head_oid,
    ],
  })

  return { worktree_path, improvement_branch }
}

export async function has_uncommitted_edits(worktree_path: string): Promise<boolean> {
  const out = await safe_spawn({
    cmd: 'git',
    argv: ['-C', worktree_path, 'status', '--porcelain'],
  })
  return out.stdout.trim().length > 0
}

export type CommitResult = {
  readonly committed: boolean
  readonly sha?: string
}

export async function commit_changes(worktree_path: string, message: string): Promise<CommitResult> {
  if (!(await has_uncommitted_edits(worktree_path))) {
    return { committed: false }
  }
  await safe_spawn({
    cmd: 'git',
    argv: ['-C', worktree_path, 'add', '-A'],
  })
  await safe_spawn({
    cmd: 'git',
    argv: ['-C', worktree_path, 'commit', '-m', message],
  })
  const out = await safe_spawn({
    cmd: 'git',
    argv: ['-C', worktree_path, 'rev-parse', 'HEAD'],
  })
  return { committed: true, sha: out.stdout.trim() }
}

export async function push_branch(worktree_path: string, branch: string): Promise<void> {
  await safe_spawn({
    cmd: 'git',
    argv: ['-C', worktree_path, 'push', '-u', 'origin', branch],
  })
}

export async function cleanup_worktree(cwd: string, worktree_path: string): Promise<void> {
  await safe_spawn({
    cmd: 'git',
    argv: ['-C', cwd, 'worktree', 'remove', '--force', worktree_path],
  })
}
