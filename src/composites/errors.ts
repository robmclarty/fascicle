/**
 * Typed errors for the composites layer.
 *
 * Listed alongside src/core/errors.ts, src/engine/errors.ts, and
 * src/mcp/errors.ts in the `no-class` rule ignores: `instanceof` branching is
 * how a caller tells a benched flow's usage error apart from a case failure.
 */

export class bench_suspend_error extends Error {
  readonly kind = 'bench_suspend_error' as const;
  declare readonly path?: ReadonlyArray<string>;
  readonly case_id: string;
  readonly suspend_id: string;
  constructor(case_id: string, suspend_id: string, message?: string) {
    super(
      message ??
        `bench: case ${case_id} suspended at ${suspend_id}; bench cannot resume a suspended flow`,
    )
    this.name = 'bench_suspend_error'
    this.case_id = case_id
    this.suspend_id = suspend_id
  }
}
