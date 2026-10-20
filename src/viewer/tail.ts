/**
 * JSONL file tailer.
 *
 * Follows a path for appends and emits one parsed trajectory event per
 * complete line. Handles these pathological cases:
 *
 *   - A file that doesn't exist yet: a missing file is a wait, not an
 *     error. The tail reads it from its first line once it appears, and the
 *     directories above it can be missing too.
 *   - Rotation: a file renamed away and recreated under the same name is a
 *     new inode, so the tail starts the new file from its first line rather
 *     than at the old file's offset. A file whose directory is moved away,
 *     and a new directory made in its place, rotates the same way.
 *   - Truncation: a stat shorter than the current offset means the file
 *     shrank in place. Reset offset to 0 and re-stream.
 *   - Partial last line: if the trailing chunk has no `\n`, buffer it and
 *     wait. Never parse a half-written line.
 *   - Schema failures: a line that fails `parse_trajectory_event` is
 *     dropped and surfaced to `on_parse_error`. The stream keeps going.
 *
 * Two fs.watch watchers drive the reads. A watch on the file itself carries
 * every append, but it follows the file's inode, so it can't see a file
 * appear, after a rename it reports on the old one, and it reports nothing
 * when the file's directory moves away with the file inside. A second watch,
 * on a directory, covers those. While the file is missing, it sits on the
 * closest directory above the path that exists and waits for the next name
 * down, so it moves down a level each time a directory on the path appears.
 * Once a pass finds the file, the file watch moves onto it, and the directory
 * watch stays on the file's own directory, where it reports that directory
 * moving or going away. Appends never depend on the directory watch, because
 * macOS serves a directory through FSEvents, whose stream starts
 * asynchronously and drops what happens before it is live, while a file watch
 * is kqueue's and holds from the moment it is made. Reads are serialized, and change events that arrive mid-read are coalesced
 * into one extra pass rather than dropped, so a burst of appends never starts
 * overlapping reads. Each pass re-stats and re-reads from the saved offset,
 * which also covers platforms where fs.watch misses some append
 * notifications: the next successful change event catches the file up
 * regardless.
 */

import { type FSWatcher, type WatchListener, statSync, watch as fs_watch } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, relative, sep } from 'node:path'
import { parse_trajectory_event, type ParsedTrajectoryEvent } from '#core'

export type TailConfig = {
  readonly path: string
  readonly on_event: (event: ParsedTrajectoryEvent) => void
  readonly on_parse_error?: (err: unknown, line: string) => void
  readonly on_io_error?: (err: unknown) => void
}

export type Tail = {
  readonly stop: () => void
  readonly drain: () => Promise<void>
}

/**
 * True for the errors a stat or an open throws when no file is at the path,
 * which the tail reads as waiting for the file rather than as a failure.
 *
 * Nothing at the path is one (ENOENT), and a file where a directory on the
 * path should be is the other (ENOTDIR), since the file can appear once a
 * directory takes that file's place.
 */
function is_missing(err: unknown): boolean {
  const code = Reflect.get(Object(err), 'code')
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The inode of the directory at `dir`, or null when no directory is there.
 *
 * An entry that isn't a directory counts as none, since a watch on it could
 * never report the next name down the path.
 */
function dir_inode(dir: string): number | null {
  try {
    const st = statSync(dir)
    return st.isDirectory() ? st.ino : null
  } catch {
    return null
  }
}

/**
 * The closest directory at or above `dir` that exists, with its inode.
 *
 * Every walk up ends at a root, which exists, so this comes back empty only
 * when even a root can't be read.
 */
function nearest_dir(dir: string): { readonly path: string; readonly ino: number } | null {
  let at = dir
  let ino = dir_inode(at)
  while (ino === null) {
    const up = dirname(at)
    if (up === at) return null
    at = up
    ino = dir_inode(at)
  }
  return { path: at, ino }
}

/**
 * The first name on the way down from `dir` to `path`: the next directory
 * that has to appear, or the file's own name when `dir` holds the file.
 */
function next_name(dir: string, path: string): string {
  const rest = relative(dir, path)
  const cut = rest.indexOf(sep)
  return cut === -1 ? rest : rest.slice(0, cut)
}

/**
 * Starts tailing `path` and returns a handle to stop or drain it.
 *
 * Watches the file with `fs.watch` and re-reads from the last known offset
 * on every change, buffering an incomplete trailing line until the rest
 * arrives. A missing file is waited for through a watch on the closest
 * directory above it that exists, and a new file at the path (a different
 * inode) is read from its first line. Overlapping change events are coalesced: a read already in flight
 * absorbs any events that fire while it runs instead of starting a second
 * concurrent read.
 */
export function start_tail(config: TailConfig): Tail {
  const { path, on_event, on_parse_error, on_io_error } = config
  let inode: number | null = null
  let offset = 0
  let buffer = ''
  let busy = false
  let pending = false
  let closed = false
  let file_watcher: FSWatcher | null = null
  let dir_watcher: FSWatcher | null = null
  let watched_dir: string | null = null
  let watched_ino: number | null = null
  let last_drain: Promise<void> = Promise.resolve()

  // A stat or open that finds nothing at the path is the wait for the file,
  // which the CLI has already warned about, so only other failures report.
  const report = (err: unknown): void => {
    if (on_io_error && !is_missing(err)) on_io_error(err)
  }

  const handle_line = (line: string): void => {
    if (line.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      if (on_parse_error) on_parse_error(err, line)
      return
    }
    const result = parse_trajectory_event(parsed)
    if (!result.success) {
      if (on_parse_error) on_parse_error(result.error, line)
      return
    }
    on_event(result.data)
  }

  // Starts a watch, reporting one that can't start (a directory that doesn't
  // exist, say) rather than throwing out of a read pass. A pass that was in
  // flight when the tail stopped starts nothing, so stop() leaves no watch
  // holding the process open.
  const watch = (target: string, listener: WatchListener<string>): FSWatcher | null => {
    if (closed) return null
    try {
      return fs_watch(target, { persistent: true }, listener)
    } catch (err) {
      if (on_io_error) on_io_error(err)
      return null
    }
  }

  // Keeps the one directory watch on `dir`, whose inode is `ino`, and returns
  // true when it armed a new one. A watch already on that directory stays.
  // Any other is replaced, including one on an older directory at the same
  // path, because a watch that follows an inode (inotify's) goes on
  // reporting the old directory wherever it moved. An event for the next
  // name down the path starts a pass, and so does one for the directory's
  // own name, which is how a platform reports the directory itself moving
  // or going away. A platform that can't name the entry in an event passes
  // null, which starts a pass rather than risk missing one.
  const watch_dir = (dir: string, ino: number): boolean => {
    if (dir_watcher !== null && watched_dir === dir && watched_ino === ino) return false
    dir_watcher?.close()
    watched_dir = dir
    watched_ino = ino
    const next = next_name(dir, path)
    const own = basename(dir)
    dir_watcher = watch(dir, (_event, filename) => {
      if (filename === null || filename === next || filename === own) schedule()
    })
    return dir_watcher !== null
  }

  // Points the directory watch at the closest directory above the path that
  // exists, and returns true when that armed a new watch.
  const watch_nearest = (): boolean => {
    const dir = nearest_dir(dirname(path))
    return dir !== null && watch_dir(dir.path, dir.ino)
  }

  // Waits for the file through a watch on the closest directory above the
  // path that exists. Each pass that still finds no file comes back here, so
  // the watch moves down a level each time the next directory on the path
  // appears. Arming a watch schedules one more pass, which catches whatever
  // appeared between the last stat and the watch. A watch that stays where
  // it was, or fails to arm, schedules nothing, or every pass would start
  // another and spin.
  const await_file = (): void => {
    if (watch_nearest()) schedule()
  }

  // Follows the file now at the path from its first line. The file watch
  // moves onto it, and whatever it reports starts a pass, which goes back to
  // waiting when the file moved away or was deleted. The directory watch
  // moves onto the file's own directory and stays there while the file is
  // followed, because a directory that moves away takes the file with it,
  // and the file watch reports nothing for that.
  const adopt = (ino: number): void => {
    inode = ino
    offset = 0
    buffer = ''
    file_watcher?.close()
    file_watcher = watch(path, schedule)
    watch_nearest()
  }

  // Stats the path and returns the size to read up to, or null when nothing
  // is there. A missing file forgets its inode, so whatever appears next is
  // read from the top even if the filesystem reuses the number. A new inode
  // (the first sighting, or a file recreated after a rotation) is adopted,
  // and a file shorter than the offset was truncated in place, so both start
  // over at offset 0, since the saved offset means nothing in either.
  const locate = async (): Promise<number | null> => {
    let st
    try {
      st = await stat(path)
    } catch (err) {
      if (is_missing(err)) {
        inode = null
        await_file()
      }
      report(err)
      return null
    }
    if (st.ino !== inode) {
      adopt(st.ino)
    } else if (st.size < offset) {
      offset = 0
      buffer = ''
    }
    return st.size
  }

  const read_more = async (): Promise<void> => {
    const size = await locate()
    if (size === null || size === offset) return

    const fh = await open(path, 'r').catch((err: unknown) => {
      report(err)
      return null
    })
    if (!fh) return
    try {
      const length = size - offset
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      offset += bytesRead
      buffer += buf.subarray(0, bytesRead).toString('utf8')
    } catch (err) {
      // A path that stats and opens can still refuse a read (a directory
      // answers EISDIR). The watcher starts read passes without awaiting
      // them, so the error is reported here rather than left to reject one.
      report(err)
      return
    } finally {
      await fh.close()
    }

    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      handle_line(line)
      nl = buffer.indexOf('\n')
    }
    // Anything left in `buffer` has no trailing newline yet; keep it for
    // the next read instead of parsing a half-written line.
  }

  // Coalesces watcher bursts: if `schedule` fires while a read is already
  // running, it just flags `pending` and returns. The running loop below
  // checks `pending` after each pass and does one more pass if it was set,
  // so a burst of change events never starts overlapping reads.
  const schedule = (): void => {
    if (closed) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    last_drain = (async (): Promise<void> => {
      try {
        let keep_going = true
        while (keep_going) {
          pending = false
          await read_more()
          keep_going = pending && !closed
        }
      } finally {
        busy = false
      }
    })()
  }

  schedule()

  const stop = (): void => {
    closed = true
    file_watcher?.close()
    file_watcher = null
    dir_watcher?.close()
    dir_watcher = null
  }

  const drain = async (): Promise<void> => {
    schedule()
    await last_drain
  }

  return { stop, drain }
}
