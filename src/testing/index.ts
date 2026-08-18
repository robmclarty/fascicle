/**
 * Public surface for testing.
 *
 * Published as `fascicle/testing`: canned engine doubles for driving real
 * flows through the real `run()` with zero network. `make_stub_engine`
 * scripts responses routed by system-prompt prefix; `make_script_engine`
 * consumes a response queue in strict call order; `make_capture_engine`
 * records what each call sent to the engine; `text_of` reads the
 * user-visible prompt text back out of a captured call.
 */

/**
 * The shell for rolling your own double: a custom double must implement only
 * `generate` (resolve a complete `GenerateResult`; honor `opts.abort`,
 * `opts.on_chunk`, and `opts.schema` only as far as the code under test
 * exercises them) and need not implement pricing, `with_providers`, or
 * `dispose`, which this shell supplies inert.
 */
export { engine_from_generate } from './engine_from_generate.js'
export { make_capture_engine } from './make_capture_engine.js'
export type { CaptureEngine, CaptureEngineOptions } from './make_capture_engine.js'
export { make_script_engine } from './make_script_engine.js'
export type { ScriptEngineOptions, ScriptResponse } from './make_script_engine.js'
export { make_stub_engine } from './make_stub_engine.js'
export type { StubContentFn, StubEngineOptions, StubResponse } from './make_stub_engine.js'
export { text_of } from './text_of.js'
