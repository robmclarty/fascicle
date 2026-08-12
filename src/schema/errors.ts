/**
 * The one error this zone raises.
 *
 * It lives here rather than in core's taxonomy because core imports this zone,
 * and reaching back for an error class would close a cycle.
 */

export class schema_not_convertible_error extends Error {
  // Part of the published discriminant surface: consumers switch on `kind`
  // outside this repo, so the field has no in-repo production reader.
  // fallow-ignore-next-line unused-class-member
  readonly kind = 'schema_not_convertible_error' as const;
  readonly vendor: string;
  constructor(vendor: string, message?: string) {
    super(
      message ??
        `schema vendor '${vendor}' does not implement Standard JSON Schema, so it cannot be sent to a model as JSON Schema`,
    )
    this.name = 'schema_not_convertible_error'
    this.vendor = vendor
  }
}
