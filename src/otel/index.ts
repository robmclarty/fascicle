/**
 * `fascicle/otel` — OpenTelemetry bridge subpath (D7, Layer 1).
 *
 * Deliberately separate from the umbrella entry so the OTel peer stays optional:
 * importing `fascicle` pulls in no OTel packages; only `fascicle/otel` does.
 */

export { create_otel_trajectory_logger } from './trajectory_logger.js'
export type { OtelTrajectoryLoggerOptions } from './trajectory_logger.js'
