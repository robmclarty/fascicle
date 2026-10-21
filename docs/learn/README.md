# Learn Fascicle

A course in fourteen short lessons. It takes you from a function that adds two
numbers to designing and building real tools with Fascicle, with your coding
agent beside you the whole way. You don't need to know how Fascicle works
inside. You need a handful of ideas, a small vocabulary, and the habit of
drawing a flow before you build it, and that's what the course gives you.

## The One Idea

Everything in Fascicle is a `Step<i, o>`, something that takes an input of
type `i` and gives back an output of type `o`. A function that you wrap with
`step` is a step. A call to a model is a step. A sequence of steps is a step,
and so are a branch, a loop, a retry, and a whole agent with a dozen model calls
inside it.

Because everything has the same shape, anything can stand in for anything else
that takes the same input and gives the same output. You can swap a function for
a model, a stub for a real provider, or one provider for another, and the flow
around it doesn't change. Every lesson in this course is that one idea, seen
from another side.

## How the Course Works

- **You build as you go.** Lesson 0 sets up a small project of your own, called
  the workbench, and every lesson after it adds to that project.
- **Everything runs.** Every lesson ends with something that you run yourself,
  and all of the code was run against Fascicle 0.16.3 and 0.15.0 before it went
  into the lessons.
- **It's free until it isn't.** Lessons 0 to 5 need no API key and cost
  nothing. Lesson 6 connects a real model, and a run of the lesson code from
  then on costs a hundredth or two of a cent.
- **Your agent comes along.** Each lesson ends with prompts to try on your
  coding agent. Fascicle's vocabulary is how you tell an agent what to build,
  and its diagrams are how you check what the agent built.

## The Lessons

### Part 1: Steps and Shapes

No model, no key, just the pieces that everything else is built from.

| Lesson | After it, you can | Time |
| --- | --- | --- |
| [0. Set Up Your Workbench](./00-set-up.md) | run a TypeScript file, and give your agent its notes | 15 min |
| [1. A Step Is a Function with a Name](./01-a-step.md) | wrap a function as a step and run it | 10 min |
| [2. Steps in a Row](./02-steps-in-a-row.md) | compose steps with `sequence`, and see a flow with `describe` | 15 min |
| [3. Fan Out, Choose, Repeat](./03-fan-out-choose-repeat.md) | use `parallel`, `branch`, and `map`, nested any way you like | 20 min |
| [4. The Spine](./04-the-spine.md) | hold named state in a `chain`, and know when you need one | 20 min |

### Part 2: Models

A word problem solver, where a model reads and writes and code does the math.

| Lesson | After it, you can | Time |
| --- | --- | --- |
| [5. The Model Is Just Another Step](./05-the-model-is-a-step.md) | put a model in a flow, with a schema, and test it on a stub | 25 min |
| [6. Going Live](./06-going-live.md) | run on a real provider, and switch providers with one setting | 20 min |
| [7. Watch It Run](./07-watch-it-run.md) | draw any flow, record a run, and watch it in the viewer | 15 min |

### Part 3: Real Work

Breaking things, testing things, and a tool that you'll actually use.

| Lesson | After it, you can | Time |
| --- | --- | --- |
| [8. When Things Break](./08-when-things-break.md) | find where a flow failed, and harden it with `retry`, `timeout`, and `fallback` | 25 min |
| [9. Many Ways to Think](./09-many-ways-to-think.md) | write a flow as a pipeline, a chain, plain code, a class, or a state machine | 30 min |
| [10. Test without a Network](./10-test-without-a-network.md) | test a flow end to end, with no key and no network | 20 min |
| [11. Build a Real Tool](./11-build-a-real-tool.md) | build a commit message writer that drafts, checks, and redrafts | 45 min |

### Part 4: Thinking in Flows

How to turn an idea into a flow, and how a growing app is laid out.

| Lesson | After it, you can | Time |
| --- | --- | --- |
| [12. From a Thought to a Flow](./12-from-a-thought-to-a-flow.md) | design a flow from a paragraph, together with your agent | 45 min |
| [13. Grow into the Blueprint](./13-grow-into-the-blueprint.md) | lay out an app the way Fascicle's reference apps are laid out | 20 min |

If you only have one sitting, lessons 0 to 7 are the core of it. By the end of
lesson 7 you'll have built a flow with a model in it, moved it between
providers with one setting, and watched it run.

## For Your Agent

People and agents learn differently. You need the reasons, a story to hang
them on, and practice. Your agent needs exact signatures, the rules that bite,
and a checklist for its own work. The lessons are written for you, and two more
files are written for it:

- [agent-primer.md](./agent-primer.md) is the reference that an agent needs to
  build with Fascicle: the vocabulary with its exact shapes, the sharp edges
  with their real error messages, and a way to check its own work. It stays
  useful long after the course is over.
- [agent-tutor.md](./agent-tutor.md) asks your agent to teach rather than take
  over, and gives it notes on what each lesson is for.

[Lesson 0](./00-set-up.md) shows you how to hand both to Claude Code, and what
to do instead for an agent that doesn't follow Claude Code's imports.

## Teaching Someone Else

[teaching.md](./teaching.md) is for running a first session with someone new
to Fascicle. It has an agenda for one sitting, the moments worth aiming for, and
a friction log for writing down what got in the way, both for the person and
for their agent.

## If You Get Stuck

- [troubleshooting.md](../troubleshooting.md) maps Fascicle's errors to their
  causes.
- Hand your agent the error message and the run's `.trajectory.jsonl`, and ask
  it what happened before it changes anything.
- Bug reports and ideas are welcome as
  [issues on GitHub](https://github.com/robmclarty/fascicle/issues).
