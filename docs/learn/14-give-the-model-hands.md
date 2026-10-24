# Give the Model Hands

In every lesson so far, the model has only read and written text. Your code did
everything else, in an order that your flow fixed before it ran. A tool changes
that. You hand a model call a few of your own functions, and the model decides
which ones to call, and when, while it works out its answer. That's how your
coding agent reads your files and runs your tests. The model asks, and the
program around it does the work and hands back what happened.

In this lesson you'll give a model tools over a folder of notes, let one of them
fail, put a cap on how long the model can keep going, and make it ask before it
replaces anything. Then you'll read back exactly what the model was sent.

You still don't need a key. A stand-in plays the model again, but this one keeps
Fascicle's real tool loop, so your tools really run. It arrived in Fascicle
0.17.0, so check `pnpm list fascicle`, and if yours is older, run
`pnpm add fascicle@latest` first. About thirty minutes.

## A Tool Is a Function the Model Can Ask For

Make a `notes` folder in your workbench, and put one note in it,
`notes/shopping.md`:

```markdown
eggs
bread
```

A tool is a function with the three things that a model needs before it can
use one: a name, a description that says when to use it, and a schema for its
input. Create `hands/tools.ts` with two tools that read the notes:

```ts
// hands/tools.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { define_tool } from 'fascicle'
import { z } from 'zod'

// a note's name is a word, so a name like ../secrets never reaches a path
export const note_name = z.string().regex(/^[\w-]+$/)

export function note_path(name: string): string {
  return `notes/${name}.md`
}

export const list_notes = define_tool({
  name: 'list_notes',
  description: 'List the names of the notes.',
  input_schema: z.object({}),
  execute: () => readdirSync('notes').sort().map((file) => file.replace(/\.md$/, '')).join('\n'),
})

export const read_note = define_tool({
  name: 'read_note',
  description: 'Read one note, by its name.',
  input_schema: z.object({ name: note_name }),
  execute: ({ name }) => {
    if (!existsSync(note_path(name))) throw new Error(`no note called ${name}: call list_notes for the names`)
    return readFileSync(note_path(name), 'utf8')
  },
})
```

Here's what each piece is for:

- **`define_tool`** makes a tool. The model never sees your code. It sees the
  name, the description, and the schema, and from those three alone it decides
  whether to call the tool and what to pass it.
- **`input_schema`** is a zod schema, like `problem_schema` in
  [lesson 5](./05-the-model-is-a-step.md), and it does the same two jobs. The
  engine checks every call against it before `execute` runs, and `define_tool`
  reads the input's type from it, so `execute` gets a typed `{ name }`.
- **A note's name has to be a word.** `note_name` lets through letters,
  digits, `_`, and `-`, and nothing else, so a model that asks for
  `../secrets` is turned away before your code touches the disk. A tool runs on
  whatever a model wrote, so put its limits where the model can't argue with
  them.
- **What `execute` returns goes back to the model** as the tool's result, and a
  tool that can't do its job throws, with a message that says what to do
  instead. You'll see who reads that message in a moment.

Now hand the tools to a model step. Create `hands/helper.ts`:

```ts
// hands/helper.ts
import { model_step } from 'fascicle'
import type { Engine, Step } from 'fascicle'
import { list_notes, read_note } from './tools.js'

export const NOTES = `hands/notes
You look after a folder of notes. Read what you need with the tools before you
answer, and answer in one short sentence.`

export function build_helper(engine: Engine, model: string): Step<string, string> {
  return model_step({
    engine, model, system: NOTES, tools: [list_notes, read_note], max_steps: 6,
    id: 'helper',
  })
}
```

`tools` is the list that the model may call, and `max_steps` caps how many
model turns the call can take, which a later section comes back to. The rest is
the model step that you already know, with a role id on the prompt's first
line. It's still a `Step<string, string>`, so it drops into a flow wherever a
step does.

## Play the Model

The stand-in for this lesson is `make_loop_engine`, from `fascicle/testing`.
Unlike `make_stub_engine`, it doesn't replace the whole engine. It keeps the
real one, tool loop and all, and swaps only the model for a script that you
write. Each entry in the script is one of the model's turns, in order. An array
is the tool calls that the model makes on that turn, and a string is its final
answer. Create `hands/main.ts`:

```ts
// hands/main.ts
import { run } from 'fascicle'
import { make_loop_engine } from 'fascicle/testing'
import { build_helper } from './helper.js'

// you play the model: each entry is one of its turns, in order
const { engine, requests } = make_loop_engine([
  [{ name: 'list_notes', input: {} }],
  [{ name: 'read_note', input: { name: 'shopping' } }],
  'You need eggs and bread.',
])

try {
  console.log(await run(build_helper(engine, 'loop'), 'What do I need from the shop?'))
  for (const request of requests) console.log(request.messages.map((message) => message.role).join(', '))
} finally {
  await engine.dispose()
}
```

```bash
pnpm exec tsx hands/main.ts
```

```text
You need eggs and bread.
user
user, assistant, tool
user, assistant, tool, assistant, tool
```

The answer came from your script, but everything around it happened for real.
`requests` holds every request that the engine sent the model, and each line
under the answer is one of them, shown as the roles of its messages. Each
request is one model turn.

1. The first request held only your question, and the model's turn asked for
   `list_notes`.
2. The engine ran `list_notes`, then sent the whole conversation again, with
   the model's call (the `assistant` message) and the tool's result (the `tool`
   message) added at the end. The model's next turn asked for `read_note`.
3. The engine ran that one too and sent it all again. This time the model
   answered, and a turn without a call in it ends the loop.

That's the tool loop. Send the conversation, run the calls that come back,
append the calls and their results, and send it again, until the model answers
without a call. It's the trick behind every coding agent, and lesson 5's rule
still holds inside it, since the model remembers nothing between turns either.
Every turn sends the whole conversation, and
[What a Harness Does](../what-a-harness-does.md#the-loop) walks through what
that costs and how a prompt cache brings the price down.

## When a Tool Fails

Models guess. Ask the helper about a list by the wrong name, and it may try to
read a note that isn't there. Script that. Create `hands/missing.ts`:

```ts
// hands/missing.ts
import { run } from 'fascicle'
import { make_loop_engine } from 'fascicle/testing'
import { build_helper } from './helper.js'

// this time the model guesses a name before it looks
const { engine, requests } = make_loop_engine([
  [{ name: 'read_note', input: { name: 'groceries' } }],
  [{ name: 'list_notes', input: {} }],
  [{ name: 'read_note', input: { name: 'shopping' } }],
  'Your list is called shopping, and it says eggs and bread.',
])

try {
  console.log(await run(build_helper(engine, 'loop'), 'What is on my groceries list?'))
  console.log(requests[1]?.messages.at(-1))
} finally {
  await engine.dispose()
}
```

```bash
pnpm exec tsx hands/missing.ts
```

```text
Your list is called shopping, and it says eggs and bread.
{
  role: 'tool',
  tool_call_id: 'call_0_0',
  name: 'read_note',
  content: '{"error":"no note called groceries: call list_notes for the names"}',
  is_error: true
}
```

`read_note` threw, and the call didn't fail. The engine caught the error and
sent it back to the model as the tool's result, as `{"error": ...}` text with
`is_error: true`, which tells a provider that reads the flag, such as
Anthropic, that the call failed. On its next turn the model read the error,
took its advice, and called `list_notes`. That's why the error says what to do
next. Inside a tool, a model is the one reading your message, and a good one is
how it recovers. A call that fails the schema, names a tool that doesn't exist,
or gets turned down (two sections from now) goes back the same way.

Sending errors back is the default. When you'd rather a failed tool ended the
call, set `tool_error_policy: 'throw'` on the model step, and the call rejects
with a `tool_error` instead.

## A Cap on the Loop

A model can keep calling tools for as long as you let it, whether it's stuck,
a search keeps coming up short, or it just never decides that it's done.
`max_steps` caps its model turns, at 10 unless you set it. Here's a model that
never stops looking, under a cap of 2. Create `hands/capped.ts`:

```ts
// hands/capped.ts
import { model_call, run } from 'fascicle'
import { make_loop_engine } from 'fascicle/testing'
import { NOTES } from './helper.js'
import { list_notes } from './tools.js'

// a model that keeps looking and never answers
const { engine } = make_loop_engine([
  { text: 'Let me look.', tool_calls: [{ name: 'list_notes', input: {} }] },
  { text: 'Let me look again.', tool_calls: [{ name: 'list_notes', input: {} }] },
  { text: 'One more look.', tool_calls: [{ name: 'list_notes', input: {} }] },
])

const look = model_call({ engine, model: 'loop', system: NOTES, tools: [list_notes], max_steps: 2 })
try {
  const result = await run(look, 'What do I need from the shop?')
  console.log(result.finish_reason)
  console.log(result.content)
  for (const call of result.tool_calls) console.log(`${call.name}: ${call.error?.message ?? 'ran'}`)
} finally {
  await engine.dispose()
}
```

```bash
pnpm exec tsx hands/capped.ts
```

```text
max_steps
Let me look again.
list_notes: ran
list_notes: max_steps_exceeded_before_execution
```

The loop ran the first call, then stopped at its second model turn without
running the call that turn asked for, which is what
`max_steps_exceeded_before_execution` says. It didn't throw. It ended with
`finish_reason: 'max_steps'`, and its `content` is the last turn's text,
`Let me look again.`, which reads like an answer and isn't one. A model step
hands you only that text, so a capped helper would quietly answer "Let me look
again." That's why this file asks with `model_call`, the sibling that lesson 5
mentioned, whose envelope carries the `finish_reason` that says why the loop
stopped. When a cap matters to you, check it.

## Make It Ask First

Reading notes can't hurt anything. Writing them can. Put the tool that writes
in a file of its own, `hands/write.ts`:

```ts
// hands/write.ts
import { existsSync, writeFileSync } from 'node:fs'
import { define_tool } from 'fascicle'
import { z } from 'zod'
import { note_name, note_path } from './tools.js'

export const write_note = define_tool({
  name: 'write_note',
  description: 'Write a note, replacing any note of the same name.',
  input_schema: z.object({ name: note_name, text: z.string() }),
  // a new note goes ahead, and replacing one waits for a yes
  needs_approval: ({ name }) => existsSync(note_path(name)),
  execute: ({ name, text }) => {
    writeFileSync(note_path(name), text)
    return `saved ${name}`
  },
})
```

`needs_approval` holds a call until somebody says yes. It takes `true`, to ask
every time, or a function of the call's checked input, and this one asks only
when the write would replace a note that's already there. Ask only where it
counts, because a person who's asked about everything stops reading the
questions.

The yes or the no comes from an `on_tool_approval` handler that you hand the
model step. Update `hands/helper.ts` to add the tool and take a handler:

```ts
// hands/helper.ts
import { model_step } from 'fascicle'
import type { Engine, Step, ToolApprovalHandler } from 'fascicle'
import { list_notes, read_note } from './tools.js'
import { write_note } from './write.js'

export const NOTES = `hands/notes
You look after a folder of notes. Read what you need with the tools before you
answer, and answer in one short sentence.`

export function build_helper(engine: Engine, model: string, on_tool_approval?: ToolApprovalHandler): Step<string, string> {
  return model_step({
    engine, model, system: NOTES, tools: [list_notes, read_note, write_note], max_steps: 6,
    on_tool_approval, id: 'helper',
  })
}
```

Now a run where the model tries to replace your shopping list. A real app would
ask you at the terminal, which is where Another Way to Write It goes. Here the
handler decides in code, so nobody has to be at the keyboard. Create
`hands/approve.ts`:

```ts
// hands/approve.ts
import { run } from 'fascicle'
import type { ToolApprovalHandler } from 'fascicle'
import { make_loop_engine } from 'fascicle/testing'
import { build_helper } from './helper.js'

// a stand-in for asking a person, which says what it was asked and says no
const say_no: ToolApprovalHandler = ({ tool_name, input }) => {
  console.log(`asked to run ${tool_name} with ${JSON.stringify(input)}, and said no`)
  return false
}

const { engine, requests } = make_loop_engine([
  [{ name: 'write_note', input: { name: 'shopping', text: 'milk' } }],
  'I need your yes before I replace your shopping list.',
])

try {
  console.log(await run(build_helper(engine, 'loop', say_no), 'Replace my shopping list with milk.'))
  console.log(requests[1]?.messages.at(-1))
} finally {
  await engine.dispose()
}
```

```bash
pnpm exec tsx hands/approve.ts
```

```text
asked to run write_note with {"name":"shopping","text":"milk"}, and said no
I need your yes before I replace your shopping list.
{
  role: 'tool',
  tool_call_id: 'call_0_0',
  name: 'write_note',
  content: '{"error":"tool_approval_denied"}',
  is_error: true
}
```

The handler was asked and said no, so `write_note` never ran, and your shopping
list still says eggs and bread. The no went back to the model as a tool error,
the same way a failure does, and the model's next turn told you so. A call that
needs approval with no handler to ask throws rather than run, so a missing
handler fails closed. Anything short of a yes is a no.

## Read Back What the Model Saw

`requests` belongs to the loop engine, so it can't help you with a real
provider, which is where you'll want it most. The model ignored an instruction,
or called the wrong tool, and you need to know what it was actually sent. The
`capture` option records that into the trajectory, and `captured_turns` reads
it back. Create `hands/look_back.ts`, which has the missing-note conversation
again under `capture: 'turns'`:

```ts
// hands/look_back.ts
import { readFileSync } from 'node:fs'
import { captured_turns, model_step, run } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'
import { make_loop_engine } from 'fascicle/testing'
import { NOTES } from './helper.js'
import { list_notes, read_note } from './tools.js'

const { engine } = make_loop_engine([
  [{ name: 'read_note', input: { name: 'groceries' } }],
  [{ name: 'list_notes', input: {} }],
  [{ name: 'read_note', input: { name: 'shopping' } }],
  'Your list is called shopping, and it says eggs and bread.',
])

// capture: 'turns' records what each model turn sent, and what came back
const helper = model_step({
  engine, model: 'loop', system: NOTES, tools: [list_notes, read_note],
  capture: 'turns', id: 'helper',
})
try {
  await run(helper, 'What is on my groceries list?', {
    trajectory: filesystem_logger({ output_path: '.trajectory.jsonl' }),
  })
} finally {
  await engine.dispose()
}

const events = readFileSync('.trajectory.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const turns = captured_turns(events)
for (const turn of turns) console.log(`turn ${turn.step_index}: ${turn.messages.map((message) => message.role).join(', ')}`)
console.log(turns.at(-1)?.response)
```

```bash
rm -f .trajectory.jsonl
pnpm exec tsx hands/look_back.ts
```

```text
turn 0: system, user
turn 1: system, user, assistant, tool
turn 2: system, user, assistant, tool, assistant, tool
turn 3: system, user, assistant, tool, assistant, tool, assistant, tool
[
  {
    type: 'text',
    text: 'Your list is called shopping, and it says eggs and bread.'
  }
]
```

Each line is one captured model turn, read back from the file, with the whole
request that it sent. Every one starts with the system prompt, which `requests`
keeps apart from the messages, and the last turn's `response` is the reply that
came back. The trajectory stores each later turn as just the messages that it
added, rather than the whole conversation again, and `captured_turns` puts the
whole requests back together, so it works on a file that you read the next day.
`replay_turn` sends a captured turn again, with a change if you like, and the
viewer's turn inspector shows the same turns (see
[What a Harness Does](../what-a-harness-does.md#what-the-model-saw)).

Capture stays off until you turn it on, because a captured request holds
everything that your user typed and everything that a tool read. Your
`.gitignore` from [lesson 0](./00-set-up.md) already keeps `.trajectory.jsonl`
out of git, and a trajectory that captures belongs there.

## Another Way to Write It

`say_no` stands in for a person. When somebody's at the keyboard, ask them.
Create `hands/ask.ts`:

```ts
// hands/ask.ts
import { createInterface } from 'node:readline/promises'
import type { ToolApprovalHandler } from 'fascicle'

/** Ask the person at the terminal, and treat anything but a y as a no. */
export const ask_a_person: ToolApprovalHandler = async ({ tool_name, input }) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Run ${tool_name} with ${JSON.stringify(input)}? [y/N] `)
    return answer.trim().toLowerCase() === 'y'
  } finally {
    prompt.close()
  }
}
```

Then pass it to `build_helper(engine, model, ask_a_person)` in place of
`say_no`. Pressing Enter on its own counts as a no, so the safe answer is the
easy one.

## Where to Go Next

You know enough now to build real tools, and the rest of Fascicle's docs will
read differently than they would have this morning.

- [blueprint.md](../blueprint.md) is the full app architecture, with the
  reasons behind each rule.
- [leaf-arm-spine.md](../leaf-arm-spine.md) helps you choose the right
  primitive at each layer.
- [what-a-harness-does.md](../what-a-harness-does.md) explains what goes over
  the wire when a model runs, from one request to the guards on its tools.
- [cookbook.md](../cookbook.md) has worked patterns for retries, fan-out,
  judges, tool loops, and people in the loop.
- [testing.md](../testing.md) covers the four stand-in engines in depth.
- [troubleshooting.md](../troubleshooting.md) maps errors to their causes.
- [examples/release-notes/](../../examples/release-notes/) is a whole agent in
  one file, and [examples/pr-improve/](../../examples/pr-improve/) is the full
  layout at work.

## With Your Agent

> Read hands/tools.ts and hands/write.ts, and tell me the worst thing each tool
> could do if the model called it with the worst input that it could write, and
> what stops it.

A good answer names the word-only rule on every note's name, and the approval
on a write that would replace a note. If your agent says that the system prompt
stops the model, push back. A prompt is a request, and only code is a guard.

> Add a delete_note tool that always needs approval, give it to the helper, and
> script a run where the model tries it and say_no turns it down. Show me the
> run.

Check that its `needs_approval` is `true` rather than a function, that the note
is still there afterwards, and that the tool error reached the model.

## Try It

1. In `hands/approve.ts`, change the note's name in the script from `shopping`
   to `party`, and run it. Was the handler asked? Why not? Then delete
   `notes/party.md`.
2. Set `tool_error_policy: 'throw'` on the helper's model step and run
   `hands/missing.ts`. What comes back, and what never reaches the model? Take
   it out again when you're done.
3. In `hands/capped.ts`, raise `max_steps` to 3, and then to 4. Read what each
   run prints. Why does the second one fail, and what does its error tell you?

## Remember

- A tool is a name, a description, a schema, and a function, and the model
  decides when to call it.
- The tool loop sends the whole conversation on every model turn, until the
  model answers without a call or `max_steps` runs out.
- A failed call goes back to the model as an error that it reads, so write tool
  errors that say what to do next.
- A capped call ends with `finish_reason: 'max_steps'`, and its text isn't an
  answer.
- `needs_approval` holds a call for a yes, and anything short of a yes is a no.
- `capture` records what each model turn sent, and `captured_turns` reads it
  back.

That's the course. You started with a function that added two numbers, and
you've finished with a model-backed tool that you'll use tomorrow, a model that
can call your own code, a method for turning ideas into flows, and a shared
vocabulary with your agent. Go build something.

[← Grow into the Blueprint](./13-grow-into-the-blueprint.md) · [Back to the course map](./README.md)
