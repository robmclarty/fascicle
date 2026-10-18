/**
 * Containment: the boundary the workspace file tools keep. A path, absolute
 * or relative to the session's `cwd`, is allowed only when its real path
 * lands under one of the session's roots, which are real paths themselves,
 * resolved once at `session/new`.
 *
 * Real paths on both sides are the point. A symlink inside the workspace
 * that points out of it is the classic escape, and checking the path as
 * written would let it through. A `cwd` behind a symlink (macOS's `/tmp` and
 * `/var` both are) would refuse every file in the project if the roots
 * stayed as the client sent them. A path that doesn't exist yet resolves
 * through its nearest existing ancestor, and a dangling symlink through its
 * target, so a path outside the roots is refused the same way whether or
 * not it exists.
 *
 * The writes keep a stricter boundary inside the roots: nothing under a
 * `.git` or a `node_modules`. Git runs what its directory holds (a hook,
 * `core.fsmonitor`), a package manager runs what `node_modules` holds
 * (`.bin`, an install script), and a change in either never shows in
 * `git diff`, so an edit there would be code that runs unseen. No mode lifts
 * it, since Accept edits and Auto write without asking.
 */

import { readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AcpSession } from '../types.js'

/** A path a tool may touch, both as the client names it and as the file system resolves it. */
export type ContainedPath = {
  /** Absolute, under the `cwd` the client sent: what the client and the model are shown. */
  readonly path: string
  /** Symlinks resolved: what the tool opens. */
  readonly real: string
}

/** The error codes that mean a path, or a directory on the way to it, doesn't exist. */
const MISSING: ReadonlySet<unknown> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * How many symlinks a missing path may pass through before resolving it
 * gives up. `path.resolve` folds `missing/..` away where the kernel would
 * fail on it, so a link such as `a -> missing/../a` would otherwise loop.
 */
const MAX_LINK_HOPS = 40

/**
 * The names a write never reaches through, wherever under a root they sit:
 * a nested repository's `.git` counts, and so does a worktree's, which is a
 * file pointing git at its real directory.
 */
const GUARDED_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/**
 * The code a Node file system error carries, such as `ENOENT`. Every
 * caller hands in an error from `node:fs`, which always has one.
 */
export function error_code(err: unknown): unknown {
  return Reflect.get(Object(err), 'code')
}

/**
 * Resolve one root the client sent to its real path, refusing a relative
 * path (which would resolve against wherever the agent was launched), a path
 * that doesn't exist, and a file.
 */
async function resolve_root(root: string): Promise<string> {
  if (!isAbsolute(root)) {
    throw new Error(`the workspace root ${root} is a relative path; send session/new with absolute paths`)
  }
  const real = await realpath(root).catch((err: unknown) => {
    throw new Error(
      `the workspace root ${root} can't be opened (${String(error_code(err))}); send session/new with a directory that exists`,
    )
  })
  if (!(await stat(real)).isDirectory()) {
    throw new Error(`the workspace root ${root} is a file; send session/new with a directory`)
  }
  return real
}

/**
 * Resolve a session's roots (its `cwd`, then each additional directory) to
 * their real paths, once, when the session starts. The error names the
 * first root that isn't an absolute path to an existing directory.
 */
export async function resolve_roots(roots: ReadonlyArray<string>): Promise<string[]> {
  return Promise.all(roots.map(resolve_root))
}

/**
 * Whether `target` is `root` or lies beneath it. Both are compared as they
 * are, so the caller hands in real paths for a containment check.
 */
function is_within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * A symlink's target as written, or `undefined` when the path isn't a
 * symlink or isn't there.
 */
async function link_target(path: string): Promise<string | undefined> {
  return readlink(path).catch(() => undefined)
}

/**
 * The real path of `path`, existing or not. A path that exists is the file
 * system's own answer. A missing one is its parent's real path plus its
 * name, unless it's a dangling symlink, whose real path is its target's:
 * writing through it would land there.
 */
async function real_path(path: string, hops_left: number): Promise<string> {
  try {
    return await realpath(path)
  } catch (err: unknown) {
    if (!MISSING.has(error_code(err))) throw err
  }
  const parent = await real_path(dirname(path), hops_left)
  const target = await link_target(path)
  if (target === undefined) return join(parent, basename(path))
  if (hops_left === 0) throw new Error(`${path} passes through too many symbolic links to resolve`)
  return real_path(resolve(parent, target), hops_left - 1)
}

/**
 * Check that a path a tool was handed lands inside the session's workspace,
 * and return it both ways. The refusal is an ordinary error naming the roots
 * in the client's terms, since the model reads it as a tool result and can
 * try a path that fits.
 */
export async function contain(session: AcpSession, requested: string): Promise<ContainedPath> {
  const path = resolve(session.cwd, requested)
  const real = await real_path(path, MAX_LINK_HOPS)
  if (session.roots.some((root) => is_within(root, real))) return { path, real }
  const allowed = [session.cwd, ...session.additional_directories].join(', ')
  throw new Error(`${requested} is outside the workspace; the file tools only reach paths under ${allowed}`)
}

/**
 * A path segment as a file system that ignores case, or Windows, which also
 * drops trailing dots and spaces, compares it, so `.GIT` and `.git.` name
 * the same directory as `.git` wherever they do.
 */
function folded(segment: string): string {
  return segment.toLowerCase().replace(/[. ]+$/u, '')
}

/**
 * The first of GUARDED_NAMES on the way down to `path` from any root it lies
 * under, or `undefined` when there is none.
 */
function guarded_segment(roots: ReadonlyArray<string>, path: string): string | undefined {
  for (const root of roots) {
    if (!is_within(root, path)) continue
    const found = relative(root, path).split(sep).map(folded).find((name) => GUARDED_NAMES.has(name))
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Check a path a write was handed the way `contain` does, then refuse one
 * that reaches `.git` or `node_modules` under a root. The path is checked as
 * written, against the roots in the client's terms, and as its symlinks
 * resolve, against the real ones, so a `.git` that is a symlink and a
 * symlink into `.git` are both refused. `tool` names the tool asking, for
 * the refusal, which points the model at `run_command`, the tool that asks
 * before it acts in Manual and in Accept edits.
 */
export async function contain_writable(session: AcpSession, requested: string, tool: string): Promise<ContainedPath> {
  const target = await contain(session, requested)
  const roots = [...session.roots, ...[session.cwd, ...session.additional_directories].map((dir) => resolve(dir))]
  const segment = guarded_segment(roots, target.path) ?? guarded_segment(roots, target.real)
  if (segment === undefined) return target
  throw new Error(
    `${requested} reaches ${segment}, where ${tool} never writes, since what's there can run on the user's next command without showing in git diff; if it has to change, use run_command`,
  )
}

/**
 * A path as a tool shows it to the model: relative to `cwd` when it's under
 * it, and absolute otherwise, as for a file in an additional directory.
 * Either form reads back through `contain`.
 */
export function shown_path(session: AcpSession, path: string): string {
  return is_within(session.cwd, path) ? relative(session.cwd, path) || '.' : path
}
