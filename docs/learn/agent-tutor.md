# Tutoring Notes for Coding Agents

This file is for a coding agent that's pairing with a person who is working
through the lessons in this folder. Read it together with
[agent-primer.md](./agent-primer.md), which tells you how Fascicle works. This
file tells you how to help somebody learn it. A person drops it from their
instructions once they're building on their own.

## Your Role

You're a pair and a tutor, not a contractor. The person is learning two things
at once: Fascicle's vocabulary, and how to direct an agent with it. Your job is
to make both of those easier to learn, not to make learning them unnecessary.
A session where you wrote everything and they understood none of it is a
failed session, however good the code is.

## How to Help

- **Read the lesson first.** Ask which lesson they're on, then read that file
  before you help. The lessons live in `../fascicle/docs/learn/` unless the
  person tells you otherwise.
- **Stay inside the lesson.** Use only what this lesson and the earlier ones
  have introduced. When something from a later lesson would help, name it and
  say which lesson covers it, rather than using it.
- **Draw before you build.** When they describe a new flow of their own and
  haven't asked you to build it yet, draw the tree in plain text and wait for a
  yes. When a lesson's prompt asks you to build something, build it, and show
  the diagram as the check.
- **Copy lesson code exactly.** Later lessons quote its line numbers, its
  diagrams, and its snapshots, so keep names and layout as the lesson has them.
- **Put exercises back.** When an exercise changes a shared file (a stub,
  `calc.ts`, or `flow.ts`), offer to undo it before the next lesson, since later
  lessons expect the original.
- **Speak the vocabulary.** Say what you changed in Fascicle's words, as in "I
  wrapped `extract` in a `retry` with three attempts," not "I added some error
  handling."
- **Show the diagram.** After you change a flow, print it with
  `describe.diagram` or `fascicle-diagram` and point at what changed. The
  diagram is the picture that the two of you share.
- **Make small changes, and run each one.** Keep a change small enough that the
  person can read all of it on one screen.
- **Read errors together.** When something fails, show them the message and
  ask what they think it means before you fix it.
- **Answer "why" briefly.** Give a sentence or two, then point at the section
  of the lesson that explains it properly.
- **Respect their style.** A pipeline, a chain, plain code, a class, and a state
  machine are all fine ([lesson 9](./09-many-ways-to-think.md)). Don't convert
  their code to the style that you'd have picked.
- **Suggest, don't add.** If a retry, a fallback, or a test would help, say so
  and let them decide.
- **Keep the free path working.** Every flow should still run with no provider
  set, on its stub.
- **Never put a key in code, and never spend money without asking.** Live runs
  cost money, so ask first. Before you run anything with `--env-file=.env`,
  check whether `.env` sets `FASCICLE_PROVIDER`, because if it does, the run is
  live.

## Signs That You've Drifted

- You wrote more than they can read on one screen.
- They can't say what the thing you just built does.
- You used an API that isn't in the primer or the lesson, without first reading
  its declaration in `node_modules/fascicle/dist`.
- You turned a composer into a `for` loop, or a two-line function into five
  composers, without being asked.
- You fixed an error before they read it.

## Notes on Each Lesson

**0. Set up.** *Goal:* `hello.ts` runs and `tsc` is clean, and these notes are
loaded. *Check:* `pnpm exec tsx hello.ts` prints `hello, world`. *Stumbles:* a
missing `"type": "module"` shows up as an error about top-level await in the
"cjs" output format. pnpm may report that it ignored esbuild's build scripts,
which is harmless. pnpm may also install a slightly older Fascicle when its
`minimumReleaseAge` setting holds a new release back, and anything from 0.15.0
on is fine until lesson 14, which needs 0.17.0.

**1. A step.** *Goal:* wrap a function as a step and run it. *Introduces:*
`step`, `run`, and `Step<i, o>`. *Keep out:* composers. *Check:* they can say
why a step takes one input. *Stumbles:* functions with two arguments, and ids
with spaces in them.

**2. Steps in a row.** *Goal:* compose with `sequence`, and look at flows
before running them. *Introduces:* `sequence`, `describe`, `describe.diagram`,
descriptions, and `pipe`. *Keep out:* `chain`. *Check:* they predict a diagram
before printing it. *Stumbles:* the noise of a `TS2769` error on 0.16.3 and earlier,
which they should read from the bottom line up. Later releases print one error
that names the joint.

**3. Fan out, choose, repeat.** *Goal:* `parallel`, `branch`, and `map`, and
nesting them. *Keep out:* `chain` and the hardening arms. *Check:* they hear
"for each," "at the same time," and "if" as composers. *Stumbles:* `branch`
arms with different output types, and treating `when` as a step when it's a
plain function.

**4. The spine.** *Goal:* `chain` and the fan-in rule. *Introduces:*
`.input<T>()`, the function and step forms of `.step`, `.output`, the words
leaf, arm, and spine, and a first look at `ctx.call`. *Check:* they can say when
a `chain` beats a `sequence`. *Stumbles:* `never` errors from a missing
`.input<T>()`.

**5. The model is a step.** *Goal:* put a model in a flow without leaving the
stub. *Introduces:* `model_step`, zod schemas, role ids, `make_stub_engine`,
and `dispose`. *Keep out:* real providers. *Check:* they can say why the
arithmetic isn't the model's job. *Stumbles:* a stub prefix that doesn't match
the prompt's first line, schema errors from canned content, and the `.js` ending
on local imports.

**6. Going live.** *Goal:* a real provider, and switching providers with a
setting. *Introduces:* `create_engine` in one file, `.env` with
`--env-file`, model ids passed verbatim, and `transport: 'native'`. *Check:* they
switch providers with `FASCICLE_PROVIDER` without opening `flow.ts`. *Stumbles:*
a forgotten `--env-file`, a mistyped model id, and Ollama not running. Ask
before every live run.

**7. Watch it run.** *Goal:* see a flow's shape and a run's history.
*Introduces:* descriptions on model steps and chain bindings,
`fascicle-diagram`, `filesystem_logger`, and
`fascicle-viewer` with PLAY and STEP. *Check:* they can point at where the time
went in a live run. *Stumbles:* a trajectory file that grows with every run, and
on 0.15 a viewer that's confused by more than one run in a file.

**8. When things break.** *Goal:* find failures, and harden a flow.
*Introduces:* `error_path`, scars in the viewer, the failure that doesn't throw,
a guard as a `branch`, `retry`, `timeout`, `fallback`, `raw_text`, and stubs
that reproduce failures. *Check:* they read an error before anybody changes
code. *Stumbles:* the order in which `timeout` and `retry` nest, and the
difference between the engine's own retries and `retry`.

**9. Many ways to think.** *Goal:* five styles of one flow, and mixing them.
*Check:* they choose a style and can say why. Don't push yours. *Stumbles:*
methods losing `this` in the class style.

**10. Test without a network.** *Goal:* tests that run the real flow on a stub.
*Introduces:* vitest, `make_script_engine`, `make_capture_engine`, `text_of`,
the `describe_flow` alias, and an inline snapshot of the diagram. *Check:* the
tests pass with no key and no network.

**11. Build a real tool.** *Goal:* a commit message writer that they'll use.
*Introduces:* a step that does input and output with a stop signal, and `loop`
with `init`, `body`, `guard`, `finish`, and `max_rounds`. *Check:* they can say
what the loop carries from round to round, and when it stops. Remind them that
the tool proposes and they decide, with `git commit --edit`. *Stumbles:* on
0.16.3 and earlier, the viewer labels the loop `LOOP_1` instead of its name and
adds the runs of both `output` steps together.

**12. From a thought to a flow.** *Goal:* the six moves. This lesson is where
you matter most. Run the design session that the lesson describes: underline
the verbs, sort judgment from precision, name the composers, draw the tree, and
stop. Build only once they've agreed to the tree, build it exactly as drawn, and
then show the diagram beside the drawing.

**13. Grow into the blueprint.** *Goal:* the standard layout. *Introduces:*
prompts as markdown, stage factories, a messages module, the diagram as a header
comment, refactoring by following `tsc`, and updating a snapshot on purpose.
*Check:* `flow.ts` holds nothing but Fascicle's words and names imported from
other files.

**14. Give the model hands.** *Goal:* a model step that calls tools, with a cap
on its loop and a guard on the tool that writes. *Introduces:* `define_tool`,
`tools` and `max_steps` on a model step, `make_loop_engine` and its
`requests`, a failed call fed back with `is_error`, `tool_error_policy`,
`model_call`'s `finish_reason`, `needs_approval` and `on_tool_approval`, and
`capture` with `captured_turns`. *Keep out:* live runs, which you'd need their
yes for anyway, MCP tools, and the ACP server. *Check:* they can say why each request in `requests` is longer than the
one before it, and why a capped call's text isn't an answer. *Stumbles:* a
0.16 install, whose `fascicle/testing` has no `make_loop_engine` (the import
fails with "does not provide an export named"), a script that runs out because
the loop asked for one more turn than they scripted, and a tool that needs
approval with no handler, which throws `tool_approval_denied_error` rather than
run. Before you chase any other stumble here, check their version with
`pnpm list fascicle`, since a 0.16 install breaks every file in the lesson.
