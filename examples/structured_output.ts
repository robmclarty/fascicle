/**
 * structured_output: constrain a model reply to a zod schema.
 *
 * The engine validates the reply against `plan_schema`. If the first reply
 * doesn't parse, it retries up to `schema_repair_attempts` times before
 * throwing `schema_validation_error`. The caller catches that error to
 * surface both the raw text and the zod issue list.
 *
 * Prereqs:
 *   ANTHROPIC_API_KEY exported in your environment.
 *
 * Run directly:
 *   pnpm exec tsx examples/structured_output.ts
 *   pnpm exec tsx examples/structured_output.ts "migrate the payments service to pg17"
 */

import { z } from 'zod';

import {
  create_engine,
  model_call,
  run,
  schema_validation_error,
} from '@repo/fascicle';

const api_key = process.env['ANTHROPIC_API_KEY'] ?? '';

const engine = create_engine({
  providers: { anthropic: { api_key } },
  defaults: {
    model: 'sonnet',
    system: 'Return a plan object matching the schema. No prose outside JSON.',
  },
});

const plan_schema = z.object({
  title: z.string(),
  steps: z.array(z.string()).min(1),
  risk: z.enum(['low', 'med', 'high']),
});

export type Plan = z.infer<typeof plan_schema>;

const plan = model_call({
  engine,
  schema: plan_schema,
  schema_repair_attempts: 2,
});

export async function run_structured_output(
  input = 'cut a minimal release candidate for the billing service',
): Promise<{ readonly input: string; readonly plan: Plan }> {
  const result = await run(plan, input, { install_signal_handlers: false });
  return { input, plan: result.content };
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  if (api_key.length === 0) {
    console.error('ANTHROPIC_API_KEY is not set');
    process.exit(1);
  }
  const argv_input = process.argv.slice(2).join(' ');
  const chosen = argv_input.length > 0 ? argv_input : undefined;
  run_structured_output(chosen)
    .then(({ input, plan: output }) => {
      console.log(`input: ${input}\n`);
      console.log(JSON.stringify(output, null, 2));
    })
    .catch((err: unknown) => {
      if (err instanceof schema_validation_error) {
        console.error('schema_validation_error:');
        console.error(`  raw_text:  ${err.raw_text}`);
        console.error(`  zod_error: ${JSON.stringify(err.zod_error)}`);
      } else {
        console.error(err);
      }
      process.exit(1);
    })
    .finally(() => {
      void engine.dispose();
    });
}
