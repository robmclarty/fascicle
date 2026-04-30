/**
 * Public surface for @repo/composites.
 *
 * The four built-in composite patterns (ensemble, tournament, consensus,
 * adversarial) are implemented entirely as compositions of @repo/core
 * primitives plus `compose` and `loop`. They live here, not in core,
 * because they are conveniences — not architectural primitives. Their
 * source code is intended to read as canonical examples of how user-built
 * composites work.
 */

export { adversarial } from './adversarial.js';
export type {
  AdversarialBuildInput,
  AdversarialConfig,
  AdversarialCritiqueResult,
  AdversarialResult,
} from './adversarial.js';

export { consensus } from './consensus.js';
export type { ConsensusConfig, ConsensusResult } from './consensus.js';

export { ensemble } from './ensemble.js';
export type { EnsembleConfig, EnsembleResult } from './ensemble.js';

export { improve } from './improve.js';
export type {
  Candidate,
  HistoryEntry,
  ImproveBudget,
  ImproveConfig,
  ImproveResult,
  ImproveRoundInput,
  Lesson,
  ScoredCandidate,
} from './improve.js';

export { learn } from './learn.js';
export type {
  Improvement,
  LearnConfig,
  LearnInput,
  LearnResult,
  TrajectorySource,
} from './learn.js';

export { tournament } from './tournament.js';
export type { BracketRecord, TournamentConfig, TournamentResult } from './tournament.js';
