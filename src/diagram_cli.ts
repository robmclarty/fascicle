/**
 * fascicle-diagram CLI.
 *
 *   fascicle-diagram <module>                   print the diagram of the module's `flow`
 *   fascicle-diagram <module> --export <name>   read another export instead
 *
 * Flags: --export <name> --width <n> --prefix <text> --help
 *
 * The export is a Step, or a function that builds one with no arguments,
 * which is where an app wires its flow to stub dependencies so that drawing
 * it needs no credentials. The diagram is `describe.diagram` of that Step, so
 * it is what the code builds today and can be compared with the header in
 * `flow.ts` at a glance.
 *
 * This file holds every decision the command makes and touches nothing of
 * the process: output and module loading arrive through `DiagramCliIo`.
 * diagram_bin.ts binds that io to the real streams and to the project's
 * `tsx`, and is the entry that the package's bin shim runs.
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { describe, is_step } from '#core'
import type { DiagramOptions } from '#core'

export type DiagramCliIo = {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  /** Import the module at an absolute path and return its exports. */
  readonly load: (path: string) => Promise<Readonly<Record<string, unknown>>>
}

type CliArgs = {
  readonly module: string
  readonly export_name: string
  readonly options: DiagramOptions
}

type Parsed =
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly message: string }
  | { readonly kind: 'run'; readonly args: CliArgs }

const HELP = `\
fascicle-diagram prints a flow as an annotated box-drawing tree.

Usage:
  fascicle-diagram <module>                   draw the module's \`flow\` export
  fascicle-diagram <module> --export <name>   draw another export instead

The export is a Step, or a function that builds one with no arguments.

Options:
  --export <name>   the export to draw (default flow)
  --width <n>       wrap descriptions so no line runs wider than n
  --prefix <text>   start every line with text, for example ' * '
  --help            show this message
`


/**
 * Run the CLI over `argv` and resolve to its exit code: 0 once the diagram is
 * printed, 1 when the module cannot be loaded or holds no Step, and 2 for a
 * usage error. Output and loading go through `io`, so the caller owns the
 * process.
 */
export async function run_diagram_cli(argv: readonly string[], io: DiagramCliIo): Promise<number> {
  const parsed = parse(argv)
  if (parsed.kind === 'help') {
    io.out(HELP)
    return 0
  }
  if (parsed.kind === 'usage') {
    io.err(`fascicle-diagram: ${parsed.message}\n\n${HELP}`)
    return 2
  }
  const { module, export_name, options } = parsed.args
  const path = resolve(module)
  let exports: Readonly<Record<string, unknown>>
  try {
    exports = await io.load(path)
  } catch (err) {
    io.err(`fascicle-diagram: could not load ${module}: ${message_of(err)}\n`)
    return 1
  }
  if (!(export_name in exports)) {
    const names = Object.keys(exports).join(', ') || 'nothing'
    io.err(
      `fascicle-diagram: ${module} has no export named ${export_name}: pass --export <name> (it exports ${names})\n`,
    )
    return 1
  }
  let flow: unknown
  try {
    flow = await build(exports[export_name])
  } catch (err) {
    io.err(
      `fascicle-diagram: calling ${export_name}() in ${module} threw: ${message_of(err)}\n` +
        'Export a function that builds the flow with no arguments, wired to stub dependencies.\n',
    )
    return 1
  }
  if (!is_step(flow)) {
    io.err(
      `fascicle-diagram: ${export_name} in ${module} is not a Step: export the flow itself, or a function that builds it with no arguments\n`,
    )
    return 1
  }
  io.out(`${describe.diagram(flow, options)}\n`)
  return 0
}

/**
 * Parse argv into a run request, a help request, or a usage error. Unknown
 * flags and a missing module are usage errors, and so is a width that is not
 * a positive integer.
 */
function parse(argv: readonly string[]): Parsed {
  let parsed: ReturnType<typeof parse_flags>
  try {
    parsed = parse_flags(argv)
  } catch (err) {
    return { kind: 'usage', message: message_of(err) }
  }
  const { values, positionals } = parsed
  if (values.help === true) return { kind: 'help' }
  const [module, ...extra] = positionals
  if (module === undefined) return { kind: 'usage', message: 'a <module> to draw is required' }
  if (extra.length > 0) return { kind: 'usage', message: `expected one <module>, got ${positionals.join(' ')}` }
  const options: { width?: number; prefix?: string } = {}
  if (values.width !== undefined) {
    const width = Number(values.width)
    if (!Number.isInteger(width) || width <= 0) {
      return { kind: 'usage', message: `invalid --width '${values.width}': expected a positive integer` }
    }
    options.width = width
  }
  if (values.prefix !== undefined) options.prefix = values.prefix
  return { kind: 'run', args: { module, export_name: values.export ?? 'flow', options } }
}

/**
 * Read the CLI's flags with `node:util`'s strict parser, which throws on a
 * flag it does not know.
 */
function parse_flags(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      export: { type: 'string' },
      width: { type: 'string' },
      prefix: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
}

/**
 * The Step an export stands for: the export itself, or what calling it with
 * no arguments returns (awaited, so an async builder works too).
 */
async function build(value: unknown): Promise<unknown> {
  return typeof value === 'function' ? await value() : value
}

/**
 * Render a thrown value as its message.
 */
function message_of(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
