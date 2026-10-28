import type {
  BranchConfig,
  ChainStepOptions,
  CheckpointConfig,
  ComposeConfig,
  FallbackOptions,
  FallbackProjection,
  LoopConfig,
  MapConfig,
  PipeOptions,
  RetryConfig,
  RetryProjection,
  StashOptions,
  StepOptions,
  SuspendConfig,
  TimeoutOptions,
  UseOptions,
} from '#core'
import { flow_schema } from '#core'
import { describe, expect, it } from 'vitest'
import type { AdversarialConfig } from '../adversarial.js'
import type { ConsensusConfig } from '../consensus.js'
import type { EnsembleConfig } from '../ensemble.js'
import type { EnsembleStepConfig } from '../ensemble_step.js'
import type { GateConfig } from '../gate.js'
import type { ImproveBudget, ImproveConfig } from '../improve.js'
import type { LearnConfig, LearnInput, TrajectorySource } from '../learn.js'
import type { TournamentConfig } from '../tournament.js'

// These pins live with the composites, not beside flow_schema in core,
// because only this layer may import both core's configs and the
// composites' own.

type OptionalKeys<t> = { [k in keyof t]-?: {} extends Pick<t, k> ? k : never }[keyof t]
type RequiredKeys<t> = Exclude<keyof t, OptionalKeys<t>>

// Resolves to `unknown` when `list` names every member of `all`, and to an
// object naming the missing members otherwise, so a short list fails to
// typecheck with the missing keys in the message.
type Covers<all, list extends readonly unknown[]> = [all] extends [list[number]]
  ? unknown
  : { readonly missing: Exclude<all, list[number]> }

type Pin = { readonly properties: readonly string[]; readonly required: readonly string[] }

/**
 * A $def's fields, checked at compile time against its composer's config:
 * `properties` holds every key of `config` plus the positional arguments that
 * the YAML spells as keys, and nothing else, and `required` holds exactly the
 * required ones. A field added to a config fails this file's typecheck until
 * the schema and its pin gain it too.
 */
function pin<config, positional extends string = never, positional_required extends positional = never>() {
  return <
    const p extends ReadonlyArray<(keyof config & string) | positional>,
    const r extends ReadonlyArray<(RequiredKeys<config> & string) | positional_required>,
  >(
    properties: p & Covers<(keyof config & string) | positional, p>,
    required: r & Covers<(RequiredKeys<config> & string) | positional_required, r>,
  ): Pin => ({ properties, required })
}

// `sequence_config` and `parallel_config` are absent: one is a list and the
// other a map of members, so their `name` and `description` have no key to
// sit under. `scope_config` is a list for the same reason, and its entries
// are pinned one by one. `chain_config` has no config type behind it, since
// `chain` is a builder, so its pin names the builder's calls.
const pins: Record<string, Pin> = {
  step_config: pin<StepOptions, 'id' | 'fn', 'fn'>()(
    ['id', 'fn', 'name', 'description', 'side_effect', 'port_labels', 'arm'],
    ['fn'],
  ),
  branch_config: pin<BranchConfig<unknown, unknown>>()(
    ['name', 'description', 'when', 'then', 'otherwise'],
    ['when', 'then', 'otherwise'],
  ),
  map_config: pin<MapConfig<unknown, unknown, unknown>>()(
    ['name', 'description', 'items', 'do', 'concurrency', 'settle'],
    ['items', 'do'],
  ),
  pipe_config: pin<PipeOptions, 'of' | 'fn', 'of' | 'fn'>()(
    ['name', 'description', 'of', 'fn'],
    ['of', 'fn'],
  ),
  retry_config: pin<RetryConfig & RetryProjection<unknown, unknown>, 'do', 'do'>()(
    [
      'name',
      'description',
      'do',
      'max_attempts',
      'backoff_ms',
      'max_delay_ms',
      'jitter',
      'when',
      'on_error',
      'project',
    ],
    ['do', 'max_attempts'],
  ),
  fallback_config: pin<
    FallbackOptions & FallbackProjection<unknown, unknown>,
    'primary' | 'backup',
    'primary' | 'backup'
  >()(['name', 'description', 'primary', 'backup', 'when', 'handoff', 'project'], ['primary', 'backup']),
  timeout_config: pin<TimeoutOptions, 'do' | 'ms', 'do' | 'ms'>()(
    ['name', 'description', 'do', 'ms'],
    ['do', 'ms'],
  ),
  compose_node_config: pin<ComposeConfig, 'do', 'do'>()(['name', 'description', 'parts', 'do'], ['name', 'do']),
  loop_config: pin<LoopConfig<unknown, unknown, unknown>>()(
    ['name', 'description', 'init', 'body', 'guard', 'finish', 'max_rounds'],
    ['init', 'body', 'finish', 'max_rounds'],
  ),
  adversarial_config: pin<AdversarialConfig<unknown, unknown>>()(
    ['name', 'description', 'build', 'critique', 'accept', 'max_rounds', 'project'],
    ['build', 'critique', 'accept', 'max_rounds'],
  ),
  ensemble_config: pin<EnsembleConfig<unknown, unknown>>()(
    ['name', 'description', 'members', 'score', 'select', 'project'],
    ['members', 'score'],
  ),
  tournament_config: pin<TournamentConfig<unknown, unknown>>()(
    ['name', 'description', 'members', 'compare', 'project'],
    ['members', 'compare'],
  ),
  consensus_config: pin<ConsensusConfig<unknown, unknown>>()(
    ['name', 'description', 'members', 'agree', 'max_rounds', 'project'],
    ['members', 'agree', 'max_rounds'],
  ),
  ensemble_step_config: pin<EnsembleStepConfig<unknown, unknown, unknown>>()(
    ['name', 'description', 'members', 'score', 'rank_by', 'select', 'project'],
    ['members', 'score', 'rank_by'],
  ),
  gate_config: pin<GateConfig<unknown>, 'do', 'do'>()(
    ['id', 'name', 'description', 'do', 'store', 'format'],
    ['id', 'do'],
  ),
  improve_config: pin<ImproveConfig<unknown, unknown>>()(
    [
      'name',
      'description',
      'seed',
      'propose',
      'score',
      'budget',
      'epsilon',
      'proposers_per_round',
      'lessons_capacity',
      'project',
    ],
    ['seed', 'propose', 'score', 'budget'],
  ),
  improve_budget: pin<ImproveBudget>()(['max_rounds', 'max_wallclock_ms', 'patience'], ['max_rounds', 'patience']),
  learn_config: pin<LearnConfig<LearnInput, unknown>>()(
    ['name', 'description', 'flow', 'source', 'analyzer', 'filter', 'max_events'],
    ['flow', 'source', 'analyzer'],
  ),
  learn_events_source: pin<Extract<TrajectorySource, { kind: 'events' }>>()(['kind', 'events'], ['kind', 'events']),
  learn_paths_source: pin<Extract<TrajectorySource, { kind: 'paths' }>>()(['kind', 'paths'], ['kind', 'paths']),
  learn_dir_source: pin<Extract<TrajectorySource, { kind: 'dir' }>>()(['kind', 'dir'], ['kind', 'dir']),
  checkpoint_config: pin<CheckpointConfig<unknown>, 'do', 'do'>()(
    ['name', 'description', 'do', 'key', 'on_write_error', 'on_read_error'],
    ['do', 'key'],
  ),
  suspend_config: pin<SuspendConfig<unknown, unknown, unknown>>()(
    ['id', 'name', 'description', 'deadline_ms', 'on', 'resume_schema', 'combine'],
    ['id', 'on', 'resume_schema', 'combine'],
  ),
  stash_entry: pin<StashOptions, 'stash' | 'do', 'stash' | 'do'>()(
    ['name', 'description', 'stash', 'do'],
    ['stash', 'do'],
  ),
  use_entry: pin<UseOptions, 'use' | 'fn', 'use' | 'fn'>()(
    ['name', 'description', 'use', 'fn'],
    ['use', 'fn'],
  ),
  chain_config: pin<object, 'input' | 'steps' | 'output', 'steps' | 'output'>()(
    ['input', 'steps', 'output'],
    ['steps', 'output'],
  ),
  chain_step_entry: pin<ChainStepOptions, 'step' | 'fn', 'step' | 'fn'>()(
    ['name', 'description', 'step', 'fn', 'arm'],
    ['step', 'fn'],
  ),
  chain_arm_entry: pin<ChainStepOptions, 'step' | 'arm' | 'select', 'step' | 'arm' | 'select'>()(
    ['name', 'description', 'step', 'arm', 'select'],
    ['step', 'arm', 'select'],
  ),
  chain_stage_entry: pin<object, 'stage' | 'project', 'stage'>()(['stage', 'project'], ['stage']),
}

type SchemaDef = { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] }

// The defs that hold no composer's fields: the entry and node wrappers, the
// list and member-map configs named above, and the unions that pick a form.
const UNPINNED = [
  'compose_entry',
  'node',
  'sequence_config',
  'parallel_config',
  'scope_config',
  'scope_entry',
  'chain_entry',
  'arms',
  'learn_source',
]

describe('flow_schema pins', () => {
  it('pins every def that holds a composer config', () => {
    const defs = Object.keys((flow_schema as { readonly $defs: Record<string, SchemaDef> }).$defs)
    expect(defs.toSorted()).toEqual([...Object.keys(pins), ...UNPINNED].toSorted())
  })

  it.each(Object.entries(pins))('pins %s against its composer config', (name, expected) => {
    const defs = (flow_schema as { readonly $defs: Record<string, SchemaDef> }).$defs
    const def = defs[name]
    expect(Object.keys(def?.properties ?? {}).toSorted()).toEqual([...expected.properties].toSorted())
    expect([...(def?.required ?? [])].toSorted()).toEqual([...expected.required].toSorted())
  })
})
