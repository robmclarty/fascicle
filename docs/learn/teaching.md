# Teaching a First Session

This guide is for whoever is introducing Fascicle to somebody new, whether
that's a teammate, a new hire, or a friend. It plans one sitting of about three
hours.
The aim of a first session isn't coverage. It's that by the end, the learner has
felt Fascicle work. They've built a flow, seen it as a picture, put a model
inside it, moved it between providers with one setting, and watched it run,
with their own agent alongside them the whole time. Everything after that is
practice, and they can do practice on their own.

## Before the Session

Send the learner this checklist a day ahead, so the session starts with
building rather than installing:

- Node 24 or newer, pnpm, and git.
- Claude Code (or the coding agent they use), installed and signed in.
- An [OpenRouter](https://openrouter.ai) account with a few dollars of credit
  and an API key. If they'd rather spend nothing, they can install Ollama and
  pull `qwen3:4b-instruct-2507-q4_K_M` instead, and expect slower answers.
- [Lesson 0](./00-set-up.md), done: a workbench where `hello.ts` runs, and a
  `CLAUDE.md` that imports the agent notes.

And for yourself, work through lessons 0 to 8 once in a scratch workbench, on
the same provider the learner will use, so nothing surprises you in front of
them.

## What Success Looks Like

By the end of the session, the learner has done all of these:

1. Run a flow that they wrote, after printing its diagram.
2. Swapped a plain step for a model step, on a stub, without changing the flow
   around it.
3. Run that flow live, then moved it to another model or provider by changing a
   setting.
4. Watched a run in the viewer, and said where the time went.
5. Told their agent what to build in Fascicle's vocabulary at least three
   times, and checked each result against a diagram.
6. Written down, or watched you write down, where they got stuck.

## An Agenda

| Time | Lessons | The moment to aim for |
| --- | --- | --- |
| 0:00 | Why, in ten minutes, with no slides | the one idea, that everything is a `Step` |
| 0:10 | 1 and 2 | `describe` prints the tree before anything runs |
| 0:40 | 3 and 4 | the learner says "for each" and "at the same time," the agent builds it, and the diagram agrees |
| 1:20 | a break | |
| 1:30 | 5 | the fake step becomes a model step, and the chain doesn't change |
| 2:00 | 6 | one setting moves the same flow to another company's model |
| 2:20 | 7 | the viewer, watching a live run, and seeing where the time went |
| 2:40 | 8, or a free build | breaking things on purpose, or sketching a small tool of their own and building it with the agent |
| 2:55 | the wrap-up | reading the friction log together |

Run long on the early lessons if you need to. Lessons 1 to 4 are where the
vocabulary forms, and a learner who has it can pick up lessons 8 to 14 on their
own.

## How to Run It

- **Let the learner drive.** Keep your hands off their keyboard. Ask questions
  instead of giving answers, as in "what do you think the diagram will show?"
- **Name the idea after they've seen it work.** "That's fan-in, and it's why
  you needed a chain" lands better after the bucket brigade has annoyed them.
- **Use the diagram as the shared picture.** When the two of you disagree about
  what a flow does, print it.
- **Resist the internals.** The learner needs the main threads, and how the
  engine schedules its retries isn't one of them. Point at the docs, and say
  it's there when they want it.
- **Treat agent mistakes as material.** When the agent gets something wrong,
  that's a chance to show the learner how to correct an agent, which is half of
  what they came to learn.
- **Write down every stumble.** The friction log below turns them into
  something useful.

## Moments That Land

A few moments in the course reliably make a learner sit up. It's worth setting
each one up on purpose.

1. **The tree before the run** (lesson 2). Before they print the diagram, ask
   them to draw it on paper. Then print it.
2. **The swap** (lesson 5). Before the swap, have them run `git add solver` so
   that `git diff` can show the change afterward. The imports, the signature,
   and the two `const` lines change, two prompts appear, and the chain doesn't
   change by a single character.
3. **One setting** (lesson 6). Run the same question on two providers, one right
   after the other, with only `FASCICLE_PROVIDER` or `FASCICLE_MODEL` changed.
4. **The light** (lesson 7). Run live, open the viewer, and press PLAY.
5. **The quiet failure** (lesson 8). Ask the live solver "What is the capital of
   France?" and read the answer together before you say anything. Then add the
   guard.
6. **The vocabulary** (any lesson). The learner asks for "for each pair, both at
   once, two at a time," the agent builds exactly that, and the diagram proves
   it.

## When the Agent Goes Wrong

| What you see | What to try |
| --- | --- |
| It invents an API or an option | Ask it to find the declaration in `node_modules/fascicle/dist/*.d.ts`, then try again. |
| It writes a `for` loop or `Promise.all` when a composer was asked for | Ask for the diagram, then ask for the composer by name. |
| It turns simple code into a pile of composers | Ask "could this be one step?" and point at lesson 3. |
| It edits the flow to change providers | Point it at lesson 6, where the engine is chosen by settings. |
| It writes a lot of code at once | Ask for one change at a time, with the diagram after each. |
| It puts a key in a source file | Stop, move the key to `.env`, and check that it never reached git. |

## The Friction Log

Every time something gets in the way, write a row. Both the learner and their
agent stumble, and the two kinds of stumble are different, so keep track of
which one it was. A person stumbles on concepts and setup, and an agent
stumbles on missing or wrong information. Both are worth fixing, and they're
fixed in different places. The two rows below are examples of the shape, so
replace them with your own.

| When | Lesson | Who | What they tried | What they expected | What happened | Minutes lost | Fix idea |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0:52 | 4 | person | ran a chain without `.input<Pair>()` | it to work | errors about `never` | 4 | say why in the lesson's first example |
| 1:41 | 5 | agent | gave a stub content function untyped parameters | it to compile | implicit `any` errors from `tsc` | 2 | already in the primer, and it read past it |

Keep a short second list as well, of the moments that landed, the times the
learner said "oh." Those are worth protecting when the docs change.

After the session, sort the log by minutes lost. Turn the top few into
[issues on GitHub](https://github.com/robmclarty/fascicle/issues), with the exact
error text and the lesson number. For the rows where the agent stumbled, note
what [the primer](./agent-primer.md) should have said, because that's usually
the fix.

## Friction Already Known

These came up while the course was being checked, so watch for them and warn
the learner when they're close:

- **pnpm can hold back a new release.** A `minimumReleaseAge` setting makes
  pnpm wait a day or two before it installs a brand-new version. The lessons
  work on 0.15.0 and later, so it doesn't matter, but it can confuse someone
  who just read the release notes.
- **Up to 0.16.3, a wrongly ordered `sequence` gives a noisy error.** It's
  `No overload matches this call`, twice. Teach the habit of reading from the
  last line up. Later releases print it once, on the step that doesn't fit.
- **A chain needs its input type.** Without it, the errors talk about `never`
  up to 0.16.3, and later releases say to call `.input<T>()`.
- **Up to 0.16.3, `branch` arms must return the same type.** Later releases
  return the union of the two.
- **Up to 0.16.3, a model step in a `parallel` needs its type annotated** as
  `Step<string, T>`, or the input type becomes odd.
- **Prompts must show the JSON shape, up to 0.16.3.** On those versions the
  native transport never shows the model the schema, so a prompt without an
  example costs an extra round trip, and a small local model may fail outright.
- **Up to 0.16.3, a stub's `content` function needs typed parameters.**
- **Vitest and Fascicle both export `describe`.**
- **The viewer on 0.15** gets confused by a trajectory file that holds more than
  one run, so delete the file between runs there.
- **Up to 0.16.3, the viewer labels a loop by its id**, as `LOOP_1`, and adds
  together the runs of steps that share an id, so in lesson 11 both `output`
  steps show the total of the two.
- **Up to 0.16.3, `adversarial` draws its scopes and stashes**, which is why
  lesson 11 builds its loop with `loop`.
- **Up to 0.16.3, the viewer labels a loop's guard `loop_1_guard`**, an id
  that Fascicle makes up for a plain function, so say what it is before the
  learner asks. Later releases label it `guard`.
