/**
 * Shared types for the RGR harness.
 *
 * There is no model-output schema here: the coder role replies in prose and
 * every claim it makes is checked by the test oracle and the structural
 * backstop instead. What crosses module boundaries is the behavior list, the
 * oracle's verdict, and the test-file snapshots the backstop compares.
 */

export type Behavior = {
  readonly id: string
  readonly description: string
}

export type TestVerdict = {
  readonly passed: boolean
  readonly exit_code: number
  readonly tail: string
}

export type FileEntry = {
  readonly content: string
  readonly test_count: number
}

export type Snapshot = ReadonlyMap<string, FileEntry>

/** Role-to-model table, threaded into the flow as data. */
export type FlowModels = {
  readonly coder: string
}
