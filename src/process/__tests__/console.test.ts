import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { route_console_to_stderr } from '../console.js'

// A stream that keeps everything written to it, in order.
function sink(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString())
      done()
    },
  })
  return { stream, text: () => chunks.join('') }
}

describe('route_console_to_stderr', () => {
  it("sends log, info, debug, and dirxml through the console's error, and leaves stdout empty", () => {
    const stdout = sink()
    const stderr = sink()
    const target = new Console({ stdout: stdout.stream, stderr: stderr.stream })
    route_console_to_stderr(target, sink().stream)
    target.log('log line')
    target.info('info line')
    target.debug('debug line')
    target.dirxml('dirxml line')
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toBe('log line\ninfo line\ndebug line\ndirxml line\n')
  })

  it('sends dir to the stream it is handed, honoring its options', () => {
    const stdout = sink()
    const routed = sink()
    const target = new Console({ stdout: stdout.stream, stderr: sink().stream })
    route_console_to_stderr(target, routed.stream)
    target.dir({ deep: { deeper: true } }, { depth: 0 })
    expect(stdout.text()).toBe('')
    expect(routed.text()).toBe('{ deep: [Object] }\n')
  })

  it('leaves the methods that already write to stderr writing there', () => {
    const stdout = sink()
    const stderr = sink()
    const target = new Console({ stdout: stdout.stream, stderr: stderr.stream })
    route_console_to_stderr(target, sink().stream)
    target.error('error line')
    target.warn('warn line')
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toBe('error line\nwarn line\n')
  })
})
