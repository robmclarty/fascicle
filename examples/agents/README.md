# agents

The reference agents. Each one is a markdown prompt plus a zod schema folded
through `define_agent`: the prompt carries the role and the output contract
in frontmatter, the schema types the result, and the factory turns both into
a callable agent. They are demo code rather than part of the published
package. The examples that consume them ([reviewer](../reviewer/),
[documenter](../documenter/), [researcher](../researcher/),
[learn-reviewer](../learn-reviewer/), and [bench-reviewer](../bench-reviewer/))
import them relatively; copy the agent directory alongside whichever example
you port into your own project.

| Agent | What it does |
| --- | --- |
| [reviewer/](./reviewer/) | reviews a unified diff and returns a summary plus severity-tagged findings |
| [documenter/](./documenter/) | documents a file or symbol target in a requested style |
| [researcher/](./researcher/) | iterates over injected `search` / `fetch` and synthesizes a cited brief |

## Flow

The researcher's dispatcher builds its round loop at run time from `depth`,
so that loop draws as the last tree.

```text
reviewer  one model call: a diff in, a schema-checked review out

documenter  one model call: a file or symbol in, a schema-checked doc out

researcher                compose: a cited brief from injected search and fetch
└─ researcher_dispatcher  build the round loop for the depth, then call it

loop                         1, 3, or 5 rounds for shallow, standard, or deep
├─ researcher_round          injected search, then fetch the top 2 to 4 new hits
│  └─ researcher_summarizer  the model call: notes, brief, sources, next query
└─ guard  researcher_guard   stop on has_enough or when no new hits turn up
```
