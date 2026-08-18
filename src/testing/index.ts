/**
 * Public surface for testing.
 *
 * Published as `fascicle/testing`: canned engine doubles for driving real
 * flows through the real `run()` with zero network. `make_stub_engine`
 * scripts responses routed by system-prompt prefix; `make_capture_engine`
 * records what each call sent to the engine.
 */

export { make_stub_engine } from './make_stub_engine.js'
export type { StubEngineOptions, StubResponse } from './make_stub_engine.js'
export { make_capture_engine } from './make_capture_engine.js'
export type { CaptureEngine, CaptureEngineOptions } from './make_capture_engine.js'
