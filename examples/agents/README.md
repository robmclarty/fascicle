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
