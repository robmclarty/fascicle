/**
 * Public surface for process.
 *
 * Glue that more than one process entry point needs, such as moving the
 * console off stdout. Internal to the package: `#process` has no published
 * subpath, because `fascicle/acp` and `fascicle/stdio` share it and neither
 * may import the other.
 */

export { route_console_to_stderr } from './console.js'
