import { describe, expect, it } from 'vitest';
import { flow_schema } from './index.js';

const example_from_spec = [
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
        do: { step: { id: 'ship', fn: 'deploy_fn' } },
      },
    ],
  },
];

type json_value =
  | string
  | number
  | boolean
  | null
  | json_value[]
  | { readonly [k: string]: json_value };

type schema = {
  readonly $defs?: Record<string, schema>;
  readonly $ref?: string;
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, schema>;
  readonly additionalProperties?: schema;
  readonly items?: schema;
  readonly anyOf?: readonly schema[];
  readonly oneOf?: readonly schema[];
  readonly allOf?: readonly schema[];
  readonly enum?: readonly json_value[];
  readonly minimum?: number;
};

function resolve_ref(root: schema, ref: string): schema {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: unknown = root;
  for (const part of parts) {
    node = (node as Record<string, unknown>)[part];
  }
  return node as schema;
}

function validate(data: unknown, local: schema, root: schema): string[] {
  if (local.$ref) {
    return validate(data, resolve_ref(root, local.$ref), root);
  }

  const errors: string[] = [];

  if (local.type) {
    if (local.type === 'array' && !Array.isArray(data)) {
      errors.push(`expected array, got ${typeof data}`);
      return errors;
    }
    if (local.type === 'object' && (typeof data !== 'object' || data === null || Array.isArray(data))) {
      errors.push(`expected object, got ${typeof data}`);
      return errors;
    }
    if (local.type === 'string' && typeof data !== 'string') {
      errors.push(`expected string, got ${typeof data}`);
      return errors;
    }
    if (local.type === 'integer' && (typeof data !== 'number' || !Number.isInteger(data))) {
      errors.push(`expected integer, got ${typeof data}`);
      return errors;
    }
  }

  if (local.enum && !local.enum.includes(data as json_value)) {
    errors.push(`value ${JSON.stringify(data)} not in enum`);
  }

  if (local.type === 'array' && local.items && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      const child = validate(item, local.items, root);
      errors.push(...child.map((m) => `[${i}]: ${m}`));
    }
  }

  if (local.type === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of local.required ?? []) {
      if (!(key in record)) errors.push(`missing required property: ${key}`);
    }
    for (const [key, value] of Object.entries(record)) {
      const child_schema = local.properties?.[key] ?? local.additionalProperties;
      if (child_schema) {
        const child = validate(value, child_schema, root);
        errors.push(...child.map((m) => `.${key}: ${m}`));
      }
    }
  }

  if (local.anyOf) {
    const matches = local.anyOf.map((alt) => validate(data, alt, root));
    if (!matches.some((m) => m.length === 0)) {
      errors.push('no anyOf branch matched');
    }
  }

  if (local.oneOf) {
    const matches = local.oneOf.filter((alt) => validate(data, alt, root).length === 0);
    if (matches.length !== 1) {
      errors.push(`expected exactly 1 oneOf match, got ${matches.length}`);
    }
  }

  if (local.allOf) {
    for (const alt of local.allOf) {
      errors.push(...validate(data, alt, root));
    }
  }

  return errors;
}

describe('flow_schema', () => {
  it('is exported as a valid JSON Schema document with a $defs table', () => {
    expect(flow_schema).toBeDefined();
    const s = flow_schema as unknown as schema;
    expect(s.$defs).toBeDefined();
  });

  it('defines a $defs entry for every composer', () => {
    const s = flow_schema as unknown as schema;
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
    ];
    for (const k of composer_defs) {
      expect(s.$defs?.[k]).toBeDefined();
    }
  });

  it('validates the spec §5.17 example successfully', () => {
    const errors = validate(example_from_spec, flow_schema as unknown as schema, flow_schema as unknown as schema);
    expect(errors).toEqual([]);
  });
});
