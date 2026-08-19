/**
 * Incremental SSE decoder shared by the native (raw-HTTP) provider adapters.
 */
import { create_line_splitter } from './native_shared.js'

/**
 * Wire-neutral framing only: push() takes decoded text as it arrives off the
 * wire (any chunk boundary, including mid-line) and returns the data payloads
 * of every event completed by that chunk; flush() drains an event left open
 * when the stream ends without a trailing blank line. Only `data:` fields
 * matter to the streams Fascicle consumes (the Messages API repeats the
 * event type inside the JSON payload and the Chat Completions stream sends
 * nothing but data frames), so `event:`/`id:`/`retry:` fields and `:`
 * comments are dropped. Multi-line data joins with '\n' per the SSE spec.
 */
export function create_sse_decoder(): {
  push: (text: string) => string[]
  flush: () => string[]
} {
  let data_lines: string[] = []

  const close_event = (out: string[]): void => {
    if (data_lines.length > 0) {
      out.push(data_lines.join('\n'))
      data_lines = []
    }
  }

  return create_line_splitter(
    (line, out) => {
      if (line.length === 0) {
        close_event(out)
        return
      }
      if (line.startsWith(':')) return
      if (line.startsWith('data:')) {
        const value = line.slice(5)
        data_lines.push(value.startsWith(' ') ? value.slice(1) : value)
      }
    },
    close_event,
  )
}
