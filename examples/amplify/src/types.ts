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
