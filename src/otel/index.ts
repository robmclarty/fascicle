/**
 * `fascicle/otel`: the OpenTelemetry trajectory bridge subpath, Layer 1 of
 * the two OpenTelemetry layers in docs/configuration.md.
 *
 * Deliberately separate from the umbrella entry so the OTel peer stays optional:
 * importing `fascicle` pulls in no OTel packages; only `fascicle/otel` does.
 */

export { create_otel_trajectory_logger } from './trajectory_logger.js'
export type { OtelTrajectoryLoggerOptions } from './trajectory_logger.js'
export type { OtelMetricsOptions } from './metrics.js'
