import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenTelemetry } from '@ai-sdk/otel'
import { build_ai_sdk_telemetry } from '../telemetry.js'

// Spy on the peer constructor so we can assert the exact options object it is
// built with (the real integration exposes nothing about its tracer argument
// after construction). `instanceof OpenTelemetry` still holds against the mock.
vi.mock('@ai-sdk/otel', () => ({ OpenTelemetry: vi.fn() }))

describe('build_ai_sdk_telemetry', () => {
  beforeEach(() => {
    vi.mocked(OpenTelemetry).mockClear()
  })

  it('returns undefined (loading no peer) when telemetry is absent or disabled', async () => {
    expect(await build_ai_sdk_telemetry(undefined)).toBeUndefined()
    expect(await build_ai_sdk_telemetry({ enabled: false })).toBeUndefined()
    // The gate short-circuits before the peer integration is ever constructed.
    expect(vi.mocked(OpenTelemetry)).not.toHaveBeenCalled()
  })

  it('builds an @ai-sdk/otel integration with exactly the enabled keys', async () => {
    const out = await build_ai_sdk_telemetry({ enabled: true })
    // With no options set, the passthrough carries only these two keys. A strict
    // whole-object match distinguishes a skipped optional field from one assigned
    // `undefined`, which a per-field `toBeUndefined` cannot.
    expect(out).toStrictEqual({ isEnabled: true, integrations: [expect.any(OpenTelemetry)] })
    // No caller tracer means the integration is constructed with an empty object.
    expect(vi.mocked(OpenTelemetry).mock.calls[0]?.[0]).toStrictEqual({})
  })

  it('maps snake_case settings onto the SDK telemetry keys', async () => {
    const out = await build_ai_sdk_telemetry({
      enabled: true,
      function_id: 'summarize',
      record_inputs: false,
      record_outputs: true,
      metadata: { tenant: 'acme', attempt: 2 },
    })
    expect(out?.functionId).toBe('summarize')
    expect(out?.recordInputs).toBe(false)
    expect(out?.recordOutputs).toBe(true)
    expect(out?.metadata).toEqual({ tenant: 'acme', attempt: 2 })
  })

  it('passes a caller-supplied tracer through to the integration', async () => {
    const fake_tracer = { startSpan: () => ({}), startActiveSpan: () => ({}) }
    const out = await build_ai_sdk_telemetry({ enabled: true, tracer: fake_tracer })
    expect(out?.integrations[0]).toBeInstanceOf(OpenTelemetry)
    // The tracer is forwarded verbatim under the `tracer` key, and nothing else.
    expect(vi.mocked(OpenTelemetry).mock.calls[0]?.[0]).toStrictEqual({ tracer: fake_tracer })
  })
})
