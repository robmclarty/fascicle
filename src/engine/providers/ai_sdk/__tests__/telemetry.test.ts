import { describe, expect, it } from 'vitest'
import { OpenTelemetry } from '@ai-sdk/otel'
import { build_ai_sdk_telemetry } from '../telemetry.js'

describe('build_ai_sdk_telemetry', () => {
  it('returns undefined (loading no peer) when telemetry is absent or disabled', async () => {
    expect(await build_ai_sdk_telemetry(undefined)).toBeUndefined()
    expect(await build_ai_sdk_telemetry({ enabled: false })).toBeUndefined()
  })

  it('builds an @ai-sdk/otel integration when enabled', async () => {
    const out = await build_ai_sdk_telemetry({ enabled: true })
    expect(out?.isEnabled).toBe(true)
    expect(out?.integrations).toHaveLength(1)
    expect(out?.integrations[0]).toBeInstanceOf(OpenTelemetry)
    // Options default off unless the caller set them.
    expect(out?.functionId).toBeUndefined()
    expect(out?.recordInputs).toBeUndefined()
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

  it('accepts a caller-supplied tracer without throwing', async () => {
    const fake_tracer = { startSpan: () => ({}), startActiveSpan: () => ({}) }
    const out = await build_ai_sdk_telemetry({ enabled: true, tracer: fake_tracer })
    expect(out?.integrations[0]).toBeInstanceOf(OpenTelemetry)
  })
})
