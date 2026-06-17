import type { ToolExecContext } from 'fascicle'

export type ToolExecContextStub = ToolExecContext

export function make_ctx(): ToolExecContextStub {
  return {
    abort: new AbortController().signal,
    tool_call_id: 'test-call',
    step_index: 0,
  }
}
