/**
 * The types fascicle/acp speaks at its public surface. Protocol shapes stay
 * the SDK's own, imported as types where they're used, so naming them costs
 * a consumer without the optional peer nothing at runtime.
 */

/**
 * Where a model call's streamed text goes: the reply, the collapsed thought
 * block, or nowhere. A call with a `schema` streams raw JSON, and a flow with
 * several calls streams every draft, so a flow routes those away from the
 * reply by the call's `step_id`.
 */
export type AcpStreamRoute = 'message' | 'thought' | 'none'

export type AcpMapperOptions = {
  /** Prefixes every `toolCallId` so ids stay unique across turns; default: a random UUID. */
  readonly turn_id?: string | undefined
  /** Where each model call's text goes, by its `step_id`; default: `'message'` for every call. */
  readonly stream?: ((step_id: string) => AcpStreamRoute) | undefined
}

/**
 * What `to_session_updates` needs to know about the turn it maps, made once
 * per turn by `create_acp_mapper_state`.
 */
export type AcpMapperState = {
  readonly turn_id: string
  readonly stream: (step_id: string) => AcpStreamRoute
}
