/**
 * Incremental SSE decoder shared by the native (raw-HTTP) provider adapters.
 *
 * Wire-neutral framing only: push() takes decoded text as it arrives off the
 * wire (any chunk boundary, including mid-line) and returns the data payloads
 * of every event completed by that chunk; flush() drains an event left open
 * when the stream ends without a trailing blank line. Only `data:` fields
 * matter to the streams fascicle consumes (the Messages API repeats the
 * event type inside the JSON payload and the Chat Completions stream sends
 * nothing but data frames), so `event:`/`id:`/`retry:` fields and `:`
 * comments are dropped. Multi-line data joins with '\n' per the SSE spec.
 */
export function create_sse_decoder(): {
  push: (text: string) => string[]
  flush: () => string[]
} {
  let buffer = ''
  let data_lines: string[] = []

  const take_line = (raw: string, out: string[]): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length === 0) {
      if (data_lines.length > 0) {
        out.push(data_lines.join('\n'))
        data_lines = []
      }
      return
    }
    if (line.startsWith(':')) return
    if (line.startsWith('data:')) {
      const value = line.slice(5)
      data_lines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  return {
    push(text: string): string[] {
      buffer += text
      const out: string[] = []
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        take_line(buffer.slice(0, newline), out)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      return out
    },
    flush(): string[] {
      const out: string[] = []
      if (buffer.length > 0) take_line(buffer, out)
      buffer = ''
      if (data_lines.length > 0) {
        out.push(data_lines.join('\n'))
        data_lines = []
      }
      return out
    },
  }
}
