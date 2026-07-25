/**
 * Public types for the amplify loop.
 *
 * The `Metric` protocol is the load-bearing abstraction: the user defines
 * "what better means" by declaring a regression gate (a shell command) and
 * a `score` function (a thunk that returns a number). The harness is
 * metric-agnostic; it never inspects the score's meaning.
 */

export type Direction = 'minimize' | 'maximize'

export type GateConfig = {
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly expected_exit?: number
  readonly timeout_ms?: number
}

export type ScoreFn = (impl_path: string) => number | Promise<number>

export type JudgeConfig = {
  readonly rubric: string
  readonly model?: string
}

export type Metric = {
  readonly name: string
  readonly direction: Direction
  readonly mutable_path: string
  readonly gate: GateConfig
  readonly score: ScoreFn
  readonly judge?: JudgeConfig
}

export type Brief = {
  readonly task: string
  readonly target_dir: string
  readonly metric: Metric
  readonly run_id: string
  readonly run_dir: string
}

export type CandidateSpec = {
  readonly content: string
  readonly rationale: string
  readonly proposer_id: string
}

export type Score = {
  readonly value: number
  readonly accepted: boolean
  readonly stage_failed?: 'syntax' | 'gate' | 'measure'
  readonly tail?: string
}

export type Candidate = {
  readonly spec: CandidateSpec
  readonly score: Score
}

export type Lesson = {
  readonly round: number
  readonly proposer_id: string
  readonly stage_failed: 'syntax' | 'gate' | 'measure' | 'no_improvement'
  readonly summary: string
}

export type RoundResult = {
  readonly round: number
  readonly candidates: ReadonlyArray<Candidate>
  readonly winner_id: string
  readonly accepted: boolean
  readonly parent_score: number
}

/** Role-to-model table, threaded into the flow as data. */
export type FlowModels = {
  readonly proposer: string
  readonly researcher: string
}

/**
 * The loop's carry-state: everything one round needs from the last one.
 *
 * Immutable and spread-updated per round, so nothing about the run's progress
 * lives in a closure variable and the whole history is inspectable from a
 * single value.
 */
export type RoundState = {
  readonly round: number
  readonly parent_content: string
  readonly parent_score: number
  readonly baseline: number
  readonly lessons: ReadonlyArray<Lesson>
  readonly budget: BudgetState
  readonly history: ReadonlyArray<RoundRecord>
}

/** What one settled round contributes to the run's history. */
export type RoundRecord = {
  readonly round: number
  readonly winner_id: string
  readonly winner_value: number | null
  readonly parent_score: number
  readonly accepted: boolean
  readonly candidates: number
}

/** Everything one proposer needs to write its prompt. */
export type ProposerInput = {
  readonly brief: Brief
  readonly research: string
  readonly round: number
  readonly proposer_id: string
  readonly parent_content: string
  readonly parent_score: number
  readonly lessons: ReadonlyArray<Lesson>
}

/** The pure decision a settled round produces, before any file is written. */
export type RoundOutcome = {
  readonly next_state: RoundState
  readonly accepted: boolean
  readonly record: RoundRecord
}

/** What the flow hands back to the shell. */
export type RunSummary = {
  readonly baseline: number
  readonly final_score: number
  readonly improvement_pct: number
  readonly rounds_used: number
  readonly stopped_by: 'budget' | 'plateau' | 'max_rounds'
  readonly history: ReadonlyArray<RoundRecord>
}

export type BudgetConfig = {
  readonly max_rounds: number
  readonly max_wallclock_ms: number
  readonly patience: number
}

export type BudgetState = {
  readonly rounds_used: number
  readonly rounds_since_progress: number
  readonly started_at: number
  readonly max_rounds: number
  readonly max_wallclock_ms: number
  readonly patience: number
}
