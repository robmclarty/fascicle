/**
 * The process side of the fascicle-diagram bin: the real streams, and module
 * loading through the project's own `tsx`.
 *
 * Every decision the command makes lives in diagram_cli.ts, which is unit
 * tested through an injected io. This file only binds that io to the process,
 * so it is exercised by spawning it (__tests__/diagram_bin.test.ts) and kept
 * out of mutation testing, which cannot see a spawned child's coverage.
 *
 * A TypeScript module loads through `tsx` because Node's built-in type
 * stripping cannot follow the `./flow.js` specifiers that point at `.ts`
 * files under NodeNext resolution. Anything else, or a project without
 * `tsx`, goes through a plain `import()`.
 */

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run_diagram_cli } from './diagram_cli.js'

const TS_MODULE = /\.[cm]?tsx?$/

/**
 * Run the fascicle-diagram command over `argv` against the real process, and
 * leave its exit code on `process.exitCode`. A reader that closes the pipe
 * early (`| head`) ends the output quietly instead of crashing the command on
 * an unhandled EPIPE.
 */
export async function run_diagram_bin(argv: readonly string[]): Promise<void> {
  process.stdout.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
  process.exitCode = await run_diagram_cli(argv, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    load: load_module,
  })
}

/**
 * Import the module at `path`. A TypeScript module goes through the `tsx`
 * that the project installs, looked up from the module's own directory and
 * then from the working directory. Everything else is a plain dynamic import.
 */
async function load_module(path: string): Promise<Readonly<Record<string, unknown>>> {
  const url = pathToFileURL(path).href
  if (!TS_MODULE.test(path)) return as_record(await import(url))
  const tsx = find_tsx([path, resolve('package.json')])
  if (tsx === undefined) return import_without_tsx(url)
  const api: unknown = await import(pathToFileURL(tsx).href)
  const ts_import = as_record(api)['tsImport']
  if (typeof ts_import !== 'function') return as_record(await import(url))
  return as_record(await ts_import(url, import.meta.url))
}

/**
 * Import a TypeScript module with Node's own type stripping, which handles
 * only erasable syntax and specifiers that name real files. A failure says
 * that tsx is the fix, since this path is taken only when none was found.
 */
async function import_without_tsx(url: string): Promise<Readonly<Record<string, unknown>>> {
  try {
    return as_record(await import(url))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${reason} (no tsx was found to load TypeScript: install it with pnpm add -D tsx)`, {
      cause: err,
    })
  }
}

/**
 * Resolve tsx's programmatic API from the first of `origins` that can see it,
 * or `undefined` when none can.
 */
function find_tsx(origins: readonly string[]): string | undefined {
  for (const origin of origins) {
    try {
      return createRequire(origin).resolve('tsx/esm/api')
    } catch {
      // Not installed where this origin looks; try the next one.
    }
  }
  return undefined
}

/**
 * View a loaded module namespace as a record of its exports.
 */
function as_record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

// Auto-run only when this file is the entry script (`tsx src/diagram_bin.ts`),
// never when the bundle that contains it is imported. The path comparison is
// the same guard the viewer CLI uses.
const invoked_directly =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)

if (invoked_directly) void run_diagram_bin(process.argv.slice(2))
