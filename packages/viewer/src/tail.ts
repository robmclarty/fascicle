/**
 * JSONL file tailer.
 *
 * Watches a file for appends and emits one parsed trajectory event per
 * complete line. Handles three pathological cases the spec calls out:
 *
 *   - Truncation / rotation: a watcher event whose stat is shorter than the
 *     current offset means the file shrunk. Reset offset to 0 and re-stream.
 *   - Partial last line: if the trailing chunk has no `\n`, buffer it and
 *     wait. Never parse a half-written line.
 *   - Schema failures: a line that fails `trajectory_event_schema.parse` is
 *     dropped and surfaced to `on_parse_error`. The stream keeps going.
 *
 * The watcher is fs.watch-based with a debounced re-read; on platforms where
 * fs.watch is flaky for appends we still catch up because the next tick
 * re-stats and re-reads from the saved offset.
 */

import { type FSWatcher, watch as fs_watch } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { trajectory_event_schema, type ParsedTrajectoryEvent } from '@repo/core'

export type TailOptions = {
  readonly path: string
  readonly on_event: (event: ParsedTrajectoryEvent) => void
  readonly on_parse_error?: (err: unknown, line: string) => void
  readonly on_io_error?: (err: unknown) => void
}

export type Tail = {
  readonly stop: () => void
  readonly drain: () => Promise<void>
}

export function start_tail(options: TailOptions): Tail {
  const { path, on_event, on_parse_error, on_io_error } = options
  let offset = 0
  let buffer = ''
  let busy = false
  let pending = false
  let closed = false
  let watcher: FSWatcher | null = null
  let last_drain: Promise<void> = Promise.resolve()

  const handle_line = (line: string): void => {
    if (line.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      if (on_parse_error) on_parse_error(err, line)
      return
    }
    const result = trajectory_event_schema.safeParse(parsed)
    if (!result.success) {
      if (on_parse_error) on_parse_error(result.error, line)
      return
    }
    on_event(result.data)
  }

  const read_more = async (): Promise<void> => {
    let st
    try {
      st = await stat(path)
    } catch (err) {
      if (on_io_error) on_io_error(err)
      return
    }
    if (st.size < offset) {
      offset = 0
      buffer = ''
    }
    if (st.size === offset) return

    const fh = await open(path, 'r').catch((err: unknown) => {
      if (on_io_error) on_io_error(err)
      return null
    })
    if (!fh) return
    try {
      const length = st.size - offset
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      offset += bytesRead
      buffer += buf.subarray(0, bytesRead).toString('utf8')
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
  }

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

  try {
    watcher = fs_watch(path, { persistent: true }, () => { schedule() })
  } catch (err) {
    if (on_io_error) on_io_error(err)
  }

  const stop = (): void => {
    closed = true
    if (watcher) {
      watcher.close()
      watcher = null
    }
  }

  const drain = async (): Promise<void> => {
    schedule()
    await last_drain
  }

  return { stop, drain }
}
