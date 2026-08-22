# structured-output

Constrain a model reply to a zod schema. The engine validates the reply
against `plan_schema`. If the first reply doesn't parse, the engine retries
up to `schema_repair_attempts` times before throwing
`schema_validation_error`; the caller catches that error to surface both the
raw text and the zod issue list.

![terminal output of the structured-output example: the input brief and the schema-validated plan as JSON](./screenshot.png)

## Run

Prereq: `OPENROUTER_API_KEY` exported, or set in the root `.env` (see
`.env.example`).

```bash
pnpm exec tsx --env-file=.env examples/structured-output/main.ts
pnpm exec tsx --env-file=.env examples/structured-output/main.ts "migrate the payments service to pg17"
```
