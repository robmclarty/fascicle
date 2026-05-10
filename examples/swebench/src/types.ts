/**
 * Wire types for the SWE-bench smoke harness.
 *
 * Mirror the columns of the `princeton-nlp/SWE-bench_Verified` HuggingFace
 * dataset for inputs, and the `predictions.jsonl` shape the eval harness
 * consumes for outputs. Field names match the public schema so prediction
 * files are directly consumable by `swebench.harness.run_evaluation` and
 * `sb-cli submit`.
 */

export type SweBenchInstance = {
  readonly instance_id: string
  readonly repo: string
  readonly base_commit: string
  readonly problem_statement: string
  readonly hints_text: string
  readonly test_patch: string
  readonly version: string
  readonly fail_to_pass: ReadonlyArray<string>
  readonly pass_to_pass: ReadonlyArray<string>
}

export type Prediction = {
  readonly instance_id: string
  readonly model_name_or_path: string
  readonly model_patch: string
}

export type EvalRecord = {
  readonly instance_id: string
  readonly resolved: boolean
  readonly summary: string
}

export type EvalReport = {
  readonly total: number
  readonly resolved: number
  readonly resolution_rate: number
  readonly records: ReadonlyArray<EvalRecord>
}
