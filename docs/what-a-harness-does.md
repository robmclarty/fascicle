# What a Harness Does

A model takes text in and gives text back. It can't read a file, remember what you asked it yesterday, or run a command. When an agent seems to do those things, a program around the model did them, and that program is the harness. It builds each request, sends it, reads what comes back, runs the tools that the model asks for, and decides when to stop.

Fascicle is a library for writing that program. This page walks through what the program does, from the request on the wire up to the guards on its tools, in eight short sections. Each one ends with where Fascicle does that job for you, and what it leaves to you. The examples use Anthropic's Messages API and OpenAI's Chat Completions, since most other APIs copy one of the two, but none of the ideas belong to one provider. The words that the page leans on (model turn, tool loop, transcript, prompt cache) each have one meaning across the docs, which the [Glossary](./concepts.md#glossary) gives.

For the long version, read Isuru Wijesiri's [Harness Engineering 101](https://isuruwijesiri.com/harness-engineering-101/), a short book that grows a harness from a few dozen lines of chat loop into a coding agent, one fix at a time. This page covers some of the same ground in Fascicle's own terms, as a map of where each idea lives here.

## One Request, the Whole Conversation

A model API remembers nothing between requests. Every request carries the whole conversation as an array of messages, and the reply is one more message. To keep a conversation going, the program appends the reply to its array, appends the user's next message, and sends the whole array again.

Each message has a role and some content. The `user` role is what comes in from the person or the program, the `assistant` role is what the model said, and a system prompt sets the model up before the conversation starts (Anthropic takes it as a separate `system` field, and OpenAI as a message of its own). The content is either a plain string or a list of blocks, which is how one message carries an image, a tool call, a tool's result, or the model's reasoning beside its text.

Here's the second request of a short exchange, on Anthropic's Messages API. The first request held only the first message:

```json
{
  "model": "claude-sonnet-5-5",
  "max_tokens": 1024,
  "system": "Answer in one sentence.",
  "messages": [
    { "role": "user", "content": "What is the capital of Norway?" },
    { "role": "assistant", "content": "The capital of Norway is Oslo." },
    { "role": "user", "content": "How many people live there?" }
  ]
}
```

"There" means Oslo only because the second request carries the first exchange. Send the last message on its own and the model has no way to know where "there" is.

That's also what "the model forgot" means, nearly every time. The model has no memory to lose. When it seems to forget something, either the thing wasn't in the array that it got (the program dropped it, trimmed it, or never put it there) or it was there but buried under so much else that the model gave it little weight (see [The Window Is a Budget](#the-window-is-a-budget)). Either way, the question to ask is what the request held, and [What the Model Saw](#what-the-model-saw) is about how to answer it. A few APIs offer to keep the conversation on the server (OpenAI's Responses API does), but that only moves where the array lives. The earlier messages still count as input on every turn.

**In Fascicle**, every model call builds its array from what it's given (a system prompt and its input, which is a string or a `Message[]`) and sends it. Within one call, the [tool loop](#the-loop) keeps the array across turns for you. Between two model calls nothing carries over, so a flow carries context forward on purpose, by putting what the next call needs into its input. Here the reviewer gets the question again, because from the answer alone it couldn't tell whether the answer fits:

<!-- snippet: check -->
```ts
import { chain, create_engine, model_step } from 'fascicle';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env['ANTHROPIC_API_KEY'] ?? '' } },
  defaults: { model: 'claude-sonnet-5-5' },
});

const answerer = model_step({ engine, id: 'answerer', system: 'Answer in one sentence.' });
const reviewer = model_step({ engine, id: 'reviewer', system: 'Say whether the answer fits the question, and why.' });

export const flow = chain<string, 'question'>('question')
  .step('answer', answerer, ({ question }) => question)
  .step('review', reviewer, ({ question, answer }) => `Question: ${question}\nAnswer: ${answer}`)
  .output(({ answer, review }) => ({ answer, review }));
```

## Two Dialects, One Array

Anthropic's Messages API and OpenAI's Chat Completions say the same things in slightly different ways, and most other APIs, local servers included, copy one of the two. Here's the request from the last section in Chat Completions:

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "Answer in one sentence." },
    { "role": "user", "content": "What is the capital of Norway?" },
    { "role": "assistant", "content": "The capital of Norway is Oslo." },
    { "role": "user", "content": "How many people live there?" }
  ]
}
```

The plain exchange barely changes. The differences show up around the edges, and most of all in tool calls, which the next section takes apart:

| | Messages API (Anthropic) | Chat Completions (OpenAI) |
| --- | --- | --- |
| The system prompt | a top-level `system` field | a `system` (or `developer`) message, first in the array |
| A tool call | a `tool_use` block in the assistant's `content`, with its `input` as an object | an entry in the assistant message's `tool_calls`, with its `arguments` as a JSON string |
| A tool's result | a `tool_result` block in the next `user` message | a message of its own, with the role `tool` |
| Why the model stopped | `stop_reason`, such as `end_turn`, `tool_use`, or `max_tokens` | `finish_reason`, such as `stop`, `tool_calls`, or `length` |
| The output cap | `max_tokens`, which every request has to set | optional |

Once you can read one dialect, you can read the other.

**In Fascicle**, a conversation is an array of the neutral `Message` type. Its roles are `system`, `user`, `assistant`, and `tool`, and its parts cover text, images, tool calls, reasoning, and the blocks that only one provider reads, which it keeps as `opaque` parts and sends back unchanged. Each provider's adapter writes that array in its own dialect on the way out and reads the reply back into it, so the flow itself doesn't change when the provider does. Where a provider has a `transport` setting, it picks who writes the body: a `'native'` adapter builds it over `fetch`, and the `ai_sdk` transport hands the array to the provider's AI SDK package, which builds it. See [providers.md](./providers.md#three-integration-depths) for the three integration depths, the third of which hands the whole loop to another agent.

## A Tool Call Is Three Pieces of JSON

A model can't run anything. What it can do is write a piece of JSON that asks the program to run something, and a tool call is no more than that. It takes three pieces:

1. **The tool's definition, in the request.** A name, a description that tells the model when to use the tool, and a JSON Schema for its input. The model reads them the way it reads the rest of the prompt.
2. **The call, in the reply.** A block that names the tool, gives it an input, and carries an id. The reply's stop reason says that the model is waiting on a result.
3. **The result, in the next request.** A block that carries the same id and the tool's output as text, which the program appends before it sends the array again.

On the Messages API, the definition sits in the request's `tools`:

```json
{
  "name": "get_weather",
  "description": "Look up the weather for a city.",
  "input_schema": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"]
  }
}
```

The reply carries the call, and the next request carries the result back in a `user` message, matched to the call by its id:

```json
[
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "I'll check." },
      { "type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": { "city": "Oslo" } }
    ]
  },
  {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_01", "content": "sunny, 14 degrees" }
    ]
  }
]
```

Three things follow from that shape. The program decides whether a call runs at all, since all the model did was ask. The input is the model's best attempt at the schema rather than a promise (unless you turn on a provider's strict mode, where it has one), so the program checks it before it runs anything. And a result that reports a failure should say so. Anthropic's `tool_result` takes `is_error: true` for that, so the model reads "no such file" as a failure to work around rather than as what the file holds. When a reply makes several calls, all of their results go back together in the next message.

**In Fascicle**, a `Tool` is a `name`, a `description`, an `input_schema` (any Standard Schema that can produce a JSON Schema, such as a zod object), and an `execute` function. `define_tool` reads the input's type from the schema, so `execute` gets typed input:

<!-- snippet: check -->
```ts
import { define_tool } from 'fascicle';
import { z } from 'zod';

export const get_weather = define_tool({
  name: 'get_weather',
  description: 'Look up the weather for a city.',
  input_schema: z.object({ city: z.string() }),
  execute: ({ city }) => `sunny in ${city}`,
});
```

The engine sends the schema as JSON Schema, checks every call against it before `execute` runs, and appends each result as a `role: 'tool'` message. A call that fails (an unknown tool, input that fails the schema, a denied approval, or an `execute` that throws) goes back as `{"error": "…"}` content with `is_error: true`, which both Anthropic transports send as the flag. See [api-reference.md](./api-reference.md#typed-tools-with-define_tool) for the rest.

## The Loop

One tool call is seldom enough. A model that's asked to fix a failing test reads the test, reads the code, makes an edit, and runs the test again, and each of those is a call whose result decides the next one. So the harness runs a loop:

```text
send the array, with the tools
while the reply asks for tools:
  append the reply
  run each call, and append its result
  send the array again
return the reply
```

Each pass is one model turn, and the reply's stop reason says which way to go. A model that wants a tool stops with `tool_use` (or `tool_calls`), and the loop goes round again. A model that's done stops with `end_turn` (or `stop`), and the loop returns its text. A reply that hit the output cap stops with `max_tokens` (or `length`), partway through a sentence or a call, and that's not an answer, whatever it looks like.

Two more rules make the loop safe to leave running. It needs a cap on its turns, because a model can keep calling tools for as long as you let it, whether a tool keeps failing or a search keeps coming up short. And an error goes back as input rather than ending the loop. A tool that throws becomes a result that says what went wrong, and the model reads it on its next turn and usually corrects course, by fixing its input, trying another tool, or saying that it's stuck. That's most of what makes an agent seem resourceful.

**In Fascicle**, every model call that has `tools` runs this loop for you, and `max_steps` caps its model turns, at 10 unless you set it. A call that reaches the cap resolves with `finish_reason: 'max_steps'` rather than throwing. `tool_error_policy` says what a failed call does. `'feed_back'`, the default, sends it back to the model as a tool error, and `'throw'` ends the call with a `tool_error`. A tool flagged `ends_turn: true` ends the loop as soon as a call to it succeeds, with no extra model turn, which suits a `finish` tool. The calls in one turn run one at a time, in the order that the model made them.

You can watch the loop work with no key. `make_loop_engine` from `fascicle/testing` keeps the real engine and its loop, swaps the model for a script, and records every request that the loop sent:

<!-- snippet: check -->
```ts
import { define_tool, model_step, run } from 'fascicle';
import { make_loop_engine } from 'fascicle/testing';
import { z } from 'zod';

const get_weather = define_tool({
  name: 'get_weather',
  description: 'Look up the weather for a city.',
  input_schema: z.object({ city: z.string() }),
  execute: ({ city }) => `sunny in ${city}`,
});

const { engine, requests } = make_loop_engine([
  [{ name: 'get_weather', input: { city: 'Oslo' } }],
  'It is sunny in Oslo.',
]);

const ask = model_step({ engine, tools: [get_weather], max_steps: 4 });

console.log(await run(ask, 'What is the weather in Oslo?'));
// It is sunny in Oslo.

for (const request of requests) console.log(request.messages.map((m) => m.role).join(', '));
// user
// user, assistant, tool
```

The second request sends the first one's message again, with the model's call and the tool's result after it. That's the whole conversation going over the wire on every turn, which is what the next section puts a price on.

## What a Turn Costs

You pay for every input token on every turn, and every turn sends the whole conversation again. Suppose a loop starts with 5,000 tokens of system prompt, tools, and question, and each turn adds about 1,000 more. Its first turn sends 5,000 tokens, and its twentieth sends 24,000. Over the twenty turns it sends 290,000 tokens of input, about twelve times the size of its last request, because what each turn costs grows with the conversation, and so the total grows with its square. Double the turns and the input bill more than triples.

A prompt cache is what makes a long loop affordable. A provider that caches keeps the part of a request that it has already processed for a few minutes, and a later request that starts with exactly the same tokens reads that part back at a fraction of the input price. On Anthropic, a read costs a tenth of the input price or less, depending on the model, while a write costs more than plain input (1.25 times the input price for a five-minute entry, and twice for an hour). With the cache on, each turn of that loop pays the write price for what it added and the read price for everything before it. At a read price of a tenth, the input for those twenty turns costs as much as about 57,000 tokens at the plain input price rather than 290,000, or about a fifth, and less again on a model whose reads cost less.

The catch is in "exactly the same tokens." A cache matches a request by its prefix, in the order that the wire sends it (the tools, then the system prompt, then the messages), so it pays only while the top of the array stays the same and the loop only appends. A system prompt that carries the current time, a tool list that's rebuilt in another order, or an earlier message that's rewritten pays full price again from the change on. And an entry that nothing reads expires, so a loop that waits on a slow tool or a person can come back to a cold cache.

**In Fascicle**, every result carries `usage`, with cache reads and cache writes split out where the provider reports them, and `cost` when the engine has a price for the model. The `cache` option asks for a prompt cache, as `'5m'` or `'1h'`, or turns it off with `'off'`. Left unset, Anthropic caches for five minutes on any call that has tools, on either transport, since that's where the reads pay for the writes. OpenAI and Gemini cache long prompts on their own, OpenRouter's native transport caches when you ask, and a provider that can't honor a setting that you asked for records `option_ignored`.

Each turn's `response_received` event carries `cache_hit_ratio`, the share of its input that came back from the cache, and a `cache_miss` event marks a turn that found nothing where the turn before it had left something. In a test, `assert_prefix_stable` fails a loop that rewrites its prefix. See [providers.md](./providers.md#prompt-caching) for what each provider does and what causes a miss.

## The Window Is a Budget

A model's context window is the most that it can read in one request, counted in tokens, and its reply comes out of the same budget. Every turn of a loop spends more of it. A loop that runs long enough fills the window and its next request fails, but the trouble starts well before that. A model reads a long context less reliably than a short one, so a fact that's buried under 100,000 tokens of tool output is easier to miss than the same fact in a short request. That decline goes by the name context rot. A model that "forgot" an instruction from early in a long session often still had it, and missed it.

The reply has a cap of its own, which the request sets (`max_tokens` on Anthropic). A reply that reaches it stops where it is, mid-sentence or mid-call.

Three habits keep a loop inside its budget:

- **Spend less at the source.** Tool results are usually the biggest cost, such as a whole file or a long log. A tool that cuts its own output to a sensible size, and says that it did and how to get the rest, saves every later turn from paying for it again.
- **Compact seldom, in big jumps.** When the window is nearly full, replace the older part of the conversation with a summary, once, and go back to appending. Every compaction rewrites the prefix and costs a cache miss, so a loop that trims a little on every turn (a sliding window that drops the oldest message) pays for an uncached prefix on every turn.
- **Keep what has to last outside the array.** A plan, a list of findings, or notes on the work can live in a file or a store that a tool reads back, so a compaction that drops the conversation doesn't drop them too.

**In Fascicle**, `prepare_step` is a hook that runs before each model turn and can replace what that turn sends, while the transcript that the loop keeps stays whole. A hook that maps each message on its own, so that the same message always comes out the same way, keeps the prefix stable and the cache warm. This one cuts any tool result over 4,000 characters and keeps the rest of the message, `is_error` included:

<!-- snippet: check -->
```ts
import type { Message, PrepareStepHook } from 'fascicle';

const LIMIT = 4_000;

const clip = (message: Message): Message =>
  message.role === 'tool' && message.content.length > LIMIT
    ? { ...message, content: `${message.content.slice(0, LIMIT)}\n[cut ${message.content.length - LIMIT} characters]` }
    : message;

export const clip_tool_results: PrepareStepHook = ({ messages }) => ({ messages: messages.map(clip) });
```

Pass it to a model call as `prepare_step: clip_tool_results`. A hook that drops old messages instead changes the prefix on every turn once it starts, and the trajectory shows it as `cache_miss` events that carry `after_prepare_step: true`. `max_tokens` sets the reply's cap, and a reply that reaches it ends with `finish_reason: 'length'`. See [configuration.md](./configuration.md#reshaping-each-turn-prepare_step) for the hook's rules.

## What the Model Saw

When a model does something strange (ignores an instruction, calls the wrong tool, answers a question that nobody asked), the first question is what it was sent. Your code can't tell you, because your code shows what you meant to send. The request shows what went: the system prompt after its template filled in, the conversation after every earlier turn and every hook had their way with it, and the tools in the order they went. The only reliable way to know is to record the request.

Once you have it, two things get easy. You can read it, which settles most questions on its own. And you can send it again, as it was or with one thing changed, to see whether a reworded instruction fixes the problem against the exact input that went wrong, without running the whole flow to get back there. That's a replay. Send it a few times before you trust what comes back, since the same request doesn't always get the same reply.

Recording should be off by default, and for a good reason. A request holds everything your user typed and everything a tool read, so a recorded request belongs only where that data is allowed to go.

**In Fascicle**, the `capture` option records each model turn's request and reply into the trajectory. `'turns'` puts the request on the turn's `request_sent` event (the first turn whole, and each later turn as the messages that it added) and the reply on `response_received`, and `'wire'` adds the exact body that each attempt sent on a native transport. An engine's `redact_capture` sees each payload first and can scrub or drop it. `captured_turns(events)` rebuilds the whole request of every captured turn from a trajectory, even one that you read back from a file:

<!-- snippet: check -->
```ts
import { readFileSync } from 'node:fs';
import { captured_turns, define_tool, model_step, run } from 'fascicle';
import { filesystem_logger } from 'fascicle/adapters';
import { make_loop_engine } from 'fascicle/testing';
import { z } from 'zod';

const get_weather = define_tool({
  name: 'get_weather',
  description: 'Look up the weather for a city.',
  input_schema: z.object({ city: z.string() }),
  execute: ({ city }) => `sunny in ${city}`,
});

const { engine } = make_loop_engine([
  [{ name: 'get_weather', input: { city: 'Oslo' } }],
  'It is sunny in Oslo.',
]);

const ask = model_step({ engine, tools: [get_weather], capture: 'turns' });
const trajectory = filesystem_logger({ output_path: 'weather.trajectory.jsonl' });
await run(ask, 'What is the weather in Oslo?', { trajectory });

const lines = readFileSync('weather.trajectory.jsonl', 'utf8').trim().split('\n');
const last = captured_turns(lines.map((line) => JSON.parse(line))).at(-1);
console.log(last?.messages.map((m) => m.role).join(', '));
// user, assistant, tool
```

`replay_turn(engine, last, { edit })` then sends that turn again, as a single turn that can't run a tool, with `edit` to change it on the way. The viewer's turn inspector shows a captured turn's request beside its reply. See [concepts.md](./concepts.md#what-gets-recorded) for what each event holds, [api-reference.md](./api-reference.md#rebuilding-and-replaying-a-captured-turn) for the replay, and [viewer.md](./viewer.md#turn-inspector) for the inspector.

## Guarding the Hands

Once a model has tools that act on the world (write a file, run a command, send a message, spend money), the harness is all that stands between what the model asks for and what happens. A system prompt that says "never delete anything" is a request to the model, and models don't always do what they're asked. A guard is code that holds whatever the model writes.

Guards come in layers, with the strongest first, since each one leaves less for the next to catch:

1. **Don't give it the tool.** A model can't call a tool that isn't in its request. Give each model call the tools that its job needs and no more, so a step that reviews code gets tools that read and none that write.
2. **Make the tool narrow.** A `run_tests` tool is safer than a `run_command` tool, and a delete that takes a file name is safer than one that takes any path. Put the limit in the schema and in the code that runs the tool, where the model can't argue with it.
3. **Ask a person.** Hold the calls that matter for a yes, and treat anything short of a clear yes as a no. Ask only where it counts, though, because a person who's asked about everything stops reading the questions.
4. **Contain the damage.** Run the agent where a mistake is cheap to undo, such as a container, a throwaway worktree, or an account whose credentials reach only what the job needs. This is the layer that holds when the others miss.

One gap is worth knowing about. A server-side tool (a web search that the provider runs inside the request, say) never passes through your loop, so no guard of yours sees it.

**In Fascicle**, the first two layers are how you write your tools (the `tools` you hand each model call, a tight `input_schema`, and checks in `execute`), and the engine checks every call against its schema before anything runs. For the third, flag a tool with `needs_approval` (`true`, or a function of the call's checked input) and give the call an `on_tool_approval` handler. A flagged tool with no handler throws, so a missing handler fails closed, and a denied call goes back to the model as a tool error under the default `tool_error_policy`:

<!-- snippet: check -->
```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { create_engine, define_tool, model_step } from 'fascicle';
import { z } from 'zod';

const engine = create_engine({
  providers: { anthropic: { api_key: process.env['ANTHROPIC_API_KEY'] ?? '' } },
  defaults: { model: 'claude-sonnet-5-5' },
});

const delete_scratch_file = define_tool({
  name: 'delete_scratch_file',
  description: 'Delete one text file from the scratch directory.',
  input_schema: z.object({ name: z.string().regex(/^[\w-]+\.txt$/) }),
  needs_approval: true,
  execute: async ({ name }) => {
    await rm(join('scratch', name));
    return `deleted ${name}`;
  },
});

const ask_a_person = async (question: string): Promise<boolean> => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`${question} [y/N] `)).trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
};

export const tidy = model_step({
  engine,
  system: 'You tidy the scratch directory.',
  tools: [delete_scratch_file],
  on_tool_approval: ({ tool_name, input }) => ask_a_person(`${tool_name} ${JSON.stringify(input)}?`),
});
```

The schema keeps a name like `../notes.txt` from ever reaching `execute`, and the approval makes a name that passes wait for a yes.

Over ACP, `serve_acp`'s modes set how often a coding session asks. Manual asks before every edit and every command, Accept edits asks only before commands, and Auto never asks, so an agent that runs on your own machine rather than in a container leaves Auto out, with `modes: ['manual', 'accept_edits']`. Its workspace tools also keep every path inside the session's directories and out of `.git` and `node_modules`. The fourth layer is yours, since Fascicle runs wherever you run it. See [human-in-the-loop.md](./human-in-the-loop.md#synchronous-tool-approval) for approval and [acp.md](./acp.md#modes) for the modes.
