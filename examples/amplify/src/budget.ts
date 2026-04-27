/**
 * Triple-OR stop condition: max iterations, wall-clock, plateau.
 *
 * Any one alone fails: a max-iterations cap can let a stuck loop burn 6
 * hours; a wall-clock alone hits the limit but says nothing about whether
 * progress was being made; a plateau alone runs forever if the model keeps
 * producing tiny noise-level wins. All three together are the OpenEvolve /
 * AlphaEvolve / Karpathy autoresearch pattern.
 */

export type BudgetConfig = {
  readonly max_rounds: number;
  readonly max_wallclock_ms: number;
  readonly patience: number;
};

export type Budget = {
  exhausted: () => boolean;
  plateau: () => boolean;
  note_progress: () => void;
  note_no_progress: () => void;
  next_round: () => number;
  state: () => Readonly<BudgetState>;
};

export type BudgetState = {
  readonly rounds_used: number;
  readonly rounds_since_progress: number;
  readonly elapsed_ms: number;
  readonly max_rounds: number;
  readonly max_wallclock_ms: number;
  readonly patience: number;
};

export function make_budget(config: BudgetConfig): Budget {
  const started = Date.now();
  let rounds_used = 0;
  let rounds_since_progress = 0;

  const elapsed = (): number => Date.now() - started;

  return {
    next_round: (): number => {
      rounds_used += 1;
      return rounds_used;
    },
    note_progress: (): void => {
      rounds_since_progress = 0;
    },
    note_no_progress: (): void => {
      rounds_since_progress += 1;
    },
    exhausted: (): boolean => {
      return rounds_used >= config.max_rounds || elapsed() >= config.max_wallclock_ms;
    },
    plateau: (): boolean => {
      return rounds_since_progress >= config.patience;
    },
    state: (): Readonly<BudgetState> => ({
      rounds_used,
      rounds_since_progress,
      elapsed_ms: elapsed(),
      max_rounds: config.max_rounds,
      max_wallclock_ms: config.max_wallclock_ms,
      patience: config.patience,
    }),
  };
}
