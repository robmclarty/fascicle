/**
 * JSONL file tailer.
 *
 * Follows a path for appends and emits one parsed trajectory event per
 * complete line. Handles these pathological cases:
 *
 *   - A file that doesn't exist yet: a missing file is a wait, not an
 *     error. The tail reads it from its first line once it appears.
 *   - Rotation: a file renamed away and recreated under the same name is a
 *     new inode, so the tail starts the new file from its first line rather
 *     than at the old file's offset.
 *   - Truncation: a stat shorter than the current offset means the file
 *     shrank in place. Reset offset to 0 and re-stream.
 *   - Partial last line: if the trailing chunk has no `\n`, buffer it and
 *     wait. Never parse a half-written line.
 *   - Schema failures: a line that fails `parse_trajectory_event` is
 *     dropped and surfaced to `on_parse_error`. The stream keeps going.
 *
 * Two fs.watch watchers drive the reads. A watch on the file itself carries
 * every append, but it follows the file's inode, so it can't see a file
 * appear and after a rename it reports on the old one. So while the file is
 * missing, and from the moment that watch reports a rename, a second watch
 * on the parent directory waits for the file's name, and the first pass that
 * finds a file there moves the file watch onto it and drops the directory
 * watch. Appends never ride the directory watch, because macOS serves a
 * directory through FSEvents, whose stream starts asynchronously and drops
 * what happens before it is live, while a file watch is kqueue's and holds
 * from the moment it is made. Reads are serialized, and change events that arrive mid-read are coalesced
 * into one extra pass rather than dropped, so a burst of appends never starts
 * overlapping reads. Each pass re-stats and re-reads from the saved offset,
 * which also covers platforms where fs.watch misses some append
 * notifications: the next successful change event catches the file up
 * regardless.
 */

import { type FSWatcher, type WatchListener, watch as fs_watch } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
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
 * True for the error a stat or an open throws when nothing is at the path,
 * which the tail reads as waiting for the file rather than as a failure.
 */
function is_missing(err: unknown): boolean {
  return Reflect.get(Object(err), 'code') === 'ENOENT'
}

/**
 * Starts tailing `path` and returns a handle to stop or drain it.
 *
 * Watches the file with `fs.watch` and re-reads from the last known offset
 * on every change, buffering an incomplete trailing line until the rest
 * arrives. A missing file is waited for through a watch on its directory,
 * and a new file at the path (a different inode) is read from its first
 * line. Overlapping change events are coalesced: a read already in flight
 * absorbs any events that fire while it runs instead of starting a second
 * concurrent read.
 */
export function start_tail(config: TailConfig): Tail {
  const { path, on_event, on_parse_error, on_io_error } = config
  const name = basename(path)
  let inode: number | null = null
  let offset = 0
  let buffer = ''
  let busy = false
  let pending = false
  let closed = false
  let file_watcher: FSWatcher | null = null
  let dir_watcher: FSWatcher | null = null
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

  // Waits on the directory for the file's name. Arming the watch schedules
  // one more pass, which catches a file that appeared between the last stat
  // and the watch. A watch that fails to arm (its directory is missing too)
  // schedules nothing, or every pass would retry it and spin. A platform
  // that can't name the file in an event passes null, which schedules a pass
  // rather than risk missing one.
  const await_file = (): void => {
    if (dir_watcher !== null) return
    dir_watcher = watch(dirname(path), (_event, filename) => {
      if (filename === null || filename === name) schedule()
    })
    if (dir_watcher !== null) schedule()
  }

  // Follows the file now at the path from its first line. The file watch
  // moves onto it, and a rename it reports (the file moved away or was
  // deleted) sends the tail back to waiting on the directory.
  const adopt = (ino: number): void => {
    inode = ino
    offset = 0
    buffer = ''
    file_watcher?.close()
    file_watcher = watch(path, (event) => {
      if (event === 'rename') await_file()
      schedule()
    })
    dir_watcher?.close()
    dir_watcher = null
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
