import { describe, expect, it } from 'vitest'
import { flow_schema } from '../index.js'

const build_and_ship_example = [
  {
    compose: 'multi_judge',
    ensemble: {
      score: '(r) => r.confidence',
      members: {
        opus: { step: { id: 'judge_opus', fn: 'judge_opus_fn' } },
        sonnet: { step: { id: 'judge_sonnet', fn: 'judge_sonnet_fn' } },
        gemini: { step: { id: 'judge_gemini', fn: 'judge_gemini_fn' } },
      },
    },
  },
  {
    compose: 'build_and_ship',
    scope: [
      {
        stash: 'plan',
        do: { step: { id: 'plan', fn: 'plan_fn' } },
      },
      {
        stash: 'build',
        do: {
          checkpoint: {
            key: '(i) => `build:${i.spec_hash}`',
            do: {
              adversarial: {
                max_rounds: 3,
                accept: "(r) => r.verdict === 'pass'",
                build: { step: { id: 'build', fn: 'build_fn' } },
                critique: {
                  pipe: {
                    of: { ref: 'multi_judge' },
                    fn: '(r) => r.winner',
                  },
                },
              },
            },
          },
        },
      },
      {
        use: ['build'],
        fn: 'deploy_fn',
      },
    ],
  },
]

type json_value =
  | string
  | number
  | boolean
  | null
  | json_value[]
  | { readonly [k: string]: json_value }

type schema = {
  readonly $defs?: Record<string, schema>
  readonly $ref?: string
  readonly type?: string
  readonly required?: readonly string[]
  readonly properties?: Record<string, schema>
  readonly additionalProperties?: schema
  readonly items?: schema
  readonly anyOf?: readonly schema[]
  readonly oneOf?: readonly schema[]
  readonly allOf?: readonly schema[]
  readonly enum?: readonly json_value[]
  readonly minimum?: number
  readonly minLength?: number
}

function resolve_ref(root: schema, ref: string): schema {
  const parts = ref.replace(/^#\//, '').split('/')
  let node: unknown = root
  for (const part of parts) {
    node = (node as Record<string, unknown>)[part]
  }
  return node as schema
}

function validate(data: unknown, local: schema, root: schema): string[] {
  if (local.$ref) {
    return validate(data, resolve_ref(root, local.$ref), root)
  }

  const errors: string[] = []

  if (local.type) {
    if (local.type === 'array' && !Array.isArray(data)) {
      errors.push(`expected array, got ${typeof data}`)
      return errors
    }
    if (local.type === 'object' && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      errors.push(`expected object, got ${typeof data}`)
      return errors
    }
    if (local.type === 'string' && typeof data !== 'string') {
      errors.push(`expected string, got ${typeof data}`)
      return errors
    }
    if (local.type === 'integer' && (typeof data !== 'number' || !Number.isInteger(data))) {
      errors.push(`expected integer, got ${typeof data}`)
      return errors
    }
    if (local.type === 'number' && typeof data !== 'number') {
      errors.push(`expected number, got ${typeof data}`)
      return errors
    }
    if (local.type === 'boolean' && typeof data !== 'boolean') {
      errors.push(`expected boolean, got ${typeof data}`)
      return errors
    }
  }

  if (local.minimum !== undefined && typeof data === 'number' && data < local.minimum) {
    errors.push(`${data} is below the minimum ${local.minimum}`)
  }

  if (local.enum && !local.enum.includes(data as json_value)) {
    errors.push(`value ${JSON.stringify(data)} not in enum`)
  }

  if (local.type === 'array' && local.items && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      const child = validate(item, local.items, root)
      errors.push(...child.map((m) => `[${i}]: ${m}`))
    }
  }

  // As in JSON Schema, `required` and `properties` apply to any object, so the
  // `node` def's bare `{ required: [...] }` alternatives check their key.
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>
    for (const key of local.required ?? []) {
      if (!(key in record)) errors.push(`missing required property: ${key}`)
    }
    for (const [key, value] of Object.entries(record)) {
      const child_schema = local.properties?.[key] ?? local.additionalProperties
      if (child_schema) {
        const child = validate(value, child_schema, root)
        errors.push(...child.map((m) => `.${key}: ${m}`))
      }
    }
  }

  if (local.anyOf) {
    const matches = local.anyOf.map((alt) => validate(data, alt, root))
    if (!matches.some((m) => m.length === 0)) {
      errors.push('no anyOf branch matched')
    }
  }

  if (local.oneOf) {
    const matches = local.oneOf.filter((alt) => validate(data, alt, root).length === 0)
    if (matches.length !== 1) {
      errors.push(`expected exactly 1 oneOf match, got ${matches.length}`)
    }
  }

  if (local.allOf) {
    for (const alt of local.allOf) {
      errors.push(...validate(data, alt, root))
    }
  }

  return errors
}

const every_new_field = [
  {
    compose: 'every_field',
    sequence: [
      {
        step: {
          id: 'draft',
          fn: 'draft_fn',
          name: 'Draft',
          description: 'writes the first draft',
          side_effect: false,
          port_labels: { in: 'brief', out: 'draft' },
          arm: [{ ref: 'helper' }],
        },
      },
      {
        retry: {
          name: 'retry the call',
          description: 'rides out rate limits',
          do: { ref: 'call' },
          max_attempts: 3,
          backoff_ms: 100,
          max_delay_ms: 2000,
          jitter: true,
          when: 'is_retryable',
          on_error: 'log_attempt',
          project: 'take_value',
        },
      },
      {
        fallback: {
          primary: { ref: 'fast' },
          backup: { ref: 'slow' },
          when: 'is_overloaded',
          handoff: 'carry_input',
          project: 'take_value',
        },
      },
      {
        loop: {
          description: 'refine until good',
          init: 'seed',
          body: { ref: 'refine' },
          guard: 'is_good',
          finish: 'unwrap',
          max_rounds: 4,
        },
      },
      {
        branch: { name: 'route', when: 'is_long', then: { ref: 'a' }, otherwise: { ref: 'b' } },
      },
      { map: { description: 'per item', items: 'list', do: { ref: 'each' }, concurrency: 2 } },
      { pipe: { name: 'shape', of: { ref: 'a' }, fn: 'reshape' } },
      { timeout: { description: 'cap it', do: { ref: 'a' }, ms: 1000 } },
      { compose_node: { name: 'named', description: 'a named step', parts: { main: { ref: 'a' } }, do: { ref: 'a' } } },
      { checkpoint: { name: 'cache', do: { ref: 'a' }, key: 'cache_key' } },
      {
        suspend: {
          id: 'approve',
          name: 'approval',
          description: 'waits for a human',
          on: 'notify',
          resume_schema: 'approval_schema',
          combine: 'merge',
          deadline_ms: 60000,
        },
      },
      {
        ensemble: {
          name: 'judges',
          members: { a: { ref: 'a' } },
          score: 'score_fn',
          select: 'min',
          project: 'winner_of',
        },
      },
      {
        tournament: { description: 'bracket', members: { a: { ref: 'a' } }, compare: 'cmp', project: 'winner_of' },
      },
      {
        consensus: {
          name: 'agree',
          members: { a: { ref: 'a' } },
          agree: 'all_same',
          max_rounds: 2,
          project: 'result_of',
        },
      },
      {
        adversarial: {
          description: 'build and critique',
          build: { ref: 'a' },
          critique: { ref: 'b' },
          accept: 'passes',
          max_rounds: 2,
          project: 'candidate_of',
        },
      },
      {
        scope: [
          { stash: 'plan', name: 'plan', description: 'keeps the plan', do: { ref: 'plan' } },
          { step: { fn: 'between_fn' } },
          { use: ['plan'], name: 'ship', description: 'ships the plan', fn: 'ship_fn' },
        ],
      },
      {
        chain: {
          input: 'brief',
          steps: [
            { step: 'outline', fn: 'outline_fn', name: 'Outline', arm: { ref: 'helper' } },
            { step: 'review', arm: { ref: 'reviewer' }, select: 'pick_outline', description: 'reviews it' },
            { stage: 'polish', project: 'keep_review' },
          ],
          output: 'final_fn',
        },
      },
    ],
  },
]

const the_four_composites = [
  {
    compose: 'every_composite',
    sequence: [
      {
        gate: {
          id: 'approve_draft',
          name: 'approval',
          description: 'holds the paid draft for a human',
          do: { ref: 'draft' },
          store: 'job_store',
          format: 'summarize_draft',
        },
      },
      {
        ensemble_step: {
          name: 'pick',
          members: { a: { ref: 'a' }, b: { ref: 'b' } },
          score: { step: { id: 'judge', fn: 'judge_fn' } },
          rank_by: 'confidence_of',
          select: 'max',
          project: 'winner_of',
        },
      },
      {
        improve: {
          description: 'refines the prompt',
          seed: { ref: 'seed' },
          propose: { ref: 'propose' },
          score: { ref: 'score' },
          budget: { max_rounds: 5, max_wallclock_ms: 60000, patience: 2 },
          epsilon: 0.01,
          proposers_per_round: 2,
          lessons_capacity: 5,
          project: 'best_of',
        },
      },
      {
        learn: {
          name: 'from events',
          flow: { ref: 'agent' },
          source: { kind: 'events', events: [{ kind: 'span_start', span_id: 's1' }] },
          analyzer: { ref: 'analyze' },
          filter: 'is_error',
          max_events: 500,
        },
      },
      { learn: { flow: { ref: 'agent' }, source: { kind: 'paths', paths: ['runs/a.jsonl'] }, analyzer: { ref: 'analyze' } } },
      { learn: { flow: { ref: 'agent' }, source: { kind: 'dir', dir: 'runs' }, analyzer: { ref: 'analyze' } } },
    ],
  },
]

describe('flow_schema', () => {
  it('is exported as a valid JSON Schema document with a $defs table', () => {
    expect(flow_schema).toBeDefined()
    const s = flow_schema as unknown as schema
    expect(s.$defs).toBeDefined()
  })

  it('defines a $defs entry for every composer', () => {
    const s = flow_schema as unknown as schema
    const composer_defs = [
      'step_config',
      'sequence_config',
      'parallel_config',
      'branch_config',
      'map_config',
      'pipe_config',
      'retry_config',
      'fallback_config',
      'timeout_config',
      'adversarial_config',
      'ensemble_config',
      'tournament_config',
      'consensus_config',
      'checkpoint_config',
      'suspend_config',
      'scope_config',
      'ensemble_step_config',
      'gate_config',
      'improve_config',
      'learn_config',
    ]
    for (const k of composer_defs) {
      expect(s.$defs?.[k]).toBeDefined()
    }
  })

  it('validates the multi-judge build_and_ship example', () => {
    const errors = validate(build_and_ship_example, flow_schema, flow_schema)
    expect(errors).toEqual([])
  })

  it('validates a flow that uses every field the configs gained', () => {
    expect(validate(every_new_field, flow_schema, flow_schema)).toEqual([])
  })

  it('validates a flow that uses gate, ensemble_step, improve, and learn', () => {
    expect(validate(the_four_composites, flow_schema, flow_schema)).toEqual([])
  })

  it('rejects a gate without its id', () => {
    const flow = [{ compose: 'bad', gate: { do: { ref: 'draft' } } }]
    expect(validate(flow, flow_schema, flow_schema)).toContain('[0]: .gate: missing required property: id')
  })

  it('rejects an improve budget without its patience', () => {
    const flow = [
      {
        compose: 'bad',
        improve: { seed: { ref: 's' }, propose: { ref: 'p' }, score: { ref: 'c' }, budget: { max_rounds: 3 } },
      },
    ]
    expect(validate(flow, flow_schema, flow_schema)).toContain(
      '[0]: .improve: .budget: missing required property: patience',
    )
  })

  it('rejects a learn source of a kind that learn lacks', () => {
    const flow = [
      { compose: 'bad', learn: { flow: { ref: 'a' }, source: { kind: 'url', url: 'x' }, analyzer: { ref: 'b' } } },
    ]
    expect(validate(flow, flow_schema, flow_schema)).toContain(
      '[0]: .learn: .source: expected exactly 1 oneOf match, got 0',
    )
  })

  it('rejects a loop without init or finish', () => {
    const loop_without = (missing: 'init' | 'finish') => {
      const config: Record<string, unknown> = {
        init: 'seed',
        body: { ref: 'refine' },
        finish: 'unwrap',
        max_rounds: 2,
      }
      delete config[missing]
      return [{ compose: 'bad', loop: config }]
    }
    expect(validate(loop_without('init'), flow_schema, flow_schema)).toContain(
      '[0]: .loop: missing required property: init',
    )
    expect(validate(loop_without('finish'), flow_schema, flow_schema)).toContain(
      '[0]: .loop: missing required property: finish',
    )
  })

  it('rejects a use entry that names a node instead of a function', () => {
    const flow = [{ compose: 'bad', scope: [{ use: ['plan'], do: { ref: 'ship' } }] }]
    expect(validate(flow, flow_schema, flow_schema)).not.toEqual([])
  })

  it('rejects a chain arm entry without its select', () => {
    const flow = [{ compose: 'bad', chain: { steps: [{ step: 'review', arm: { ref: 'r' } }], output: 'out' } }]
    expect(validate(flow, flow_schema, flow_schema)).not.toEqual([])
  })

  it('rejects a field of the wrong type', () => {
    const flow = [{ compose: 'bad', retry: { do: { ref: 'a' }, max_attempts: 2, jitter: 'yes' } }]
    expect(validate(flow, flow_schema, flow_schema)).toContain('[0]: .retry: .jitter: expected boolean, got string')
  })
})
