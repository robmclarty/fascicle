// run() installs SIGINT/SIGTERM handlers unless a suite opts out, and vitest
// reuses one worker process across a file's suites, so those handlers accumulate
// between tests. Suites clear them in afterEach; sharing the teardown keeps every
// suite removing exactly the same handlers.
export function remove_signal_listeners(): void {
  for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
  for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
}
