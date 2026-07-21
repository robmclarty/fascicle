/**
 * AI SDK telemetry wiring, confined to the ai_sdk transport.
 *
 * `@ai-sdk/otel` is adopted strictly below the turn seam: it instruments one
 * turn inside this module, never the loop. The peer is loaded lazily and only
 * when telemetry is explicitly enabled, so the disabled default (every call
 * that does not opt in) pulls in nothing.
 *
 * This is the ONLY place `@ai-sdk/otel` is referenced. generate.ts and
 * create_engine.ts thread a plain `AiSdkTelemetrySettings` value through the
 * seam and stay SDK-agnostic; loop-level, transport-neutral tracing is the
 * separate `fascicle/otel` bridge.
 */

import type { AiSdkTelemetrySettings } from '../../types.js'
import { load_optional_peer } from '../types.js'

type OpenTelemetryCtor = new (options?: { tracer?: unknown }) => unknown

type AiSdkOtelModule = {
  readonly OpenTelemetry: OpenTelemetryCtor
}

/**
 * The subset of the AI SDK's telemetry option shape this module produces, using
 * the SDK's own (camelCase) keys. Cast onto `experimental_telemetry` at the
 * call site.
 */
export type AiSdkTelemetryPassthrough = {
  isEnabled: true
  integrations: unknown[]
  functionId?: string
  recordInputs?: boolean
  recordOutputs?: boolean
  metadata?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Build the AI SDK's `experimental_telemetry` option from engine settings,
 * loading the `@ai-sdk/otel` peer only when telemetry is enabled.
 */
export async function build_ai_sdk_telemetry(
  settings: AiSdkTelemetrySettings | undefined,
): Promise<AiSdkTelemetryPassthrough | undefined> {
  if (!settings?.enabled) return undefined
  const mod = await load_optional_peer<AiSdkOtelModule>('@ai-sdk/otel')
  const integration = new mod.OpenTelemetry(
    settings.tracer !== undefined ? { tracer: settings.tracer } : {},
  )
  const out: AiSdkTelemetryPassthrough = { isEnabled: true, integrations: [integration] }
  if (settings.function_id !== undefined) out.functionId = settings.function_id
  if (settings.record_inputs !== undefined) out.recordInputs = settings.record_inputs
  if (settings.record_outputs !== undefined) out.recordOutputs = settings.record_outputs
  if (settings.metadata !== undefined) out.metadata = settings.metadata
  return out
}
