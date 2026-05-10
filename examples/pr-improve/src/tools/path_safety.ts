/**
 * Path safety primitives shared by every worktree-scoped tool.
 *
 * resolve_within: collapses `..` via path.resolve and asserts the result is
 * still inside `root`. Catches `../../etc/passwd` and absolute-path inputs
 * both in one check.
 *
 * assert_not_symlink: lstat the leaf and reject symlinks unconditionally.
 * Worktrees from `git worktree add` do not normally contain symlinks; the
 * blanket refusal removes a TOCTOU class of attack at the cost of a rare
 * false positive a developer can resolve by removing the symlink.
 */

import { lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export class PathSafetyError extends Error {
  override readonly name = 'PathSafetyError'
  readonly user_path: string
  constructor(message: string, user_path: string) {
    super(message)
    this.user_path = user_path
  }
}

export function resolve_within(root: string, user_path: string): string {
  if (typeof user_path !== 'string') {
    throw new PathSafetyError('path must be a string', String(user_path))
  }
  if (user_path.length === 0) {
    throw new PathSafetyError('path must not be empty', user_path)
  }
  if (user_path.includes('\0')) {
    throw new PathSafetyError('path must not contain NUL', user_path)
  }
  const abs_root = resolve(root)
  const candidate = resolve(abs_root, user_path)
  if (candidate !== abs_root && !candidate.startsWith(abs_root + sep)) {
    throw new PathSafetyError(
      `path escapes worktree root: ${user_path}`,
      user_path,
    )
  }
  return candidate
}

export async function assert_not_symlink(resolved_path: string, user_path: string): Promise<void> {
  try {
    const stat = await lstat(resolved_path)
    if (stat.isSymbolicLink()) {
      throw new PathSafetyError(
        `refusing to operate on symlink: ${user_path}`,
        user_path,
      )
    }
  } catch (err: unknown) {
    if (err instanceof PathSafetyError) throw err
    if (is_enoent(err)) return
    throw err
  }
}

function is_enoent(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'ENOENT'
}
