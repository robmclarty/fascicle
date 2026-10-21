# Going Live

The solver works with a stand-in. Now it gets a real model. You'll pick a
provider, keep your key out of your code, and write one small file whose only
job is making engines. Then comes the part that makes Fascicle worth learning:
you'll move the same flow to a different model, from a different company, by
changing one setting, and the flow won't change at all. About twenty minutes,
and the first lesson that costs money (a small fraction of a cent).

## Pick a Provider

A provider is whoever runs the model for you. Fascicle talks to several, and
these four need nothing beyond the `fascicle` package you already installed:

| Provider | What you need | Why you'd pick it |
| --- | --- | --- |
| OpenRouter | an account, some credit, and an API key | one key reaches hundreds of models from many companies |
| Anthropic | an API key | Claude models, straight from the source |
| OpenAI | an API key | GPT models, straight from the source |
| Ollama | Ollama installed, and a model pulled | free and private, since it runs on your own machine |

If you're not sure, choose OpenRouter. A few dollars of credit covers this whole
course many times over. If you'd rather spend nothing at all, choose Ollama, and
expect it to be slower than the others.

## Keep Your Key out of Your Code

Create a file called `.env` in your workbench and put your key in it:

```text
OPENROUTER_API_KEY=sk-or-your-key-here
```

Your `.gitignore` from [lesson 0](./00-set-up.md) already keeps this file out of
git. Never paste a key into a `.ts` file, because code gets committed, shared,
and pasted into chats, and keys in code leak. When you run something that needs
the key, tell Node to read the file:

```bash
pnpm exec tsx --env-file=.env solver/main.ts
```

Node loads each line of `.env` into `process.env` for that one run, and your
code reads it from there. (With Anthropic or OpenAI, the line is
`ANTHROPIC_API_KEY=...` or `OPENAI_API_KEY=...` instead, and Ollama needs no key
at all.)

## One File Makes Engines

An engine is the thing that actually talks to a provider. Create `engine.ts` in
the root of your workbench, beside the `solver` folder, since every app you
build in the workbench will share it:

```ts
// engine.ts
import { create_engine } from 'fascicle'
import type { Engine } from 'fascicle'

export type Choice = { engine: Engine; model: string }

/**
 * Build the engine and pick the model from environment settings, so moving to
 * another provider is a setting rather than a code change. With no provider
 * set, the app's own stub answers, which costs nothing and needs no key.
 */
export function engine_from_env(make_stub: () => Engine, env = process.env): Choice {
  const provider = env['FASCICLE_PROVIDER'] ?? 'stub'
  const model = env['FASCICLE_MODEL']
  if (provider === 'stub') {
    return { engine: make_stub(), model: 'stub' }
  }
  if (provider === 'openrouter') {
    const api_key = need(env, 'OPENROUTER_API_KEY')
    return { engine: create_engine({ providers: { openrouter: { api_key, transport: 'native' } } }), model: model ?? 'anthropic/claude-haiku-5.5' }
  }
  if (provider === 'anthropic') {
    const api_key = need(env, 'ANTHROPIC_API_KEY')
    return { engine: create_engine({ providers: { anthropic: { api_key, transport: 'native' } } }), model: model ?? 'claude-haiku-5-5' }
  }
  if (provider === 'openai') {
    const api_key = need(env, 'OPENAI_API_KEY')
    return { engine: create_engine({ providers: { openai: { api_key, transport: 'native' } } }), model: model ?? 'gpt-5-mini' }
  }
  if (provider === 'ollama') {
    const base_url = env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
    return { engine: create_engine({ providers: { ollama: { base_url, transport: 'native' } } }), model: model ?? 'qwen3:4b-instruct-2507-q4_K_M' }
  }
  throw new Error(`unknown FASCICLE_PROVIDER "${provider}": use stub, openrouter, anthropic, openai, or ollama`)
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: add it to .env, or export it in your shell`)
  }
  return value
}
```

A few things in there are worth slowing down for.

- **`create_engine({ providers: { ... } })`** builds an engine. An engine can
  hold several providers, but each one that this file builds holds just one, so
  every call goes there. `transport: 'native'` means Fascicle speaks to the
  provider over plain HTTP, with no extra packages to install.
- **The provider and the model come from settings.** `FASCICLE_PROVIDER` picks
  the provider and `FASCICLE_MODEL` overrides the model. With nothing set, the
  stub answers, so every lesson so far still runs for free, and so will your
  tests.
- **Model names go to the provider exactly as you write them.** Each provider
  names its models its own way, which is why the same Claude model is
  `anthropic/claude-haiku-5.5` on OpenRouter and `claude-haiku-5-5` on
  Anthropic. Fascicle doesn't translate between them, and when a name is wrong,
  the provider says so.
- **This is the only file that calls `create_engine`.** Everything else is
  handed an engine. That one rule is what turns changing providers into a
  setting.

The function takes the stub as a parameter (`make_stub`) because each app in
your workbench has its own stand-in, scripted for its own prompts.

## Run It Live

Update `solver/main.ts` to get its engine from `engine.ts`:

```ts
// solver/main.ts
import { run } from 'fascicle'
import { engine_from_env } from '../engine.js'
import { build_solver } from './flow.js'
import { make_solver_stub } from './stub.js'

const question = process.argv[2] ?? 'Sam has 3 apples and buys 4 more. How many apples does Sam have?'

const { engine, model } = engine_from_env(make_solver_stub)
try {
  console.log(await run(build_solver(engine, model), question))
} finally {
  await engine.dispose()
}
```

Run it the old way first. With no provider set, the stub answers as before:

```bash
pnpm exec tsx solver/main.ts
```

```text
7
Sam started with 3 apples and bought 4 more, so Sam has 7.
```

Now ask a real model a question that the stub has never seen:

```bash
FASCICLE_PROVIDER=openrouter pnpm exec tsx --env-file=.env solver/main.ts "A baker made 24 muffins and packed them equally into 6 boxes. How many muffins are in each box?"
```

```text
4
Since 24 muffins were shared equally among 6 boxes, each box holds 4 muffins.
```

That's a real model reading English, and it'll word the explanation a little
differently every time you run it. The `4` won't change, because code worked it
out. If you'd like live to be your default, add `FASCICLE_PROVIDER=openrouter`
to `.env` too.

## Same Flow, Different Brain

Now ask the same question of a model from a different company:

```bash
FASCICLE_PROVIDER=openrouter FASCICLE_MODEL=openai/gpt-5-mini pnpm exec tsx --env-file=.env solver/main.ts "A baker made 24 muffins and packed them equally into 6 boxes. How many muffins are in each box?"
```

```text
4
When 24 muffins are packed equally into 6 boxes, each box contains 4 muffins.
```

Or move it onto your own machine. Install [Ollama](https://ollama.com), pull a
small model, and run the same command with a different provider:

```bash
ollama pull qwen3:4b-instruct-2507-q4_K_M
FASCICLE_PROVIDER=ollama pnpm exec tsx solver/main.ts "A baker made 24 muffins and packed them equally into 6 boxes. How many muffins are in each box?"
```

```text
4
Each box has 4 muffins.
```

Stop and notice what you didn't do. You didn't open `flow.ts`. The flow
describes the job, the engine decides who does the thinking, and the two meet
in exactly one place, so you can change either one without the other knowing.
That's the main reason to build with Fascicle at all, and it's what lets you
start cheap, try a bigger model when quality matters, or move to a local model
when privacy does.

## What It Costs

A live run of the solver makes two model calls, one to read the question and
one to explain the answer. On Claude Haiku 5.5 through OpenRouter, a run measured at a hundredth or two of a cent. The next lesson shows you where to
see the cost of every run, without doing any arithmetic yourself.

## When It Doesn't Work

| What you see | What it means |
| --- | --- |
| `OPENROUTER_API_KEY is not set: add it to .env, or export it in your shell` | You left off `--env-file=.env`, or `.env` doesn't have the line. |
| `provider_auth_error: openrouter authentication failed (401): User not found.` | The key is wrong, or it's been revoked. |
| `provider_error: openrouter API error 400: anthropic/claude-haiku-9 is not a valid model ID` | That model name doesn't exist on that provider. Look it up in the provider's model list, and copy it exactly. |
| `unknown FASCICLE_PROVIDER "open-router"` | A typo in the setting. |
| `provider_error: ollama native: network failure: fetch failed`, after a pause | Ollama isn't running, so the engine retried a few times and gave up. Start it with `ollama serve`. |
| `schema_validation_error` from a live model | The model couldn't produce the shape, even after one try at fixing it. Try a bigger model, or make the example in the prompt clearer. |

Every one of those messages says what went wrong and what to do about it.
Fascicle's errors are written that way on purpose, and it's a good standard for
your own.

## With Your Agent

> Run the solver against the stub and then against OpenRouter, on three word
> problems of your choosing, one each for subtract, multiply, and divide. Show
> me the answers side by side, and don't change any code.

Watch for whether your agent changes code to switch providers. It shouldn't
need to, since a setting does it. If it edits `flow.ts`, stop it and ask why.

> Explain why create_engine should appear in exactly one file in my project.

A good answer talks about swapping providers with a setting, about tests
getting a stub without touching the flow, and about having one place to look
when a key or a model name is wrong.

## Try It

1. Try two different models on the same question, and compare their
   explanations.
2. Ask the solver something that isn't a word problem at all, like "What is the
   capital of France?" Read the answer carefully. Who's at fault, the model or
   the flow? (Hold onto that thought for [lesson 8](./08-when-things-break.md).)
3. Use a model name that doesn't exist, and read the error.

## Remember

- `create_engine` lives in one file, and every other file is handed an engine.
- Keys live in `.env`, reach your code through `process.env`, and never go into
  code.
- Model names go to the provider exactly as written.
- The flow doesn't change when the brain does.

[← The Model Is Just Another Step](./05-the-model-is-a-step.md) · [Watch It Run →](./07-watch-it-run.md)
