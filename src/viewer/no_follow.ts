/**
 * Opening the trajectory without following a link, for `follow_links: false`.
 *
 * A host can check the trajectory's path before it starts a viewer, but the
 * check can't hold for long, because the tail and `/api/trajectory` open the
 * path again on every read. A link swapped in after the check would point the
 * viewer at any file the user can read and serve it over HTTP. So with links
 * not followed, every open of the trajectory goes through `open_unfollowed`,
 * which opens it with `O_NOFOLLOW`, where a link at the last name fails rather
 * than being followed, and then checks the handle it opened rather than the
 * path, so what it checked is what gets read.
 *
 * Only the last name is covered. A directory above the file is still followed,
 * since Node has no `openat` to walk a path one directory handle at a time, so
 * a host keeps checking those itself.
 */

import { constants, type Stats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

/**
 * What `open_unfollowed` found at the path: a handle the caller now owns and
 * must close, a refusal (a link at the last name, or something other than a
 * regular file with no other name), or an open or stat that failed for any
 * other reason, a missing file among them.
 */
export type Unfollowed =
  | { readonly kind: 'opened'; readonly handle: FileHandle; readonly stats: Stats }
  | { readonly kind: 'refused' | 'failed'; readonly error: unknown }

/**
 * The flags that open the trajectory for reading without following a link at
 * its last name. `O_NONBLOCK` keeps a FIFO planted at the path from holding
 * the open until some writer turns up, and changes nothing for a regular file.
 *
 * Throws where the platform has no `O_NOFOLLOW` (Windows), so that asking not
 * to follow links never quietly follows one.
 */
export function no_follow_flags(): number {
  const no_follow: unknown = Reflect.get(constants, 'O_NOFOLLOW')
  if (typeof no_follow !== 'number') {
    throw new Error("follow_links: false needs O_NOFOLLOW, which this platform doesn't have")
  }
  return constants.O_RDONLY | no_follow | constants.O_NONBLOCK
}

/**
 * Why the viewer won't read what it opened, or undefined when it may.
 *
 * Only a regular file with no other name is read. A hard link can stand at the
 * path as well as a symbolic one, and `O_NOFOLLOW` can't tell it from the file
 * it names, so a file with a second name is refused too.
 */
function refusal(stats: Stats): string | undefined {
  if (!stats.isFile()) return "it isn't a regular file"
  if (stats.nlink !== 1) return `it's one of ${String(stats.nlink)} hard links to the same file`
  return undefined
}

/**
 * Opens `path` with `flags` (see `no_follow_flags`) and checks the handle it
 * opened. Never throws: whatever it couldn't open or wouldn't keep comes back
 * as the error, with the handle already closed.
 */
export async function open_unfollowed(path: string, flags: number): Promise<Unfollowed> {
  let handle: FileHandle
  try {
    handle = await open(path, flags)
  } catch (error) {
    const link = Reflect.get(Object(error), 'code') === 'ELOOP'
    return { kind: link ? 'refused' : 'failed', error }
  }
  let stats: Stats
  try {
    stats = await handle.stat()
  } catch (error) {
    await handle.close()
    return { kind: 'failed', error }
  }
  const reason = refusal(stats)
  if (reason === undefined) return { kind: 'opened', handle, stats }
  await handle.close()
  return {
    kind: 'refused',
    error: new Error(`follow_links is false, so the viewer won't read ${path}: ${reason}`),
  }
}
