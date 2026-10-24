# Set Up Your Workbench

Before you write a flow you need somewhere to put it. This lesson sets up a
small project, your workbench, that every later lesson adds to. It also
introduces your coding agent to Fascicle, so the two of you share a vocabulary
from the first prompt. It takes about fifteen minutes.

## What You Need

- **Node 24 or newer.** Check with `node -v`.
- **pnpm.** npm works too, and the note at the end of this lesson says what to
  swap.
- **git.**
- **Claude Code**, or another coding agent that reads a `CLAUDE.md` or
  `AGENTS.md` file.

You don't need a model provider or an API key yet. Lessons 0 to 5 run entirely
on your machine, and [lesson 6](./06-going-live.md) is where you pick a
provider.

## Lay Out Two Folders

Make a folder for the course, and put two things in it: a clone of the
Fascicle repository, and your workbench.

```bash
mkdir learn-fascicle
cd learn-fascicle
git clone https://github.com/robmclarty/fascicle.git
mkdir workbench
cd workbench
```

The clone is reference material. It holds these lessons, the runnable
examples, and the notes your agent reads. You won't edit it. The workbench is
yours, and everything you build goes there.

## Make the Project

From inside `workbench`:

```bash
git init
pnpm init
pnpm add fascicle zod
pnpm add -D tsx typescript @types/node
```

`fascicle` is the library. `zod` describes the shape of the data that you want
a model to hand back, which starts to matter in [lesson 5](./05-the-model-is-a-step.md).
`tsx` runs a TypeScript file directly, and `typescript` checks your types
before you run anything.

Every lesson file uses top-level `await`, which works only in an ES module, so
your `package.json` needs `"type": "module"`. Recent versions of `pnpm init`
add it for you. Open the file and look, and if `type` is missing or says
`commonjs`, set it:

```bash
npm pkg set type=module
```

Now create `tsconfig.json`, which tells TypeScript how strict to be:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

And a `.gitignore`, so your keys and your run logs stay out of git:

```text
node_modules
.env
.trajectory.jsonl
```

## Introduce Your Agent

Fascicle is younger than most of what your agent learned from, so out of the
box it may not know the API, and it may guess. Two files in the clone fix that.
`agent-primer.md` gives it the vocabulary, the sharp edges, and a way to check
its own work, and `agent-tutor.md` asks it to teach you instead of doing
everything for you.

Create a `CLAUDE.md` in your workbench that pulls both in:

```markdown
# CLAUDE.md

This folder is my workbench for learning Fascicle, and you're my pair. The
lessons are in ../fascicle/docs/learn/, and I'll tell you which one I'm on.
Read that lesson before you help, and follow the tutoring notes below.

@../fascicle/docs/learn/agent-primer.md
@../fascicle/docs/learn/agent-tutor.md
```

The `@` lines are imports. Claude Code reads the two files as if you'd pasted
them in, and since they live outside your workbench, it asks you once before it
reads them. Say yes. Start Claude Code from inside `workbench` so it finds the
file.

If your agent isn't Claude Code and doesn't follow `@` imports, paste the two
files into its own instructions file instead, or ask it to read them at the
start of each session.

Releases after 0.16.3 ship the primer inside the package, too, so in a project
of your own that installs Fascicle, without the clone beside it, the import is
`@node_modules/fascicle/dist/AGENTS.md`. The tutoring notes are only in the
clone, since they're for the course.

## Say Hello

Create `hello.ts`:

```ts
// hello.ts
import { run, step } from 'fascicle'

const greet = step('greet', (name: string) => `hello, ${name}`)

console.log(await run(greet, 'world'))
```

Run it:

```bash
pnpm exec tsx hello.ts
```

```text
hello, world
```

Then check the types:

```bash
pnpm exec tsc --noEmit
```

No output means no errors. You'll use these two commands in every lesson, one
to run a file and one to check it, so it's worth getting them into your
fingers now.

Last, see which version of Fascicle you got:

```bash
pnpm list fascicle
```

Lessons 0 to 13 were written against 0.16.3 and checked against 0.15.0, and
lesson 14 needs 0.17.0, the release that adds the stand-in engine that it uses.
Where a later release changes what you'll see, the lesson says so. If your
pnpm is set to wait a day or two before it installs a brand-new release (its
`minimumReleaseAge` setting), you might be a release behind the newest, and
that's fine, as long as you have 0.17.0 by the time you reach lesson 14.

## If Something Went Wrong

| What you see | What it means |
| --- | --- |
| `Top-level await is currently not supported with the "cjs" output format` | `package.json` is missing `"type": "module"`. Run `npm pkg set type=module`. |
| A syntax error from somewhere inside `node_modules` | Your Node is older than 24. Upgrade it. |
| pnpm says it ignored build scripts for `esbuild` | pnpm being careful. `tsx` still works, so you can leave it. |
| Your agent doesn't seem to know about `CLAUDE.md` | Start it again from inside `workbench`. |

**Using npm instead of pnpm?** Swap `pnpm init` for `npm init -y`, `pnpm add`
for `npm install`, `pnpm add -D` for `npm install -D`, `pnpm exec` for `npx`,
`pnpm list` for `npm ls`, and `pnpm <script>` for `npm run <script>`.

## With Your Agent

Check that your agent read its notes. Ask it:

> In three sentences, what's a step in Fascicle, and how do I run one? Then
> run hello.ts for me.

A good answer says that a step is a named function with one input and one
output, that you make one with `step(id, fn)`, and that `run(step, input)`
runs it. If it describes some other library (classes, decorators, a `.pipe()`
method on everything), it hasn't read the primer, so tell it to read
`../fascicle/docs/learn/agent-primer.md` and ask again.

## Remember

- The clone is for reading, and the workbench is for building.
- `pnpm exec tsx <file>` runs a file, and `pnpm exec tsc --noEmit` checks it.
- Your agent learns Fascicle from the primer, so when it guesses, point it
  back there.

[A Step Is a Function with a Name →](./01-a-step.md)
