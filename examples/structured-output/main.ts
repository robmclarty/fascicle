/**
 * structured-output: constrain a model reply to a zod schema.
 *
 * The engine validates the reply against `plan_schema`. If the first reply
 * doesn't parse, it retries up to `schema_repair_attempts` times before
 * throwing `schema_validation_error`. The caller catches that error to
 * surface both the raw text and the zod issue list.
 *
 * Prereqs:
 *   OPENROUTER_API_KEY exported, or set in the root .env (see .env.example).
 *
 * Run directly:
 *   pnpm exec tsx --env-file=.env examples/structured-output/main.ts
 *   pnpm exec tsx --env-file=.env examples/structured-output/main.ts "migrate the payments service to pg17"
 */

import { z } from 'zod'

import {
  create_engine,
  model_step,
  run,
  schema_validation_error,
} from 'fascicle'

const is_main = import.meta.url === `file://${process.argv[1] ?? ''}`

// No key guard here: create_engine itself rejects an empty api_key with
// `openrouter provider requires a non-empty api_key`.
const engine = create_engine({
  providers: { openrouter: { api_key: process.env['OPENROUTER_API_KEY'] ?? '' } },
  defaults: {
    model: 'openai/gpt-4o-mini',
    system: 'Return a plan object matching the schema. No prose outside JSON.',
  },
})

const plan_schema = z.object({
  title: z.string(),
  steps: z.array(z.string()).min(1),
  risk: z.enum(['low', 'med', 'high']),
})

export type Plan = z.infer<typeof plan_schema>

// `model_step`, so the step's output is the schema-validated Plan itself;
// `model_call` is the variant to reach for when you also want usage or cost.
const plan = model_step({
  engine,
  schema: plan_schema,
  schema_repair_attempts: 2,
})

export async function run_structured_output(
  input = 'cut a minimal release candidate for the billing service',
): Promise<{ readonly input: string; readonly plan: Plan }> {
  const result = await run(plan, input, { install_signal_handlers: false })
  return { input, plan: result }
}

if (is_main) {
  const argv_input = process.argv.slice(2).join(' ')
  const chosen = argv_input.length > 0 ? argv_input : undefined
  run_structured_output(chosen)
    .then(({ input, plan: output }) => {
      console.log(`input: ${input}\n`)
      console.log(JSON.stringify(output, null, 2))
    })
    .catch((err: unknown) => {
      if (err instanceof schema_validation_error) {
        console.error('schema_validation_error:')
        console.error(`  raw_text:  ${err.raw_text}`)
        console.error(`  schema_issues: ${JSON.stringify(err.schema_issues)}`)
      } else {
        console.error(err)
      }
      process.exit(1)
    })
    .finally(() => {
      void engine.dispose()
    })
}
