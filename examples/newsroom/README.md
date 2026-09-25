# newsroom

The vocabulary tour. A brief goes in, a signed-off article comes out, and
every primary primitive appears once, in its suggested role, visible in one
builder. This is a tour rather than a template: a real app needs the subset
its problem calls for ([docs/blueprint.md](../../docs/blueprint.md),
anti-pattern 8).

![terminal output of the newsroom example: the described flow tree, the suspension at the editor gate, and the signed-off article with its cost line](./screenshot.png)

The shape is three layers: model boundaries as leaves (`model_step`, plus one
`model_call` where the shell wants the usage envelope), named arms composed
from primitives (hardening, selection, verification), and a `chain` spine
that sequences the arms with `ctx.call`, declaring each as `arm` metadata so
`describe.diagram` draws the full tree below.

```text
chain
├─ inputs                                                        the corpus and the style guide
│  └─ parallel                                                   gather sources and style at once
│     ├─ corpus  branch                                          is the brief an update?
│     │  ├─ then  prior_corpus                                   the prior coverage, no fetching
│     │  └─ else  sequence                                       research, then widen the corpus
│     │     ├─ research                                          compose: fetch and summarize urls
│     │     │  └─ sequence                                       list the urls, then fetch each
│     │     │     ├─ urls                                        every source for a fresh brief
│     │     │     └─ map                                         each url, two in flight
│     │     │        └─ checkpoint                               cache keyed on research:<url>
│     │     │           └─ sequence                              fetch one page, then summarize it
│     │     │              ├─ fallback                           fall back to the archived copy
│     │     │              │  ├─ timeout                         give up after five seconds
│     │     │              │  │  └─ retry                        two tries at the live page
│     │     │              │  │     └─ fetch                     fetch the live page
│     │     │              │  └─ fetch_archive                   read the page from the archive
│     │     │              └─ pipe                               tag the summary with its source
│     │     │                 └─ summarize                       a model summarizes the page
│     │     └─ widen                                             loop: add sources, max 3 rounds
│     │        ├─ chain
│     │        │  ├─ more                                        a follow-up source if under three
│     │        │  └─ output                                      step
│     │        └─ guard  enough                                  stop at three sources
│     └─ style  style_guide                                      the house style guide
├─ stage  gathered
│  ├─ outline                                                    outline from the topic and sources
│  │  └─ outline                                                 a model picks angle and sections
│  ├─ article                                                    draft the article from the outline
│  │  └─ adversarial                                             compose: until ship, max 3 rounds
│  │     └─ loop
│  │        ├─ scope
│  │        │  ├─ stash
│  │        │  │  └─ snapshot                                    step
│  │        │  ├─ to_build_input                                 step
│  │        │  ├─ sequence                                       prompt, then draft both voices
│  │        │  │  ├─ draft_prompt                                add any critique to the prompt
│  │        │  │  └─ ensemble_step                               compose: keep the best-judged voice
│  │        │  │     └─ scope
│  │        │  │        ├─ stash
│  │        │  │        │  └─ parallel
│  │        │  │        │     ├─ formal  draft_formal            a model drafts in a formal voice
│  │        │  │        │     └─ breezy  draft_breezy            a model drafts in a breezy voice
│  │        │  │        ├─ ensemble_step_to_pairs                step
│  │        │  │        ├─ map
│  │        │  │        │  └─ scope
│  │        │  │        │     ├─ stash
│  │        │  │        │     │  └─ ensemble_step_item_snapshot  step
│  │        │  │        │     ├─ ensemble_step_extract_value     step
│  │        │  │        │     ├─ sequence                        judge the text of one draft
│  │        │  │        │     │  ├─ to_text                      just the draft's body
│  │        │  │        │     │  └─ style_judge                  a model scores the style
│  │        │  │        │     └─ use
│  │        │  │        └─ use
│  │        │  └─ use
│  │        └─ guard  scope
│  │           ├─ stash
│  │           │  └─ snapshot                                    step
│  │           ├─ extract_candidate                              step
│  │           ├─ sequence                                       critique the winning draft
│  │           │  ├─ critique_prompt                             hand the critic the body
│  │           │  └─ critique                                    a model says ship or revise
│  │           └─ use
│  ├─ verified                                                   fact-check the article body
│  │  └─ consensus                                               compose: all three ok, max 2 rounds
│  │     └─ loop
│  │        ├─ scope
│  │        │  ├─ stash
│  │        │  │  └─ snapshot                                    step
│  │        │  ├─ extract_input                                  step
│  │        │  ├─ parallel
│  │        │  │  ├─ first  check_1                              a model checks the claims
│  │        │  │  ├─ second  check_2                             a model checks the claims
│  │        │  │  └─ third  check_3                              a model checks the claims
│  │        │  └─ use
│  │        └─ guard  agree                                      step
│  └─ headline                                                   title plus usage for the cost line
│     └─ headline                                                a model_call, envelope and all
└─ stage  editorial
   ├─ signed                                                     resumed via run.until_suspended
   │  └─ editor_signoff                                          suspend: await editor sign-off
   └─ output                                                     step
```

The `gathered` stage narrows the record to the brief, corpus, and style, and
the chain's `output` step renders the article markdown with its cost line.

Some vocabulary is deliberately absent from the builder: `scope`/`stash`/`use`
(the low-level state primitives `chain` supersedes, which the tree shows only
as the plumbing inside `adversarial`, `ensemble_step`, and `consensus`),
`tournament` and plain `ensemble` (pick-best variants; see
[ensemble-judge](../ensemble-judge/)), and the self-improvement pair
`improve`/`learn` (see [improve](../improve/) and [learn](../learn/), where
`learn` runs over recorded trajectories, never in the request path).

The example runs keyless against a stub engine routed by system-prompt
prefix. The run suspends at the editor gate, and `main` resumes it with
canned approval.

## Run

```bash
pnpm exec tsx examples/newsroom/main.ts
```
