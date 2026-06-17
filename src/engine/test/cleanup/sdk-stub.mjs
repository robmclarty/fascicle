/**
 * Stub for `@ai-sdk/anthropic` used by the SIGINT harness.
 *
 * The anthropic adapter's `build_model` dynamically imports this peer; the
 * stub returns a dummy factory so no HTTP client is instantiated. The real
 * call entry points are stubbed via ai-stub.mjs.
 */

export function createAnthropic(_config) {
  return (model_id) => ({ _stub: true, model_id });
}
